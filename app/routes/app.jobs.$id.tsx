import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { Prisma } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  JobError,
  abandonJob,
  advanceJob,
  applyJob,
  createRollbackJob,
  discardJob,
  jobSpec,
  refreshJob,
} from "../services/jobs.server";
import { describeChanges } from "../lib/diff";
import { describeOperations } from "../lib/operations";
import type { ProductState } from "../lib/types";
import {
  ChangeList,
  JobStatusBadge,
  ProgressBar,
  SOURCE_LABELS,
  formatDuration,
} from "../components/JobUi";

const PAGE_SIZE = 25;
const STALE_MINUTES = 30;
const PHASE_LABELS: Record<string, string> = {
  PRODUCTS: "Updating product details",
  VARIANTS: "Updating prices",
  COLLECTIONS: "Updating collections",
  DONE: "Finishing up",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const where = { id: params.id!, shop: session.shop };

  let job = await db.bulkJob.findFirst({ where });
  if (!job) throw new Response("Not found", { status: 404 });

  // Polling the page is what moves the job along (the webhook does too).
  if (job.status === "SNAPSHOTTING" || job.status === "APPLYING") {
    await advanceJob(admin, job.id);
    job = await db.bulkJob.findFirstOrThrow({ where });
  }

  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const show = url.searchParams.get("show") === "failed" ? "failed" : "all";
  const itemWhere: Prisma.BulkJobItemWhereInput = {
    jobId: job.id,
    ...(show === "failed" ? { status: "FAILED" } : {}),
  };
  const [items, itemCount, rollbackOf, rolledBackBy] = await Promise.all([
    db.bulkJobItem.findMany({
      where: itemWhere,
      orderBy: [{ status: "asc" }, { title: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.bulkJobItem.count({ where: itemWhere }),
    job.rollbackOfId
      ? db.bulkJob.findUnique({ where: { id: job.rollbackOfId } })
      : null,
    db.bulkJob.findUnique({ where: { rollbackOfId: job.id } }),
  ]);

  const spec = jobSpec(job);
  const summary =
    spec.kind === "EDITOR"
      ? describeOperations(spec.operations, spec.collectionTitles)
      : spec.kind === "CSV"
        ? [`${spec.rows.length} rows from ${spec.fileName}`]
        : ["Restores every field the original job changed"];

  return {
    job: {
      id: job.id,
      name: job.name,
      source: job.source,
      status: job.status,
      phase: job.phase,
      error: job.error,
      productCount: job.productCount,
      variantCount: job.variantCount,
      changeCount: job.changeCount,
      succeeded: job.succeeded,
      failed: job.failed,
      bulkObjectCount: job.bulkObjectCount,
      bulkTotal: job.bulkTotal,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      warnings: JSON.parse(job.warnings) as string[],
    },
    selection:
      spec.kind === "EDITOR"
        ? spec.selection.mode === "filter"
          ? `Products matching: ${spec.selection.query}`
          : `${spec.selection.ids.length} picked products`
        : null,
    summary,
    rollbackOf: rollbackOf && { id: rollbackOf.id, name: rollbackOf.name },
    rolledBackBy: rolledBackBy &&
      rolledBackBy.status !== "DISCARDED" && {
        id: rolledBackBy.id,
        name: rolledBackBy.name,
        status: rolledBackBy.status,
      },
    items: items.map((i) => ({
      id: i.id,
      productId: i.productId,
      title: i.title,
      imageUrl: i.imageUrl,
      status: i.status,
      error: i.error,
      lines: describeChanges(
        JSON.parse(i.before) as ProductState,
        JSON.parse(i.after) as ProductState,
        spec.collectionTitles,
      ),
    })),
    page,
    show,
    hasNextPage: page * PAGE_SIZE < itemCount,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const intent = String((await request.formData()).get("intent"));
  const id = params.id!;
  try {
    switch (intent) {
      case "apply":
        await applyJob(admin, session.shop, id);
        return { ok: true, message: "Applying changes" };
      case "discard":
        await discardJob(session.shop, id);
        return redirect("/app/jobs");
      case "refresh":
        await refreshJob(admin, session.shop, id);
        return { ok: true, message: "Re-reading products" };
      case "undo": {
        const undo = await createRollbackJob(session.shop, id);
        return redirect(`/app/jobs/${undo.id}`);
      }
      case "abandon":
        await abandonJob(session.shop, id);
        return { ok: true, message: "Job stopped" };
    }
  } catch (e) {
    if (e instanceof JobError) return { ok: false, message: e.message };
    throw e;
  }
  return { ok: false, message: "Unknown action" };
};

export default function JobDetail() {
  const data = useLoaderData<typeof loader>();
  const { job, items } = data;
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const shopify = useAppBridge();

  const active = job.status === "SNAPSHOTTING" || job.status === "APPLYING";
  const busy = fetcher.state !== "idle";
  const stale =
    job.status === "READY" &&
    job.source !== "ROLLBACK" &&
    Date.now() - new Date(job.updatedAt).getTime() > STALE_MINUTES * 60000;

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(t);
  }, [active, revalidator]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
    }
  }, [fetcher.state, fetcher.data, shopify]);

  const run = (intent: string) =>
    fetcher.submit({ intent }, { method: "post" });

  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    navigate(`?${next.toString()}`, { preventScrollReset: true });
  };

  const phases = ["PRODUCTS", "VARIANTS", "COLLECTIONS"];
  const phaseIndex = Math.max(0, phases.indexOf(job.phase ?? "PRODUCTS"));
  const phaseProgress = job.bulkTotal ? job.bulkObjectCount / job.bulkTotal : 0;
  const applyProgress =
    job.phase === "DONE" ? 1 : (phaseIndex + phaseProgress) / phases.length;
  const duration =
    job.startedAt && job.finishedAt
      ? Math.round(
          (new Date(job.finishedAt).getTime() -
            new Date(job.startedAt).getTime()) /
            1000,
        )
      : null;

  return (
    <s-page heading={job.name} inlineSize="large">
      <s-link slot="breadcrumb-actions" href="/app/jobs">
        History
      </s-link>

      {job.status === "READY" && (
        <>
          <s-button
            slot="primary-action"
            variant="primary"
            disabled={busy || job.productCount === 0}
            {...(busy ? { loading: true } : {})}
            onClick={() => run("apply")}
          >
            Apply to {job.productCount} products
          </s-button>
          {job.source !== "ROLLBACK" && (
            <s-button slot="secondary-actions" onClick={() => run("refresh")}>
              Refresh preview
            </s-button>
          )}
          <s-button
            slot="secondary-actions"
            tone="critical"
            onClick={() => run("discard")}
          >
            Discard
          </s-button>
        </>
      )}
      {job.status === "SNAPSHOTTING" && (
        <s-button slot="secondary-actions" onClick={() => run("discard")}>
          Cancel
        </s-button>
      )}
      {(job.status === "COMPLETED" || job.status === "PARTIAL") &&
        !data.rolledBackBy && (
          <s-button
            slot="primary-action"
            disabled={busy}
            onClick={() => run("undo")}
          >
            Undo this job
          </s-button>
        )}

      {data.rollbackOf && (
        <s-banner tone="info">
          This undoes{" "}
          <s-link href={`/app/jobs/${data.rollbackOf.id}`}>
            {data.rollbackOf.name}
          </s-link>
          . Products edited since then will have these fields set back as well.
        </s-banner>
      )}
      {data.rolledBackBy && (
        <s-banner tone="info">
          Undone by{" "}
          <s-link href={`/app/jobs/${data.rolledBackBy.id}`}>
            {data.rolledBackBy.name}
          </s-link>
          .
        </s-banner>
      )}
      {stale && (
        <s-banner tone="warning" heading="This preview is over 30 minutes old">
          Products may have changed since. Refresh the preview before applying
          so recent edits aren&apos;t overwritten.
        </s-banner>
      )}
      {job.error && (
        <s-banner
          tone={job.status === "APPLYING" ? "warning" : "critical"}
          heading={job.status === "APPLYING" ? "Having trouble" : "Job failed"}
        >
          <s-stack gap="small-200">
            <s-text>{job.error}</s-text>
            {job.status === "APPLYING" && (
              <s-button onClick={() => run("abandon")}>Stop this job</s-button>
            )}
          </s-stack>
        </s-banner>
      )}

      <s-section>
        <s-stack gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <JobStatusBadge status={job.status} />
            <s-text color="subdued">
              {SOURCE_LABELS[job.source]} · created{" "}
              {new Date(job.createdAt).toLocaleString()}
            </s-text>
          </s-stack>

          {job.status === "SNAPSHOTTING" && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-spinner accessibilityLabel="Reading products" />
              <s-text>
                Reading products with a bulk query… {job.bulkObjectCount} so far
              </s-text>
            </s-stack>
          )}

          {job.status === "APPLYING" && (
            <s-stack gap="small-200">
              <s-stack direction="inline" justifyContent="space-between">
                <s-text>{PHASE_LABELS[job.phase ?? "PRODUCTS"]}</s-text>
                <s-text color="subdued">
                  {job.bulkTotal
                    ? `${job.bulkObjectCount} of ${job.bulkTotal}`
                    : `Step ${phaseIndex + 1} of ${phases.length}`}
                </s-text>
              </s-stack>
              <ProgressBar value={applyProgress} label="Apply progress" />
              <s-text color="subdued">
                Safe to leave this page. Shopify notifies the app when each step
                finishes.
              </s-text>
            </s-stack>
          )}

          {job.status !== "SNAPSHOTTING" && (
            <s-grid
              gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))"
              gap="base"
            >
              <Metric label="Products" value={job.productCount} />
              <Metric label="Variants" value={job.variantCount} />
              <Metric label="Field changes" value={job.changeCount} />
              {job.finishedAt && (
                <>
                  <Metric label="Updated" value={job.succeeded} />
                  <Metric label="Failed" value={job.failed} />
                  {duration !== null && (
                    <Metric label="Took" value={formatDuration(duration)} />
                  )}
                </>
              )}
            </s-grid>
          )}
        </s-stack>
      </s-section>

      {job.warnings.length > 0 && (
        <s-section heading={`Warnings (${job.warnings.length})`}>
          <s-unordered-list>
            {job.warnings.slice(0, 50).map((w) => (
              <s-list-item key={w}>{w}</s-list-item>
            ))}
          </s-unordered-list>
          {job.warnings.length > 50 && (
            <s-text color="subdued">
              …and {job.warnings.length - 50} more.
            </s-text>
          )}
        </s-section>
      )}

      {job.status !== "SNAPSHOTTING" && (
        <s-section padding="none">
          <s-table
            paginate
            hasPreviousPage={data.page > 1}
            hasNextPage={data.hasNextPage}
            onPreviousPage={() => go({ page: String(data.page - 1) })}
            onNextPage={() => go({ page: String(data.page + 1) })}
          >
            {job.failed > 0 && (
              <s-stack slot="filters" direction="inline" gap="small-200">
                <s-select
                  label="Show"
                  labelAccessibilityVisibility="exclusive"
                  value={data.show}
                  onChange={(e) =>
                    go({
                      show:
                        e.currentTarget.value === "failed" ? "failed" : null,
                      page: null,
                    })
                  }
                >
                  <s-option value="all">All products</s-option>
                  <s-option value="failed">Failed only ({job.failed})</s-option>
                </s-select>
              </s-stack>
            )}
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="labeled">
                {job.status === "READY"
                  ? "Changes (before → after)"
                  : "Changes"}
              </s-table-header>
              <s-table-header listSlot="inline">Result</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {items.map((item) => (
                <s-table-row key={item.id}>
                  <s-table-cell>
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-thumbnail
                        size="small"
                        alt={item.title}
                        src={item.imageUrl ?? undefined}
                      />
                      <s-link
                        href={`shopify://admin/products/${item.productId.split("/").pop()}`}
                        target="_blank"
                      >
                        {item.title}
                      </s-link>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <ChangeList lines={item.lines} />
                  </s-table-cell>
                  <s-table-cell>
                    {item.status === "SUCCESS" && (
                      <s-badge tone="success">Updated</s-badge>
                    )}
                    {item.status === "FAILED" && (
                      <s-stack gap="small-100">
                        <s-badge tone="critical">Failed</s-badge>
                        <s-text color="subdued">{item.error}</s-text>
                      </s-stack>
                    )}
                    {item.status === "PENDING" && (
                      <s-badge tone="neutral">
                        {job.status === "READY" ? "Preview" : "Pending"}
                      </s-badge>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
          {!items.length && (
            <s-box padding="large">
              <s-text color="subdued">
                {job.status === "READY"
                  ? "Nothing to change: every selected product already has these values."
                  : "No products to show."}
              </s-text>
            </s-box>
          )}
        </s-section>
      )}

      <s-section slot="aside" heading="What this job does">
        <s-stack gap="small-200">
          {data.selection && <s-text color="subdued">{data.selection}</s-text>}
          <s-unordered-list>
            {data.summary.map((s) => (
              <s-list-item key={s}>{s}</s-list-item>
            ))}
          </s-unordered-list>
        </s-stack>
      </s-section>
      {job.status === "READY" && (
        <s-section slot="aside" heading="Undo is built in">
          <s-paragraph>
            The original value of every field is saved before anything is
            written. After the job runs, “Undo this job” restores them.
          </s-paragraph>
        </s-section>
      )}
    </s-page>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small-100">
        <s-text color="subdued">{label}</s-text>
        <s-heading>
          {typeof value === "number" ? value.toLocaleString() : value}
        </s-heading>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
