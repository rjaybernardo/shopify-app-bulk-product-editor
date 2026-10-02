import { splitTags, normalizeTags, toCents, fromCents } from "./plan";
import type { CsvRow, ProductSnapshot, ProductTarget } from "./types";

export const MAX_CSV_ROWS = 20000;

type Column = Exclude<keyof CsvRow, "row">;

// Header aliases, compared lowercase with non-alphanumerics stripped. Includes Shopify's own
// product export headers, so a merchant can export, edit in Excel and upload the same file.
const ALIASES: Record<string, Column> = {
  id: "id",
  productid: "id",
  handle: "handle",
  sku: "sku",
  variantsku: "sku",
  title: "title",
  bodyhtml: "descriptionHtml",
  body: "descriptionHtml",
  description: "descriptionHtml",
  descriptionhtml: "descriptionHtml",
  vendor: "vendor",
  type: "productType",
  producttype: "productType",
  status: "status",
  tags: "tags",
  tagsadd: "tagsAdd",
  addtags: "tagsAdd",
  tagsremove: "tagsRemove",
  removetags: "tagsRemove",
  price: "price",
  variantprice: "price",
  compareatprice: "compareAtPrice",
  variantcompareatprice: "compareAtPrice",
};

export const TEMPLATE_HEADERS = [
  "Handle",
  "Variant SKU",
  "Title",
  "Vendor",
  "Type",
  "Status",
  "Tags",
  "Tags Add",
  "Tags Remove",
  "Variant Price",
  "Variant Compare At Price",
  "Body (HTML)",
];

export const TEMPLATE_EXAMPLE = [
  "classic-tee",
  "TEE-BLK-M",
  "",
  "",
  "",
  "",
  "",
  "summer-sale",
  "",
  "18.00",
  "24.00",
  "",
];

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export function mapTable(table: unknown[][]): {
  rows: CsvRow[];
  mapped: string[];
  ignored: string[];
  errors: string[];
} {
  const [header = [], ...body] = table;
  const columns = header.map((h) => ALIASES[key(String(h ?? ""))]);
  const mapped = header.filter((_, i) => columns[i]).map(String);
  const ignored = header
    .filter((h, i) => !columns[i] && String(h ?? "").trim())
    .map(String);
  const errors: string[] = [];

  if (!columns.some((c) => c === "handle" || c === "sku" || c === "id")) {
    errors.push(
      "The file needs a Handle, Variant SKU or ID column to match products.",
    );
  }
  if (body.length > MAX_CSV_ROWS) {
    errors.push(`Files are limited to ${MAX_CSV_ROWS} rows.`);
  }

  const rows: CsvRow[] = [];
  body.forEach((cells, i) => {
    const row: CsvRow = { row: i + 2 };
    columns.forEach((col, c) => {
      if (!col) return;
      const raw = cells[c];
      const value = raw == null ? "" : String(raw).trim();
      if (value) row[col] = value;
    });
    if (Object.keys(row).length > 1) rows.push(row);
  });

  return { rows, mapped, ignored, errors };
}

const STATUS = new Set(["ACTIVE", "DRAFT", "ARCHIVED"]);

// Accepts "24.5", "$24.50", "1,299.00" (comma = thousands). Anything else is rejected rather
// than guessed, so a stray "abc" can never become a $0.00 price.
function price(value: string): string | null {
  const cleaned = value.replace(/[\s,$€£¥]/g, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? fromCents(toCents(cleaned)) : null;
}

// Match rows to the catalog snapshot and fold them into one desired state per product.
export function targetsFromCsv(
  snapshots: ProductSnapshot[],
  rows: CsvRow[],
): { targets: Map<string, ProductTarget>; warnings: string[] } {
  const byId = new Map(snapshots.map((p) => [p.id, p]));
  const byHandle = new Map(snapshots.map((p) => [p.handle.toLowerCase(), p]));
  const bySku = new Map<
    string,
    { product: ProductSnapshot; variantId: string }
  >();
  for (const p of snapshots) {
    for (const v of p.variants) {
      if (v.sku)
        bySku.set(v.sku.toLowerCase(), { product: p, variantId: v.id });
    }
  }

  const targets = new Map<string, ProductTarget>();
  const warnings: string[] = [];
  const warn = (row: number, msg: string) =>
    warnings.push(`Row ${row}: ${msg}`);

  for (const row of rows) {
    const skuHit = row.sku ? bySku.get(row.sku.toLowerCase()) : undefined;
    const id = row.id
      ? row.id.startsWith("gid://")
        ? row.id
        : `gid://shopify/Product/${row.id}`
      : undefined;
    const product =
      (id && byId.get(id)) ||
      (row.handle && byHandle.get(row.handle.toLowerCase())) ||
      skuHit?.product;

    if (!product) {
      warn(
        row.row,
        `no product found for ${row.handle ? `handle “${row.handle}”` : row.sku ? `SKU “${row.sku}”` : `ID ${row.id}`}`,
      );
      continue;
    }
    if (skuHit && skuHit.product.id !== product.id) {
      warn(row.row, `SKU “${row.sku}” belongs to a different product`);
      continue;
    }

    const t = targets.get(product.id) ?? {};
    targets.set(product.id, t);

    if (row.title) t.title = row.title;
    if (row.descriptionHtml) t.descriptionHtml = row.descriptionHtml;
    if (row.vendor) t.vendor = row.vendor;
    if (row.productType) t.productType = row.productType;
    if (row.status) {
      const s = row.status.toUpperCase();
      if (STATUS.has(s)) t.status = s as ProductTarget["status"];
      else
        warn(
          row.row,
          `status “${row.status}” must be active, draft or archived`,
        );
    }

    if (row.tags || row.tagsAdd || row.tagsRemove) {
      const base = row.tags ? splitTags(row.tags) : (t.tags ?? product.tags);
      const remove = new Set(
        splitTags(row.tagsRemove ?? "").map((x) => x.toLowerCase()),
      );
      t.tags = normalizeTags([
        ...base.filter((x) => !remove.has(x.toLowerCase())),
        ...splitTags(row.tagsAdd ?? ""),
      ]);
    }

    if (row.price || row.compareAtPrice) {
      const variantId =
        skuHit?.variantId ??
        (product.variants.length === 1 ? product.variants[0].id : undefined);
      if (!variantId) {
        warn(
          row.row,
          row.sku
            ? `SKU “${row.sku}” wasn't found on “${product.title}”`
            : `“${product.title}” has ${product.variants.length} variants; add a Variant SKU to set prices`,
        );
      } else {
        const v = ((t.variants ??= {})[variantId] ??= {});
        if (row.price) {
          const p = price(row.price);
          if (p) v.price = p;
          else warn(row.row, `price “${row.price}” isn't a valid amount`);
        }
        if (row.compareAtPrice) {
          if (/^(clear|none|-)$/i.test(row.compareAtPrice)) {
            v.compareAtPrice = null;
          } else {
            const p = price(row.compareAtPrice);
            if (p) v.compareAtPrice = p;
            else
              warn(
                row.row,
                `compare-at price “${row.compareAtPrice}” isn't a valid amount`,
              );
          }
        }
      }
    }
  }

  return { targets, warnings };
}
