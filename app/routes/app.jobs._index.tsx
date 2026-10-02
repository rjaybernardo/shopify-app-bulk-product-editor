import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { JobStatusBadge, SOURCE_LABELS } from "../components/JobUi";

const PAGE_SIZE = 25;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const where = { shop: session.shop, status: { not: "DISCARDED" } };

  const [jobs, count] = await Promise.all([
    db.bulkJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { rolledBackBy: { select: { status: true } } },
    }),
    db.bulkJob.count({ where }),
  ]);

  return {
    jobs: jobs.map((j) => ({
      id: j.id,
      name: j.name,
      source: j.source,
      status: j.status,
      products: j.productCount,
      changes: j.changeCount,
      failed: j.failed,
      undone: Boolean(j.rolledBackBy && j.rolledBackBy.status !== "DISCARDED"),
      createdAt: j.createdAt.toISOString(),
    })),
    page,
    hasNextPage: page * PAGE_SIZE < count,
  };
};

export default function JobsIndex() {
  const { jobs, page, hasNextPage } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const go = (p: number) => {
    const next = new URLSearchParams(params);
    next.set("page", String(p));
    navigate(`?${next.toString()}`);
  };

  return (
    <s-page heading="History" inlineSize="large">
      <s-button slot="primary-action" variant="primary" href="/app/edit">
        New bulk edit
      </s-button>
      <s-section padding="none">
        <s-table
          paginate
          hasPreviousPage={page > 1}
          hasNextPage={hasNextPage}
          onPreviousPage={() => go(page - 1)}
          onNextPage={() => go(page + 1)}
        >
          <s-table-header-row>
            <s-table-header listSlot="primary">Job</s-table-header>
            <s-table-header listSlot="secondary">Type</s-table-header>
            <s-table-header listSlot="inline">Status</s-table-header>
            <s-table-header format="numeric">Products</s-table-header>
            <s-table-header format="numeric">Field changes</s-table-header>
            <s-table-header listSlot="kicker">Created</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {jobs.map((j) => (
              <s-table-row key={j.id}>
                <s-table-cell>
                  <s-link href={`/app/jobs/${j.id}`}>{j.name}</s-link>
                </s-table-cell>
                <s-table-cell>{SOURCE_LABELS[j.source]}</s-table-cell>
                <s-table-cell>
                  <s-stack direction="inline" gap="small-200">
                    <JobStatusBadge status={j.status} />
                    {j.undone && <s-badge tone="neutral">Undone</s-badge>}
                  </s-stack>
                </s-table-cell>
                <s-table-cell>{j.products.toLocaleString()}</s-table-cell>
                <s-table-cell>{j.changes.toLocaleString()}</s-table-cell>
                <s-table-cell>
                  {new Date(j.createdAt).toLocaleString()}
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
        {!jobs.length && (
          <s-box padding="large">
            <s-text color="subdued">
              No bulk edits yet. Start one from Bulk edit or Import CSV.
            </s-text>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
