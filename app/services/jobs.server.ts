import type { BulkJob, BulkJobItem } from "@prisma/client";
import db from "../db.server";
import { targetsFromCsv } from "../lib/csv";
import { parseJsonl, snapshotsFromJsonl } from "../lib/jsonl";
import { targetFromOperations } from "../lib/operations";
import { ALL_STATUSES, idsQuery } from "../lib/query";
import {
  diffProduct,
  productUpdateInput,
  toCents,
  variantsUpdateInput,
} from "../lib/plan";
import type {
  CsvSpec,
  EditorSpec,
  JobSpec,
  PlannedItem,
  ProductSnapshot,
  ProductState,
  RollbackSpec,
} from "../lib/types";
import {
  PRODUCT_UPDATE_MUTATION,
  VARIANTS_UPDATE_MUTATION,
  downloadText,
  getBulkOperation,
  getPickableSourceId,
  snapshotQuery,
  startBulkMutation,
  startBulkQuery,
  updateCollectionSelections,
  type Admin,
} from "./shopify-bulk.server";

// Job lifecycle
//
//   SNAPSHOTTING ──bulk query done──▶ READY ──apply──▶ APPLYING ──▶ COMPLETED | PARTIAL | FAILED
//        │                              │                │
//        └────────── discard ───────────┘                └─ phases: PRODUCTS → VARIANTS → COLLECTIONS → DONE
//
// Nothing runs in the background. advanceJob() moves a job forward one or more steps and is
// called both by the job page while it polls and by the bulk_operations/finish webhook, so a
// job finishes even if the merchant closes the tab. A row lock stops the two from racing.

export const MAX_PRODUCTS = 10000;
const LOCK_MS = 5 * 60 * 1000;
const COLLECTION_BATCH = 250;
const PHASES = ["PRODUCTS", "VARIANTS", "COLLECTIONS", "DONE"] as const;
type Phase = (typeof PHASES)[number];

export class JobError extends Error {}

const parse = <T>(json: string) => JSON.parse(json) as T;

export function jobSpec(job: Pick<BulkJob, "spec">) {
  return parse<JobSpec>(job.spec);
}

// --- Creating jobs ------------------------------------------------------------------------

function selectionQuery(spec: EditorSpec) {
  return spec.selection.mode === "filter"
    ? spec.selection.query
    : idsQuery(spec.selection.ids);
}

const CATALOG_QUERY = `status:${ALL_STATUSES}`;

export async function createEditorJob(
  admin: Admin,
  shop: string,
  name: string,
  spec: EditorSpec,
) {
  const bulkOperationId = await startBulkQuery(
    admin,
    snapshotQuery(selectionQuery(spec)),
  );
  return db.bulkJob.create({
    data: {
      shop,
      name,
      source: "EDITOR",
      spec: JSON.stringify(spec),
      bulkOperationId,
    },
  });
}

// CSV rows reference products by handle, SKU or ID, so the whole catalog is snapshotted and
// rows are matched in memory. One bulk query beats thousands of per-row lookups.
export async function createCsvJob(
  admin: Admin,
  shop: string,
  name: string,
  spec: CsvSpec,
) {
  const bulkOperationId = await startBulkQuery(
    admin,
    snapshotQuery(CATALOG_QUERY),
  );
  return db.bulkJob.create({
    data: {
      shop,
      name,
      source: "CSV",
      spec: JSON.stringify(spec),
      bulkOperationId,
    },
  });
}

// Undo = a new job whose target is the original "before" values. It skips the snapshot: the
// preview shows what the job set (after) going back to what was there (before).
export async function createRollbackJob(shop: string, jobId: string) {
  const original = await db.bulkJob.findFirst({
    where: { id: jobId, shop },
    include: { rolledBackBy: true },
  });
  if (!original) throw new JobError("Job not found");
  if (!["COMPLETED", "PARTIAL"].includes(original.status)) {
    throw new JobError("Only finished jobs can be undone");
  }
  if (original.rolledBackBy && original.rolledBackBy.status !== "DISCARDED") {
    return original.rolledBackBy;
  }
  if (original.rolledBackBy) {
    await db.bulkJob.delete({ where: { id: original.rolledBackBy.id } });
  }

  const items = await db.bulkJobItem.findMany({
    where: { jobId, status: { not: "PENDING" } },
  });
  const spec: RollbackSpec = {
    kind: "ROLLBACK",
    jobId,
    collectionTitles: jobSpec(original).collectionTitles,
  };
  const job = await db.bulkJob.create({
    data: {
      shop,
      name: `Undo: ${original.name}`,
      source: "ROLLBACK",
      status: "READY",
      spec: JSON.stringify(spec),
      rollbackOfId: original.id,
    },
  });
  await saveItems(
    job.id,
    items.map((i) => ({
      productId: i.productId,
      title: i.title,
      handle: i.handle,
      imageUrl: i.imageUrl,
      before: parse<ProductState>(i.after),
      after: parse<ProductState>(i.before),
      changeCount: i.changeCount,
    })),
  );
  return job;
}

export async function refreshJob(admin: Admin, shop: string, jobId: string) {
  const job = await db.bulkJob.findFirst({ where: { id: jobId, shop } });
  if (!job || job.status !== "READY" || job.source === "ROLLBACK") {
    throw new JobError("This preview can't be refreshed");
  }
  const spec = jobSpec(job);
  const query = spec.kind === "EDITOR" ? selectionQuery(spec) : CATALOG_QUERY;
  const bulkOperationId = await startBulkQuery(admin, snapshotQuery(query));
  await db.bulkJobItem.deleteMany({ where: { jobId } });
  await db.bulkJob.update({
    where: { id: jobId },
    data: {
      status: "SNAPSHOTTING",
      bulkOperationId,
      bulkObjectCount: 0,
      warnings: "[]",
      productCount: 0,
      variantCount: 0,
      changeCount: 0,
    },
  });
}

export async function discardJob(shop: string, jobId: string) {
  await db.bulkJob.updateMany({
    where: { id: jobId, shop, status: { in: ["SNAPSHOTTING", "READY"] } },
    data: { status: "DISCARDED", bulkOperationId: null },
  });
}

// Escape hatch for a job stuck retrying (e.g. the app lost write_products mid-run).
export async function abandonJob(shop: string, jobId: string) {
  await db.bulkJob.updateMany({
    where: { id: jobId, shop, status: "APPLYING" },
    data: {
      status: "FAILED",
      bulkOperationId: null,
      finishedAt: new Date(),
      error:
        "Stopped by merchant. Some products may already have been updated.",
    },
  });
}

export async function applyJob(admin: Admin, shop: string, jobId: string) {
  const busy = await db.bulkJob.findFirst({
    where: { shop, status: "APPLYING", id: { not: jobId } },
  });
  if (busy) {
    throw new JobError(
      `“${busy.name}” is still being applied. Wait for it to finish so the two jobs don't overwrite each other.`,
    );
  }
  const { count } = await db.bulkJob.updateMany({
    where: { id: jobId, shop, status: "READY", productCount: { gt: 0 } },
    data: { status: "APPLYING", phase: "PRODUCTS", startedAt: new Date() },
  });
  if (!count) throw new JobError("This job isn't ready to apply");
  await advanceJob(admin, jobId);
}

// --- Planning -----------------------------------------------------------------------------

export function buildPlan(spec: JobSpec, snapshots: ProductSnapshot[]) {
  const items: PlannedItem[] = [];
  const warnings: string[] = [];

  if (spec.kind === "EDITOR") {
    for (const snap of snapshots) {
      const item = diffProduct(
        snap,
        targetFromOperations(snap, spec.operations),
      );
      if (item) items.push(item);
    }
    if (spec.selection.mode === "ids") {
      const missing = spec.selection.ids.length - snapshots.length;
      if (missing > 0)
        warnings.push(`${missing} selected products no longer exist.`);
    }
  } else if (spec.kind === "CSV") {
    const { targets, warnings: rowWarnings } = targetsFromCsv(
      snapshots,
      spec.rows,
    );
    warnings.push(...rowWarnings);
    const byId = new Map(snapshots.map((s) => [s.id, s]));
    for (const [id, target] of targets) {
      const item = diffProduct(byId.get(id)!, target);
      if (item) items.push(item);
    }
  }

  const variantsById = new Map(
    snapshots.flatMap((s) => s.variants.map((v) => [v.id, v] as const)),
  );
  let lowCompareAt = 0;
  for (const item of items) {
    for (const v of item.after.variants ?? []) {
      const snap = variantsById.get(v.id);
      const price = v.price ?? snap?.price;
      const compareAt =
        v.compareAtPrice !== undefined
          ? v.compareAtPrice
          : snap?.compareAtPrice;
      if (
        price != null &&
        compareAt != null &&
        (v.price !== undefined || v.compareAtPrice !== undefined) &&
        toCents(compareAt) <= toCents(price)
      )
        lowCompareAt++;
    }
  }
  if (lowCompareAt) {
    warnings.push(
      `${lowCompareAt} variants will have a compare-at price at or below their price, so they won't show as on sale.`,
    );
  }

  return { items, warnings };
}

async function saveItems(jobId: string, items: PlannedItem[]) {
  for (let i = 0; i < items.length; i += 500) {
    await db.bulkJobItem.createMany({
      data: items.slice(i, i + 500).map((item) => ({
        jobId,
        productId: item.productId,
        title: item.title,
        handle: item.handle,
        imageUrl: item.imageUrl,
        before: JSON.stringify(item.before),
        after: JSON.stringify(item.after),
        changeCount: item.changeCount,
      })),
    });
  }
  await db.bulkJob.update({
    where: { id: jobId },
    data: {
      productCount: items.length,
      variantCount: items.reduce(
        (n, i) => n + (i.after.variants?.length ?? 0),
        0,
      ),
      changeCount: items.reduce((n, i) => n + i.changeCount, 0),
    },
  });
}

// --- Advancing ----------------------------------------------------------------------------

export async function advanceJob(admin: Admin, jobId: string) {
  const now = new Date();
  const { count } = await db.bulkJob.updateMany({
    where: {
      id: jobId,
      status: { in: ["SNAPSHOTTING", "APPLYING"] },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  if (!count) return;

  let status = "SNAPSHOTTING";
  try {
    for (let guard = 0; guard < 10; guard++) {
      const job = await db.bulkJob.findUniqueOrThrow({ where: { id: jobId } });
      status = job.status;
      const more = await step(admin, job);
      if (job.error && job.status === "APPLYING") {
        await db.bulkJob.update({
          where: { id: jobId },
          data: { error: null },
        });
      }
      if (!more) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Nothing is written during a snapshot, so failing is safe. Mid-apply, some products may
    // already be changed: keep the job where it is and retry on the next poll or webhook.
    await db.bulkJob.update({
      where: { id: jobId },
      data:
        status === "SNAPSHOTTING"
          ? { status: "FAILED", error: message, finishedAt: new Date() }
          : { error: `Retrying: ${message}` },
    });
  } finally {
    await db.bulkJob.update({
      where: { id: jobId },
      data: { lockedUntil: null },
    });
  }
}

// Returns true when the job can immediately take another step.
async function step(admin: Admin, job: BulkJob): Promise<boolean> {
  if (job.status === "SNAPSHOTTING") return stepSnapshot(admin, job);
  if (job.status !== "APPLYING") return false;

  switch (job.phase as Phase) {
    case "PRODUCTS":
      return stepBulkMutation(admin, job, "PRODUCTS");
    case "VARIANTS":
      return stepBulkMutation(admin, job, "VARIANTS");
    case "COLLECTIONS":
      await applyCollections(admin, job);
      await setPhase(job.id, "DONE");
      return true;
    case "DONE":
      await finish(job);
      return false;
    default:
      throw new Error(`Unknown phase ${job.phase}`);
  }
}

async function stepSnapshot(admin: Admin, job: BulkJob) {
  const op = await getBulkOperation(admin, job.bulkOperationId!);
  if (["CREATED", "RUNNING", "CANCELING"].includes(op.status)) {
    await db.bulkJob.update({
      where: { id: job.id },
      data: { bulkObjectCount: Number(op.rootObjectCount) },
    });
    return false;
  }
  if (op.status !== "COMPLETED") {
    throw new Error(
      `Reading products failed (${op.errorCode ?? op.status.toLowerCase()})`,
    );
  }

  // A query that matches nothing completes with no file.
  const text = op.url ? await downloadText(op.url) : "";
  const snapshots = snapshotsFromJsonl(parseJsonl(text));
  const spec = jobSpec(job);
  if (spec.kind === "EDITOR" && snapshots.length > MAX_PRODUCTS) {
    throw new Error(
      `${snapshots.length} products matched. Narrow the selection to ${MAX_PRODUCTS} or fewer.`,
    );
  }
  const { items, warnings } = buildPlan(spec, snapshots);
  await saveItems(job.id, items);
  await db.bulkJob.update({
    where: { id: job.id },
    data: {
      status: "READY",
      bulkOperationId: null,
      bulkObjectCount: snapshots.length,
      warnings: JSON.stringify(warnings.slice(0, 500)),
    },
  });
  return false;
}

async function setPhase(jobId: string, phase: Phase) {
  await db.bulkJob.update({
    where: { id: jobId },
    data: { phase, bulkOperationId: null, bulkObjectCount: 0, bulkTotal: 0 },
  });
}

const nextPhase = (phase: Phase) => PHASES[PHASES.indexOf(phase) + 1];

async function stepBulkMutation(
  admin: Admin,
  job: BulkJob,
  phase: "PRODUCTS" | "VARIANTS",
) {
  const lineField = phase === "PRODUCTS" ? "productLine" : "variantLine";

  if (!job.bulkOperationId) {
    const items = await db.bulkJobItem.findMany({
      where: { jobId: job.id },
      orderBy: { id: "asc" },
    });
    const lines: { itemId: string; vars: object }[] = [];
    for (const item of items) {
      const after = parse<ProductState>(item.after);
      const vars =
        phase === "PRODUCTS"
          ? productUpdateInput(item.productId, after)
          : variantsUpdateInput(item.productId, after);
      if (vars) lines.push({ itemId: item.id, vars });
    }
    if (!lines.length) {
      await setPhase(job.id, nextPhase(phase));
      return true;
    }

    await db.$transaction(
      lines.map((l, i) =>
        db.bulkJobItem.update({
          where: { id: l.itemId },
          data: { [lineField]: i },
        }),
      ),
    );
    const bulkOperationId = await startBulkMutation(
      admin,
      phase === "PRODUCTS" ? PRODUCT_UPDATE_MUTATION : VARIANTS_UPDATE_MUTATION,
      lines.map((l) => l.vars),
    );
    await db.bulkJob.update({
      where: { id: job.id },
      data: { bulkOperationId, bulkTotal: lines.length, bulkObjectCount: 0 },
    });
    return false;
  }

  const op = await getBulkOperation(admin, job.bulkOperationId);
  if (["CREATED", "RUNNING", "CANCELING"].includes(op.status)) {
    await db.bulkJob.update({
      where: { id: job.id },
      data: { bulkObjectCount: Number(op.rootObjectCount) },
    });
    return false;
  }

  const resultUrl = op.url ?? op.partialDataUrl;
  const results = resultUrl
    ? resultErrorsByLine(await downloadText(resultUrl))
    : new Map<number, string | null>();
  const items = await db.bulkJobItem.findMany({
    where: { jobId: job.id, [lineField]: { not: null } },
  });
  const failures: { id: string; error: string }[] = [];
  for (const item of items) {
    const line = item[lineField] as number;
    const error = results.has(line)
      ? results.get(line)
      : `Not applied: bulk operation ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ""}`;
    if (error)
      failures.push({ id: item.id, error: withPrefix(item, error, phase) });
  }
  await recordErrors(failures);
  await setPhase(job.id, nextPhase(phase));
  return true;
}

function withPrefix(item: BulkJobItem, error: string, phase: string) {
  const label =
    phase === "PRODUCTS"
      ? "Product"
      : phase === "VARIANTS"
        ? "Prices"
        : "Collections";
  return [item.error, `${label}: ${error}`].filter(Boolean).join(" · ");
}

async function recordErrors(failures: { id: string; error: string }[]) {
  for (let i = 0; i < failures.length; i += 200) {
    await db.$transaction(
      failures.slice(i, i + 200).map((f) =>
        db.bulkJobItem.update({
          where: { id: f.id },
          data: { error: f.error },
        }),
      ),
    );
  }
}

// Each result line is {"data": {"<mutation>": {"userErrors": [...]}}, "__lineNumber": n},
// or carries top-level "errors" when the line couldn't run at all.
export function resultErrorsByLine(text: string) {
  const out = new Map<number, string | null>();
  for (const line of parseJsonl(text)) {
    const n = line.__lineNumber as number | undefined;
    if (typeof n !== "number") continue;
    const messages: string[] = [];
    for (const e of (line.errors as { message: string }[] | undefined) ?? [])
      messages.push(e.message);
    const data = (line.data ?? {}) as Record<
      string,
      { userErrors?: { message: string }[] } | null
    >;
    for (const payload of Object.values(data)) {
      for (const e of payload?.userErrors ?? []) messages.push(e.message);
    }
    out.set(n, messages.length ? messages.join("; ") : null);
  }
  return out;
}

async function applyCollections(admin: Admin, job: BulkJob) {
  const items = await db.bulkJobItem.findMany({ where: { jobId: job.id } });
  const changes = new Map<
    string,
    { add: BulkJobItem[]; remove: BulkJobItem[] }
  >();
  for (const item of items) {
    const after = parse<ProductState>(item.after);
    for (const [collectionId, member] of Object.entries(
      after.collections ?? {},
    )) {
      const entry = changes.get(collectionId) ?? { add: [], remove: [] };
      (member ? entry.add : entry.remove).push(item);
      changes.set(collectionId, entry);
    }
  }

  const errors = new Map<string, string[]>();
  const titles = jobSpec(job).collectionTitles;
  for (const [collectionId, { add, remove }] of changes) {
    const name = titles[collectionId] ?? collectionId;
    let sourceId: string;
    try {
      sourceId = await getPickableSourceId(admin, collectionId);
    } catch (e) {
      for (const item of [...add, ...remove])
        pushError(errors, item.id, `${name}: ${(e as Error).message}`);
      continue;
    }
    for (const [kind, list] of [
      ["add", add],
      ["remove", remove],
    ] as const) {
      for (let i = 0; i < list.length; i += COLLECTION_BATCH) {
        const batch = list.slice(i, i + COLLECTION_BATCH);
        try {
          await updateCollectionSelections(admin, collectionId, sourceId, {
            [kind]: batch.map((b) => b.productId),
          });
        } catch (e) {
          for (const item of batch)
            pushError(errors, item.id, `${name}: ${(e as Error).message}`);
        }
      }
    }
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  await recordErrors(
    [...errors].map(([id, messages]) => ({
      id,
      error: withPrefix(byId.get(id)!, messages.join("; "), "COLLECTIONS"),
    })),
  );
}

function pushError(map: Map<string, string[]>, id: string, message: string) {
  map.set(id, [...(map.get(id) ?? []), message]);
}

async function finish(job: BulkJob) {
  await db.bulkJobItem.updateMany({
    where: { jobId: job.id, error: { not: null } },
    data: { status: "FAILED" },
  });
  await db.bulkJobItem.updateMany({
    where: { jobId: job.id, error: null },
    data: { status: "SUCCESS" },
  });
  const [succeeded, failed] = await Promise.all([
    db.bulkJobItem.count({ where: { jobId: job.id, status: "SUCCESS" } }),
    db.bulkJobItem.count({ where: { jobId: job.id, status: "FAILED" } }),
  ]);
  await db.bulkJob.update({
    where: { id: job.id },
    data: {
      status:
        failed === 0 ? "COMPLETED" : succeeded === 0 ? "FAILED" : "PARTIAL",
      succeeded,
      failed,
      finishedAt: new Date(),
    },
  });
}

// --- Webhook entry point ------------------------------------------------------------------

export async function advanceJobForBulkOperation(
  admin: Admin,
  shop: string,
  bulkOperationId: string,
) {
  const job = await db.bulkJob.findFirst({ where: { shop, bulkOperationId } });
  if (job) await advanceJob(admin, job.id);
}

// --- Dashboard ----------------------------------------------------------------------------

// Rough cost of making one field change by hand in the product editor, used for "time saved".
export const MANUAL_SECONDS_PER_CHANGE = 30;

export async function getDashboard(shop: string, days: number) {
  const since = new Date(Date.now() - days * 86400000);
  const finished = await db.bulkJob.findMany({
    where: {
      shop,
      status: { in: ["COMPLETED", "PARTIAL"] },
      finishedAt: { gte: since },
    },
    select: {
      id: true,
      source: true,
      succeeded: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  const ids = finished.map((j) => j.id);
  const changes = await db.bulkJobItem.aggregate({
    where: { jobId: { in: ids }, status: "SUCCESS" },
    _sum: { changeCount: true },
  });
  const changeCount = changes._sum.changeCount ?? 0;
  const durations = finished
    .filter((j) => j.startedAt && j.finishedAt)
    .map((j) => j.finishedAt!.getTime() - j.startedAt!.getTime());

  const recent = await db.bulkJob.findMany({
    where: { shop, status: { not: "DISCARDED" } },
    orderBy: { createdAt: "desc" },
    take: 6,
  });

  return {
    jobs: finished.length,
    undos: finished.filter((j) => j.source === "ROLLBACK").length,
    products: finished.reduce((n, j) => n + j.succeeded, 0),
    changes: changeCount,
    hoursSaved:
      Math.round(((changeCount * MANUAL_SECONDS_PER_CHANGE) / 3600) * 10) / 10,
    medianSeconds: durations.length
      ? Math.round(
          durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] /
            1000,
        )
      : null,
    recent,
  };
}
