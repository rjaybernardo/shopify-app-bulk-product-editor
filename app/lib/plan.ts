import type {
  PlannedItem,
  ProductSnapshot,
  ProductState,
  ProductTarget,
  VariantState,
} from "./types";

// Money is handled in integer cents so "19.99 + 10%" never becomes 21.988999999.
export function toCents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

export function fromCents(cents: number): string {
  return (Math.max(0, cents) / 100).toFixed(2);
}

export function samePrice(a: string | null | undefined, b: string | null) {
  if (a == null || b == null) return a == b;
  return toCents(a) === toCents(b);
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

export function splitTags(value: string): string[] {
  return normalizeTags(value.split(","));
}

function sameTags(a: string[], b: string[]) {
  const key = (t: string[]) =>
    normalizeTags(t)
      .map((s) => s.toLowerCase())
      .sort()
      .join("\u0000");
  return key(a) === key(b);
}

const SCALAR_FIELDS = [
  "title",
  "descriptionHtml",
  "vendor",
  "productType",
  "status",
] as const;

// Compare a desired state with the snapshot and keep only real differences.
// Returns null when the target would not change the product at all.
export function diffProduct(
  snap: ProductSnapshot,
  target: ProductTarget,
): PlannedItem | null {
  const before: ProductState = {};
  const after: ProductState = {};
  let changeCount = 0;

  for (const field of SCALAR_FIELDS) {
    const next = target[field];
    if (next !== undefined && next !== snap[field]) {
      (before as Record<string, unknown>)[field] = snap[field];
      (after as Record<string, unknown>)[field] = next;
      changeCount++;
    }
  }

  if (target.tags && !sameTags(target.tags, snap.tags)) {
    before.tags = snap.tags;
    after.tags = normalizeTags(target.tags);
    changeCount++;
  }

  if (target.variants) {
    const beforeVariants: VariantState[] = [];
    const afterVariants: VariantState[] = [];
    for (const v of snap.variants) {
      const t = target.variants[v.id];
      if (!t) continue;
      const b: VariantState = { id: v.id, title: v.title };
      const a: VariantState = { id: v.id, title: v.title };
      if (t.price !== undefined && !samePrice(t.price, v.price)) {
        b.price = v.price;
        a.price = fromCents(toCents(t.price));
        changeCount++;
      }
      if (
        t.compareAtPrice !== undefined &&
        !samePrice(t.compareAtPrice, v.compareAtPrice)
      ) {
        b.compareAtPrice = v.compareAtPrice;
        a.compareAtPrice =
          t.compareAtPrice == null
            ? null
            : fromCents(toCents(t.compareAtPrice));
        changeCount++;
      }
      if ("price" in a || "compareAtPrice" in a) {
        beforeVariants.push(b);
        afterVariants.push(a);
      }
    }
    if (afterVariants.length) {
      before.variants = beforeVariants;
      after.variants = afterVariants;
    }
  }

  if (target.collections) {
    const member = new Set(snap.collectionIds);
    for (const [id, want] of Object.entries(target.collections)) {
      if (member.has(id) !== want) {
        (before.collections ??= {})[id] = !want;
        (after.collections ??= {})[id] = want;
        changeCount++;
      }
    }
  }

  if (!changeCount) return null;
  return {
    productId: snap.id,
    title: snap.title,
    handle: snap.handle,
    imageUrl: snap.imageUrl,
    before,
    after,
    changeCount,
  };
}

// --- Bulk mutation inputs -----------------------------------------------------------------

export function productUpdateInput(id: string, state: ProductState) {
  const product: Record<string, unknown> = { id };
  for (const field of [...SCALAR_FIELDS, "tags"] as const) {
    if (state[field] !== undefined) product[field] = state[field];
  }
  return Object.keys(product).length > 1 ? { product } : null;
}

export function variantsUpdateInput(productId: string, state: ProductState) {
  if (!state.variants?.length) return null;
  return {
    productId,
    variants: state.variants.map((v) => ({
      id: v.id,
      ...(v.price !== undefined ? { price: v.price } : {}),
      ...(v.compareAtPrice !== undefined
        ? { compareAtPrice: v.compareAtPrice }
        : {}),
    })),
  };
}
