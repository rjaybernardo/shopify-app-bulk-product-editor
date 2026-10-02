import { fromCents, normalizeTags, toCents } from "./plan";
import type {
  EditOperations,
  ProductSnapshot,
  ProductTarget,
  Rounding,
} from "./types";

export const PRICE_OP_LABELS = {
  set: "Set to",
  increase_pct: "Increase by %",
  decrease_pct: "Decrease by %",
  increase_amt: "Increase by amount",
  decrease_amt: "Decrease by amount",
} as const;

export const ROUNDING_LABELS: Record<Rounding, string> = {
  none: "No rounding",
  "99": "Nearest .99",
  "95": "Nearest .95",
  whole: "Nearest whole number",
};

export const COMPARE_AT_LABELS = {
  set: "Set to",
  clear: "Remove compare-at price",
  from_price: "Use the current price (mark as sale)",
  pct_above: "Set % above the new price",
} as const;

export const DESCRIPTION_OP_LABELS = {
  replace: "Find and replace",
  append: "Add to the end",
  prepend: "Add to the start",
  set: "Replace entirely",
} as const;

// Move to the nearest price ending: 40.00 -> 39.99, 21.40 -> 20.99 (.95: 20.95), 21.60 -> 22.00 (whole).
// Ties go down, and a result is never below the smallest ending (0.99 / 0.95).
export function roundCents(cents: number, rounding: Rounding): number {
  if (rounding === "none") return cents;
  if (rounding === "whole") return Math.round(cents / 100) * 100;
  const ending = rounding === "99" ? 99 : 95;
  let below = Math.floor(cents / 100) * 100 + ending;
  if (below > cents) below -= 100;
  const above = below + 100;
  if (below < 0) return above;
  return cents - below <= above - cents ? below : above;
}

export function applyPrice(
  current: string,
  op: NonNullable<EditOperations["price"]>,
): string {
  const cents = toCents(current);
  let next: number;
  switch (op.op) {
    case "set":
      next = toCents(op.value);
      break;
    case "increase_pct":
      next = Math.round(cents * (1 + op.value / 100));
      break;
    case "decrease_pct":
      next = Math.round(cents * (1 - op.value / 100));
      break;
    case "increase_amt":
      next = cents + toCents(op.value);
      break;
    case "decrease_amt":
      next = cents - toCents(op.value);
      break;
  }
  return fromCents(roundCents(Math.max(0, next), op.rounding));
}

function replaceAll(text: string, find: string, replacement: string) {
  return find ? text.split(find).join(replacement) : text;
}

// Turn a rule set into the desired state for one product. diffProduct() later drops no-ops.
export function targetFromOperations(
  snap: ProductSnapshot,
  ops: EditOperations,
): ProductTarget {
  const target: ProductTarget = {};

  if (ops.title) {
    const { find, replace = "", prefix = "", suffix = "" } = ops.title;
    let title = find ? replaceAll(snap.title, find, replace) : snap.title;
    if (prefix && !title.startsWith(prefix)) title = prefix + title;
    if (suffix && !title.endsWith(suffix)) title = title + suffix;
    target.title = title.trim() || snap.title;
  }

  if (ops.description) {
    const { op, find = "", value } = ops.description;
    const html = snap.descriptionHtml;
    target.descriptionHtml =
      op === "replace"
        ? replaceAll(html, find, value)
        : op === "append"
          ? html + value
          : op === "prepend"
            ? value + html
            : value;
  }

  if (ops.vendor !== undefined) target.vendor = ops.vendor;
  if (ops.productType !== undefined) target.productType = ops.productType;
  if (ops.status) target.status = ops.status;

  if (ops.tags && (ops.tags.add.length || ops.tags.remove.length)) {
    const remove = new Set(ops.tags.remove.map((t) => t.trim().toLowerCase()));
    target.tags = normalizeTags([
      ...snap.tags.filter((t) => !remove.has(t.toLowerCase())),
      ...ops.tags.add,
    ]);
  }

  if (ops.collections) {
    const collections: Record<string, boolean> = {};
    for (const id of ops.collections.add) collections[id] = true;
    for (const id of ops.collections.remove) collections[id] = false;
    if (Object.keys(collections).length) target.collections = collections;
  }

  if (ops.price || ops.compareAt) {
    target.variants = {};
    for (const v of snap.variants) {
      const price = ops.price ? applyPrice(v.price, ops.price) : v.price;
      const change: { price?: string; compareAtPrice?: string | null } = {};
      if (ops.price) change.price = price;
      if (ops.compareAt) {
        const { op, value = 0 } = ops.compareAt;
        change.compareAtPrice =
          op === "clear"
            ? null
            : op === "set"
              ? fromCents(toCents(value))
              : op === "from_price"
                ? v.price
                : fromCents(Math.round(toCents(price) * (1 + value / 100)));
      }
      target.variants[v.id] = change;
    }
  }

  return target;
}

// Validate a rule set from the editor form before any API work happens.
export function validateOperations(ops: EditOperations): string[] {
  const errors: string[] = [];
  const num = (n: unknown) => typeof n === "number" && Number.isFinite(n);
  if (ops.price) {
    if (!num(ops.price.value) || ops.price.value < 0)
      errors.push("Enter a price value of 0 or more.");
    if (ops.price.op === "decrease_pct" && ops.price.value >= 100)
      errors.push("A percentage decrease must be below 100%.");
  }
  if (
    ops.compareAt &&
    ["set", "pct_above"].includes(ops.compareAt.op) &&
    (!num(ops.compareAt.value) || (ops.compareAt.value ?? 0) < 0)
  )
    errors.push("Enter a compare-at value of 0 or more.");
  if (ops.title && !ops.title.find && !ops.title.prefix && !ops.title.suffix)
    errors.push("Title: enter text to find, a prefix or a suffix.");
  if (ops.description?.op === "replace" && !ops.description.find)
    errors.push("Description: enter the text to find.");
  if (
    ops.description &&
    ops.description.op !== "replace" &&
    ops.description.op !== "set" &&
    !ops.description.value
  )
    errors.push("Description: enter the HTML to add.");
  if (ops.vendor !== undefined && !ops.vendor.trim())
    errors.push("Vendor can't be blank.");
  if (!Object.keys(ops).length) errors.push("Choose at least one change.");
  return errors;
}

export function describeOperations(
  ops: EditOperations,
  collectionTitles: Record<string, string>,
): string[] {
  const out: string[] = [];
  if (ops.price) {
    const v = ops.price.op.endsWith("pct")
      ? `${ops.price.value}%`
      : ops.price.value.toFixed(2);
    out.push(
      `Price: ${PRICE_OP_LABELS[ops.price.op].toLowerCase()} ${v}` +
        (ops.price.rounding !== "none"
          ? `, ${ROUNDING_LABELS[ops.price.rounding].toLowerCase()}`
          : ""),
    );
  }
  if (ops.compareAt) {
    const v =
      ops.compareAt.op === "set"
        ? ` ${ops.compareAt.value?.toFixed(2)}`
        : ops.compareAt.op === "pct_above"
          ? ` (${ops.compareAt.value}%)`
          : "";
    out.push(
      `Compare-at: ${COMPARE_AT_LABELS[ops.compareAt.op].toLowerCase()}${v}`,
    );
  }
  if (ops.tags?.add.length) out.push(`Add tags: ${ops.tags.add.join(", ")}`);
  if (ops.tags?.remove.length)
    out.push(`Remove tags: ${ops.tags.remove.join(", ")}`);
  const names = (ids: string[]) =>
    ids.map((id) => collectionTitles[id] ?? id).join(", ");
  if (ops.collections?.add.length)
    out.push(`Add to: ${names(ops.collections.add)}`);
  if (ops.collections?.remove.length)
    out.push(`Remove from: ${names(ops.collections.remove)}`);
  if (ops.title) {
    const t = ops.title;
    if (t.find)
      out.push(`Title: replace “${t.find}” with “${t.replace ?? ""}”`);
    if (t.prefix) out.push(`Title prefix: “${t.prefix}”`);
    if (t.suffix) out.push(`Title suffix: “${t.suffix}”`);
  }
  if (ops.description)
    out.push(
      `Description: ${DESCRIPTION_OP_LABELS[ops.description.op].toLowerCase()}`,
    );
  if (ops.vendor !== undefined) out.push(`Vendor: ${ops.vendor}`);
  if (ops.productType !== undefined)
    out.push(`Product type: ${ops.productType || "(none)"}`);
  if (ops.status) out.push(`Status: ${ops.status.toLowerCase()}`);
  return out;
}
