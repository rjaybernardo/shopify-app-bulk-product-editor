import type { ProductState } from "./types";

export type ChangeLine = { field: string; from: string; to: string };

const text = (html: string, max = 90) => {
  const plain = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max
    ? `${plain.slice(0, max - 1)}…`
    : plain || "(empty)";
};

const or = (v: string | null | undefined, empty = "(none)") => v || empty;

// Human-readable before → after lines for the preview and results tables.
export function describeChanges(
  before: ProductState,
  after: ProductState,
  collectionTitles: Record<string, string>,
): ChangeLine[] {
  const lines: ChangeLine[] = [];
  if (after.title !== undefined)
    lines.push({ field: "Title", from: or(before.title), to: or(after.title) });
  if (after.status !== undefined)
    lines.push({
      field: "Status",
      from: or(before.status).toLowerCase(),
      to: or(after.status).toLowerCase(),
    });
  if (after.vendor !== undefined)
    lines.push({
      field: "Vendor",
      from: or(before.vendor),
      to: or(after.vendor),
    });
  if (after.productType !== undefined)
    lines.push({
      field: "Product type",
      from: or(before.productType),
      to: or(after.productType),
    });
  if (after.tags !== undefined) {
    const was = new Set((before.tags ?? []).map((t) => t.toLowerCase()));
    const now = new Set(after.tags.map((t) => t.toLowerCase()));
    const added = after.tags.filter((t) => !was.has(t.toLowerCase()));
    const removed = (before.tags ?? []).filter(
      (t) => !now.has(t.toLowerCase()),
    );
    lines.push({
      field: "Tags",
      from: removed.length ? `− ${removed.join(", ")}` : "",
      to: added.length ? `+ ${added.join(", ")}` : "",
    });
  }
  if (after.descriptionHtml !== undefined)
    lines.push({
      field: "Description",
      from: text(before.descriptionHtml ?? ""),
      to: text(after.descriptionHtml),
    });
  for (const v of after.variants ?? []) {
    const b = before.variants?.find((x) => x.id === v.id);
    const label = v.title && v.title !== "Default Title" ? ` · ${v.title}` : "";
    if (v.price !== undefined)
      lines.push({ field: `Price${label}`, from: or(b?.price), to: v.price });
    if (v.compareAtPrice !== undefined)
      lines.push({
        field: `Compare-at${label}`,
        from: or(b?.compareAtPrice),
        to: or(v.compareAtPrice),
      });
  }
  for (const [id, member] of Object.entries(after.collections ?? {})) {
    const name = collectionTitles[id] ?? id.split("/").pop()!;
    lines.push({
      field: "Collection",
      from: member ? "" : name,
      to: member ? `+ ${name}` : `− removed`,
    });
  }
  return lines;
}
