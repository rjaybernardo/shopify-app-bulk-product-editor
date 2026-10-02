// End-to-end job lifecycle against a real SQLite database and an in-memory fake of the
// Shopify Admin API that actually executes bulk queries, staged uploads and bulk mutations.
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ProductSnapshot } from "../app/lib/types";
import type { Admin } from "../app/services/shopify-bulk.server";

const TEST_DB = "prisma/test.sqlite";
copyFileSync("prisma/dev.sqlite", TEST_DB);
const prisma = new PrismaClient({ datasourceUrl: `file:./test.sqlite` });
(globalThis as { prismaGlobal?: PrismaClient }).prismaGlobal = prisma;

const jobs = await import("../app/services/jobs.server");
const { mapTable } = await import("../app/lib/csv");

const SHOP = "test-shop.myshopify.com";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Vars = Record<string, any>;

// --- Fake Shopify ------------------------------------------------------------------------

type BulkOp = {
  id: string;
  type: "QUERY" | "MUTATION";
  polls: number;
  resultText: string;
  lines: number;
};

class FakeShopify {
  products = new Map<string, ProductSnapshot>();
  ops = new Map<string, BulkOp>();
  uploads = new Map<string, string>();
  failVariantsFor = new Set<string>();
  started: string[] = [];
  collectionCalls: { id: string; add: string[]; remove: string[] }[] = [];

  seed(products: ProductSnapshot[]) {
    this.products = new Map(products.map((p) => [p.id, structuredClone(p)]));
  }

  snapshotJsonl() {
    const out: string[] = [];
    for (const p of this.products.values()) {
      const { variants, collectionIds, imageUrl, ...rest } = p;
      out.push(
        JSON.stringify({
          ...rest,
          featuredMedia: imageUrl
            ? { preview: { image: { url: imageUrl } } }
            : null,
        }),
      );
      for (const id of collectionIds)
        out.push(JSON.stringify({ id, __parentId: p.id }));
      for (const v of variants)
        out.push(JSON.stringify({ ...v, __parentId: p.id }));
    }
    return out.join("\n");
  }

  runMutation(mutation: string, jsonl: string) {
    const results: string[] = [];
    jsonl
      .trim()
      .split("\n")
      .forEach((line, n) => {
        const vars = JSON.parse(line);
        if (mutation.includes("productUpdate(")) {
          const { id, ...fields } = vars.product;
          Object.assign(this.products.get(id)!, fields);
          results.push(
            JSON.stringify({
              data: { productUpdate: { product: { id }, userErrors: [] } },
              __lineNumber: n,
            }),
          );
        } else {
          const p = this.products.get(vars.productId)!;
          if (this.failVariantsFor.has(p.id)) {
            results.push(
              JSON.stringify({
                data: {
                  productVariantsBulkUpdate: {
                    product: null,
                    userErrors: [
                      { field: ["price"], message: "Price is invalid" },
                    ],
                  },
                },
                __lineNumber: n,
              }),
            );
            return;
          }
          for (const change of vars.variants) {
            Object.assign(
              p.variants.find((v) => v.id === change.id)!,
              change,
            );
          }
          results.push(
            JSON.stringify({
              data: {
                productVariantsBulkUpdate: {
                  product: { id: p.id },
                  userErrors: [],
                },
              },
              __lineNumber: n,
            }),
          );
        }
      });
    return results.join("\n");
  }

  admin = {
    graphql: async (query: string, opts?: { variables?: Vars }) => {
      const v = opts?.variables ?? {};
      const data = this.handle(query, v);
      return new Response(JSON.stringify({ data }));
    },
  } as unknown as Admin;

  private handle(query: string, v: Vars): unknown {
    if (query.includes("BpeRunBulkQuery")) {
      const id = `gid://shopify/BulkOperation/${this.ops.size + 1}`;
      this.ops.set(id, {
        id,
        type: "QUERY",
        polls: 0,
        resultText: this.snapshotJsonl(),
        lines: this.products.size,
      });
      return {
        bulkOperationRunQuery: {
          bulkOperation: { id, status: "CREATED" },
          userErrors: [],
        },
      };
    }
    if (query.includes("BpeStageUpload")) {
      const key = `tmp/bulk/${this.uploads.size + 1}/bulk_op_vars.jsonl`;
      return {
        stagedUploadsCreate: {
          stagedTargets: [
            {
              url: "https://upload.test/",
              resourceUrl: null,
              parameters: [{ name: "key", value: key }],
            },
          ],
          userErrors: [],
        },
      };
    }
    if (query.includes("BpeRunBulkMutation")) {
      this.started.push(
        v.mutation.includes("productUpdate(") ? "products" : "variants",
      );
      const id = `gid://shopify/BulkOperation/${this.ops.size + 1}`;
      const jsonl = this.uploads.get(v.path)!;
      this.ops.set(id, {
        id,
        type: "MUTATION",
        polls: 0,
        resultText: this.runMutation(v.mutation, jsonl),
        lines: jsonl.trim().split("\n").length,
      });
      return {
        bulkOperationRunMutation: {
          bulkOperation: { id, status: "CREATED" },
          userErrors: [],
        },
      };
    }
    if (query.includes("BpeBulkOperation")) {
      const op = this.ops.get(v.id)!;
      op.polls++;
      const done = op.polls > 1; // first poll: RUNNING, second: COMPLETED
      return {
        bulkOperation: {
          id: op.id,
          status: done ? "COMPLETED" : "RUNNING",
          errorCode: null,
          objectCount: String(done ? op.lines : 1),
          rootObjectCount: String(done ? op.lines : 1),
          url:
            done && op.lines
              ? `https://results.test/${encodeURIComponent(op.id)}`
              : null,
          partialDataUrl: null,
        },
      };
    }
    if (query.includes("BpeCollectionSources")) {
      return {
        collection: {
          sources: [
            {
              __typename: "CollectionConditionsSource",
              id: "gid://shopify/CollectionConditionsSource/1",
              targetType: "PRODUCTS",
              inclusion: { conditions: [] },
            },
          ],
        },
      };
    }
    if (query.includes("BpeCollectionSelections")) {
      const add = v.add.map((s: { productId: string }) => s.productId);
      const remove = v.remove.map((s: { productId: string }) => s.productId);
      this.collectionCalls.push({ id: v.id, add, remove });
      for (const p of this.products.values()) {
        if (add.includes(p.id) && !p.collectionIds.includes(v.id))
          p.collectionIds.push(v.id);
        if (remove.includes(p.id))
          p.collectionIds = p.collectionIds.filter((c) => c !== v.id);
      }
      return { collectionUpdate: { collection: { id: v.id }, userErrors: [] } };
    }
    throw new Error(`Unhandled query: ${query.slice(0, 80)}`);
  }

  fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://upload.test/") {
      const form = init!.body as FormData;
      const keys = [...form.keys()];
      expect(keys.at(-1)).toBe("file"); // file must be the last field
      const file = form.get("file") as Blob;
      this.uploads.set(String(form.get("key")), await file.text());
      return new Response(null, { status: 201 });
    }
    if (url.startsWith("https://results.test/")) {
      const op = this.ops.get(decodeURIComponent(url.split("/").pop()!))!;
      return new Response(op.resultText);
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
}

const variant = (id: number, title: string, sku: string, price: string) => ({
  id: `gid://shopify/ProductVariant/${id}`,
  title,
  sku,
  price,
  compareAtPrice: null,
});

const CATALOG: ProductSnapshot[] = [
  {
    id: "gid://shopify/Product/1",
    title: "Classic Tee",
    handle: "classic-tee",
    descriptionHtml: "<p>Tee</p>",
    vendor: "Acme",
    productType: "Shirts",
    status: "ACTIVE",
    tags: ["cotton"],
    collectionIds: [],
    imageUrl: null,
    variants: [
      variant(11, "S", "TEE-S", "20.00"),
      variant(12, "M", "TEE-M", "22.00"),
    ],
  },
  {
    id: "gid://shopify/Product/2",
    title: "Hoodie",
    handle: "hoodie",
    descriptionHtml: "",
    vendor: "Acme",
    productType: "Sweaters",
    status: "DRAFT",
    tags: [],
    collectionIds: [],
    imageUrl: null,
    variants: [variant(21, "Default Title", "HOOD", "50.00")],
  },
  {
    // Already has every target value: must not appear in the plan.
    id: "gid://shopify/Product/3",
    title: "Gift Card",
    handle: "gift-card",
    descriptionHtml: "",
    vendor: "Acme",
    productType: "",
    status: "ACTIVE",
    tags: ["summer-sale"],
    collectionIds: ["gid://shopify/Collection/77"],
    imageUrl: null,
    variants: [],
  },
];

let shopify: FakeShopify;

async function runToEnd(jobId: string) {
  for (let i = 0; i < 20; i++) {
    await jobs.advanceJob(shopify.admin, jobId);
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    if (!["SNAPSHOTTING", "APPLYING"].includes(job.status)) return job;
  }
  throw new Error("job did not finish");
}

beforeAll(() => {
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) =>
    shopify.fetch(...args),
  );
});
beforeEach(async () => {
  shopify = new FakeShopify();
  shopify.seed(CATALOG);
  await prisma.bulkJob.deleteMany();
});
afterAll(async () => {
  await prisma.$disconnect();
  for (const f of [TEST_DB, `${TEST_DB}-journal`]) if (existsSync(f)) rmSync(f);
});

const SALE_SPEC = {
  kind: "EDITOR" as const,
  selection: { mode: "filter" as const, query: "status:active,draft" },
  operations: {
    price: { op: "decrease_pct" as const, value: 10, rounding: "99" as const },
    compareAt: { op: "from_price" as const },
    tags: { add: ["summer-sale"], remove: [] },
    collections: { add: ["gid://shopify/Collection/77"], remove: [] },
  },
  collectionTitles: { "gid://shopify/Collection/77": "Summer Sale" },
};

describe("bulk edit lifecycle", () => {
  it("snapshots, previews, applies, and undoes", async () => {
    const job = await jobs.createEditorJob(
      shopify.admin,
      SHOP,
      "Summer sale",
      SALE_SPEC,
    );
    expect(job.status).toBe("SNAPSHOTTING");

    // First poll: bulk query still running, nothing written.
    await jobs.advanceJob(shopify.admin, job.id);
    let state = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(state.status).toBe("SNAPSHOTTING");

    state = await runToEnd(job.id);
    expect(state.status).toBe("READY");
    expect(state.productCount).toBe(2); // gift card already matches
    expect(state.variantCount).toBe(3);
    // 3 variants × (price + compare-at) + 2 tags + 2 collections
    expect(state.changeCount).toBe(10);
    expect([...shopify.products.values()][0].variants[0].price).toBe("20.00"); // preview wrote nothing

    await jobs.applyJob(shopify.admin, SHOP, job.id);
    state = await runToEnd(job.id);
    expect(state.status).toBe("COMPLETED");
    expect(state.succeeded).toBe(2);

    const tee = shopify.products.get("gid://shopify/Product/1")!;
    expect(tee.variants.map((v) => [v.price, v.compareAtPrice])).toEqual([
      ["17.99", "20.00"],
      ["19.99", "22.00"],
    ]);
    expect(tee.tags).toEqual(["cotton", "summer-sale"]);
    expect(tee.collectionIds).toEqual(["gid://shopify/Collection/77"]);
    expect(shopify.collectionCalls).toEqual([
      {
        id: "gid://shopify/Collection/77",
        add: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
        remove: [],
      },
    ]);

    // Undo restores the exact originals, including collection membership.
    const undo = await jobs.createRollbackJob(SHOP, job.id);
    expect(undo.status).toBe("READY");
    await jobs.applyJob(shopify.admin, SHOP, undo.id);
    expect((await runToEnd(undo.id)).status).toBe("COMPLETED");
    for (const original of CATALOG) {
      expect(shopify.products.get(original.id)).toEqual(original);
    }
    // A second undo request returns the existing one instead of creating another.
    expect((await jobs.createRollbackJob(SHOP, job.id)).id).toBe(undo.id);
  });

  it("records per-product failures and finishes as partial", async () => {
    shopify.failVariantsFor.add("gid://shopify/Product/2");
    const job = await jobs.createEditorJob(
      shopify.admin,
      SHOP,
      "Sale",
      SALE_SPEC,
    );
    await runToEnd(job.id);
    await jobs.applyJob(shopify.admin, SHOP, job.id);
    const done = await runToEnd(job.id);

    expect(done.status).toBe("PARTIAL");
    expect([done.succeeded, done.failed]).toEqual([1, 1]);
    const failed = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: job.id, status: "FAILED" },
    });
    expect(failed.productId).toBe("gid://shopify/Product/2");
    expect(failed.error).toBe("Prices: Price is invalid");
    // Product-level fields on the failed product still went through.
    expect(shopify.products.get("gid://shopify/Product/2")!.tags).toEqual([
      "summer-sale",
    ]);
  });

  it("never starts the same bulk mutation twice when poll and webhook race", async () => {
    const job = await jobs.createEditorJob(
      shopify.admin,
      SHOP,
      "Race",
      SALE_SPEC,
    );
    await runToEnd(job.id);
    await prisma.bulkJob.update({
      where: { id: job.id },
      data: { status: "APPLYING", phase: "PRODUCTS" },
    });

    await Promise.all([
      jobs.advanceJob(shopify.admin, job.id),
      jobs.advanceJob(shopify.admin, job.id),
      jobs.advanceJob(shopify.admin, job.id),
    ]);
    expect(shopify.started.filter((s) => s === "products")).toHaveLength(1);

    // The webhook path finds the job by its current bulk operation id and advances it.
    for (let i = 0; i < 6; i++) {
      const { bulkOperationId } = await prisma.bulkJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      if (bulkOperationId)
        await jobs.advanceJobForBulkOperation(
          shopify.admin,
          SHOP,
          bulkOperationId,
        );
    }
    const after = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(after.status).toBe("COMPLETED");
    expect(shopify.started).toEqual(["products", "variants"]);
  });

  it("blocks a second job from applying while one is running", async () => {
    const a = await jobs.createEditorJob(shopify.admin, SHOP, "A", SALE_SPEC);
    const b = await jobs.createEditorJob(shopify.admin, SHOP, "B", SALE_SPEC);
    await runToEnd(a.id);
    await runToEnd(b.id);
    await jobs.applyJob(shopify.admin, SHOP, a.id);
    await expect(jobs.applyJob(shopify.admin, SHOP, b.id)).rejects.toThrow(
      /still being applied/,
    );
  });

  it("imports a Shopify-style CSV, matching by handle and SKU", async () => {
    const { rows } = mapTable([
      ["Handle", "Variant SKU", "Variant Price", "Tags Add", "Status"],
      ["classic-tee", "TEE-M", "25.00", "new-arrival", ""],
      ["hoodie", "", "45", "", "active"],
      ["no-such-product", "", "1", "", ""],
    ]);
    const job = await jobs.createCsvJob(shopify.admin, SHOP, "Import", {
      kind: "CSV",
      fileName: "products.csv",
      rows,
      collectionTitles: {},
    });
    const ready = await runToEnd(job.id);
    expect(ready.status).toBe("READY");
    expect(ready.productCount).toBe(2);
    expect(JSON.parse(ready.warnings)).toEqual([
      "Row 4: no product found for handle “no-such-product”",
    ]);

    await jobs.applyJob(shopify.admin, SHOP, job.id);
    expect((await runToEnd(job.id)).status).toBe("COMPLETED");
    expect(
      shopify.products.get("gid://shopify/Product/1")!.variants[1].price,
    ).toBe("25.00");
    expect(shopify.products.get("gid://shopify/Product/2")!.status).toBe(
      "ACTIVE",
    );
    expect(
      shopify.products.get("gid://shopify/Product/2")!.variants[0].price,
    ).toBe("45.00");
  });

  it("produces an empty plan when nothing would change", async () => {
    const job = await jobs.createEditorJob(shopify.admin, SHOP, "No-op", {
      ...SALE_SPEC,
      operations: { vendor: "Acme" },
    });
    const ready = await runToEnd(job.id);
    expect(ready.status).toBe("READY");
    expect(ready.productCount).toBe(0);
    await expect(jobs.applyJob(shopify.admin, SHOP, job.id)).rejects.toThrow(
      /isn't ready/,
    );
  });
});
