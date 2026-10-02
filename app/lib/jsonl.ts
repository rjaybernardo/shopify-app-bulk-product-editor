import type { ProductSnapshot, ProductStatus } from "./types";

type Line = Record<string, unknown> & { id?: string; __parentId?: string };

// Bulk query output is flat: one line per product, then child lines (variants, collections)
// pointing back with __parentId. Children always follow their parent, but we don't rely on it.
export function snapshotsFromJsonl(lines: Iterable<Line>): ProductSnapshot[] {
  const products = new Map<string, ProductSnapshot>();
  const orphans: Line[] = [];

  const attach = (line: Line) => {
    const parent = products.get(line.__parentId!);
    if (!parent) return false;
    if (line.id?.startsWith("gid://shopify/ProductVariant/")) {
      parent.variants.push({
        id: line.id,
        title: String(line.title ?? ""),
        sku: (line.sku as string) || null,
        price: String(line.price ?? "0"),
        compareAtPrice: (line.compareAtPrice as string | null) ?? null,
      });
    } else if (line.id?.startsWith("gid://shopify/Collection/")) {
      parent.collectionIds.push(line.id);
    }
    return true;
  };

  for (const line of lines) {
    if (line.__parentId) {
      if (!attach(line)) orphans.push(line);
      continue;
    }
    if (!line.id?.startsWith("gid://shopify/Product/")) continue;
    const media = line.featuredMedia as
      | { preview?: { image?: { url?: string } | null } | null }
      | null
      | undefined;
    products.set(line.id, {
      id: line.id,
      title: String(line.title ?? ""),
      handle: String(line.handle ?? ""),
      descriptionHtml: String(line.descriptionHtml ?? ""),
      vendor: String(line.vendor ?? ""),
      productType: String(line.productType ?? ""),
      status: (line.status as ProductStatus) ?? "ACTIVE",
      tags: (line.tags as string[]) ?? [],
      collectionIds: [],
      imageUrl: media?.preview?.image?.url ?? null,
      variants: [],
    });
  }
  orphans.forEach(attach);
  return [...products.values()];
}

export function* parseJsonl(text: string): Generator<Line> {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line) yield JSON.parse(line);
  }
}
