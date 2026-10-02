// Shared shapes for snapshots, edit specs and job items. Pure types: safe to import on client and server.

export type ProductStatus = "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED";
export const EDITABLE_STATUSES = ["ACTIVE", "DRAFT", "ARCHIVED"] as const;

export type VariantSnapshot = {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
};

// A product as read from Shopify by the snapshot bulk query.
export type ProductSnapshot = {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string;
  vendor: string;
  productType: string;
  status: ProductStatus;
  tags: string[];
  collectionIds: string[];
  imageUrl: string | null;
  variants: VariantSnapshot[];
};

export type VariantState = {
  id: string;
  title: string;
  price?: string;
  compareAtPrice?: string | null;
};

// The subset of a product a job touches. A job item stores one of these as `before` and one as
// `after`, holding only fields that change, so applying `before` exactly undoes the job.
export type ProductState = {
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  status?: ProductStatus;
  tags?: string[];
  variants?: VariantState[];
  // collectionId -> is the product a member
  collections?: Record<string, boolean>;
};

// What a rule set or CSV row wants a product to look like. Unset = leave alone.
export type ProductTarget = Omit<ProductState, "variants"> & {
  variants?: Record<string, { price?: string; compareAtPrice?: string | null }>;
};

export type Selection =
  { mode: "filter"; query: string } | { mode: "ids"; ids: string[] };

export type PriceOp =
  "set" | "increase_pct" | "decrease_pct" | "increase_amt" | "decrease_amt";
export type Rounding = "none" | "99" | "95" | "whole";
export type CompareAtOp = "set" | "clear" | "from_price" | "pct_above";
export type DescriptionOp = "replace" | "append" | "prepend" | "set";

export type EditOperations = {
  price?: { op: PriceOp; value: number; rounding: Rounding };
  compareAt?: { op: CompareAtOp; value?: number };
  tags?: { add: string[]; remove: string[] };
  collections?: { add: string[]; remove: string[] };
  title?: { find?: string; replace?: string; prefix?: string; suffix?: string };
  description?: { op: DescriptionOp; find?: string; value: string };
  vendor?: string;
  productType?: string;
  status?: (typeof EDITABLE_STATUSES)[number];
};

export type EditorSpec = {
  kind: "EDITOR";
  selection: Selection;
  operations: EditOperations;
  collectionTitles: Record<string, string>;
};

// One spreadsheet row after header mapping. Empty cells are dropped, so every key present is a change.
export type CsvRow = {
  row: number;
  id?: string;
  handle?: string;
  sku?: string;
  title?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  status?: string;
  tags?: string;
  tagsAdd?: string;
  tagsRemove?: string;
  price?: string;
  compareAtPrice?: string;
};

export type CsvSpec = {
  kind: "CSV";
  fileName: string;
  rows: CsvRow[];
  collectionTitles: Record<string, string>;
};

export type RollbackSpec = {
  kind: "ROLLBACK";
  jobId: string;
  collectionTitles: Record<string, string>;
};

export type JobSpec = EditorSpec | CsvSpec | RollbackSpec;

export type PlannedItem = {
  productId: string;
  title: string;
  handle: string;
  imageUrl: string | null;
  before: ProductState;
  after: ProductState;
  changeCount: number;
};

export type JobStatus =
  | "SNAPSHOTTING"
  | "READY"
  | "APPLYING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "DISCARDED";

export const ACTIVE_STATUSES: JobStatus[] = ["SNAPSHOTTING", "APPLYING"];
