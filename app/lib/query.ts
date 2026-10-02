// Builds a Shopify product search query from the editor's filter fields.
// Status is always explicit: the products search can default to active products only.

export const ALL_STATUSES = "active,draft,archived,unlisted";

export type ProductFilter = {
  text: string;
  status: string; // "" = any, or active | draft | archived
  vendor: string;
  productType: string;
  tag: string;
  collectionId: string;
};

export const EMPTY_FILTER: ProductFilter = {
  text: "",
  status: "",
  vendor: "",
  productType: "",
  tag: "",
  collectionId: "",
};

const quote = (v: string) => (/[\s:"'()\\]/.test(v) ? JSON.stringify(v) : v);

export function buildProductQuery(f: ProductFilter): string {
  const parts: string[] = [];
  if (f.text.trim()) parts.push(`(${f.text.trim()})`);
  parts.push(`status:${f.status || ALL_STATUSES}`);
  if (f.vendor.trim()) parts.push(`vendor:${quote(f.vendor.trim())}`);
  if (f.productType.trim())
    parts.push(`product_type:${quote(f.productType.trim())}`);
  if (f.tag.trim()) parts.push(`tag:${quote(f.tag.trim())}`);
  if (f.collectionId)
    parts.push(`collection_id:${f.collectionId.split("/").pop()}`);
  return parts.join(" AND ");
}

export function idsQuery(ids: string[]): string {
  const list = ids.map((id) => `id:${id.split("/").pop()}`).join(" OR ");
  return `(${list}) AND status:${ALL_STATUSES}`;
}
