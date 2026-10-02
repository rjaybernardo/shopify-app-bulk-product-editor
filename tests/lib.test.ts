import { describe, expect, it } from "vitest";
import {
  applyPrice,
  targetFromOperations,
  validateOperations,
} from "../app/lib/operations";
import {
  diffProduct,
  productUpdateInput,
  variantsUpdateInput,
} from "../app/lib/plan";
import { mapTable, targetsFromCsv } from "../app/lib/csv";
import { parseJsonl, snapshotsFromJsonl } from "../app/lib/jsonl";
import { describeChanges } from "../app/lib/diff";
import { buildProductQuery, EMPTY_FILTER } from "../app/lib/query";
import { resultErrorsByLine } from "../app/services/jobs.server";
import type { ProductSnapshot } from "../app/lib/types";

const tee: ProductSnapshot = {
  id: "gid://shopify/Product/1",
  title: "Classic Tee",
  handle: "classic-tee",
  descriptionHtml: "<p>Soft cotton tee.</p>",
  vendor: "Acme",
  productType: "Shirts",
  status: "ACTIVE",
  tags: ["cotton", "Summer"],
  collectionIds: ["gid://shopify/Collection/10"],
  imageUrl: null,
  variants: [
    {
      id: "gid://shopify/ProductVariant/11",
      title: "S",
      sku: "TEE-S",
      price: "19.99",
      compareAtPrice: null,
    },
    {
      id: "gid://shopify/ProductVariant/12",
      title: "M",
      sku: "TEE-M",
      price: "21.40",
      compareAtPrice: "30.00",
    },
  ],
};

describe("price math", () => {
  it("works in cents, not floats", () => {
    expect(
      applyPrice("19.99", { op: "increase_pct", value: 10, rounding: "none" }),
    ).toBe("21.99");
    expect(
      applyPrice("0.10", { op: "increase_amt", value: 0.2, rounding: "none" }),
    ).toBe("0.30");
  });
  it("rounds to the nearest price ending", () => {
    const at = (price: string, rounding: "99" | "95" | "whole") =>
      applyPrice(price, { op: "set", value: Number(price), rounding });
    expect(at("40.00", "99")).toBe("39.99");
    expect(at("21.40", "99")).toBe("20.99");
    expect(at("21.60", "99")).toBe("21.99");
    expect(at("21.40", "95")).toBe("20.95");
    expect(at("21.60", "whole")).toBe("22.00");
    expect(at("0.20", "99")).toBe("0.99"); // never rounds to a negative price
  });
  it("never goes below zero", () => {
    expect(
      applyPrice("5.00", { op: "decrease_amt", value: 10, rounding: "none" }),
    ).toBe("0.00");
  });
});

describe("rule engine", () => {
  it("builds a sale: price -20%, compare-at = old price", () => {
    const target = targetFromOperations(tee, {
      price: { op: "decrease_pct", value: 20, rounding: "99" },
      compareAt: { op: "from_price" },
    });
    expect(target.variants).toEqual({
      "gid://shopify/ProductVariant/11": {
        price: "15.99",
        compareAtPrice: "19.99",
      },
      "gid://shopify/ProductVariant/12": {
        price: "16.99",
        compareAtPrice: "21.40",
      },
    });
  });

  it("adds and removes tags case-insensitively and skips duplicates", () => {
    const target = targetFromOperations(tee, {
      tags: { add: ["sale", "COTTON"], remove: ["summer"] },
    });
    expect(target.tags).toEqual(["cotton", "sale"]);
  });

  it("does not stack a suffix that's already there", () => {
    const once = targetFromOperations(tee, { title: { suffix: " – Organic" } });
    expect(once.title).toBe("Classic Tee – Organic");
    const again = targetFromOperations(
      { ...tee, title: once.title! },
      { title: { suffix: " – Organic" } },
    );
    expect(diffProduct({ ...tee, title: once.title! }, again)).toBeNull();
  });

  it("rejects blank or impossible values", () => {
    expect(
      validateOperations({
        price: { op: "set", value: NaN, rounding: "none" },
      }),
    ).not.toEqual([]);
    expect(
      validateOperations({
        price: { op: "decrease_pct", value: 100, rounding: "none" },
      }),
    ).not.toEqual([]);
    expect(validateOperations({})).toEqual(["Choose at least one change."]);
  });
});

describe("diff", () => {
  it("keeps only real changes and records exact before values", () => {
    const item = diffProduct(tee, {
      vendor: "Acme",
      tags: ["summer", "cotton"],
      variants: {
        "gid://shopify/ProductVariant/12": {
          price: "21.4",
          compareAtPrice: null,
        },
      },
      collections: {
        "gid://shopify/Collection/10": true,
        "gid://shopify/Collection/20": true,
      },
    })!;
    expect(item.changeCount).toBe(2);
    expect(item.before).toEqual({
      variants: [
        {
          id: "gid://shopify/ProductVariant/12",
          title: "M",
          compareAtPrice: "30.00",
        },
      ],
      collections: { "gid://shopify/Collection/20": false },
    });
    expect(item.after.variants?.[0]).toEqual({
      id: "gid://shopify/ProductVariant/12",
      title: "M",
      compareAtPrice: null,
    });
  });

  it("splits a state into the two bulk mutation inputs", () => {
    const state = {
      title: "X",
      tags: ["a"],
      variants: [{ id: "v1", title: "", price: "1.00" }],
    };
    expect(productUpdateInput("p1", state)).toEqual({
      product: { id: "p1", title: "X", tags: ["a"] },
    });
    expect(variantsUpdateInput("p1", state)).toEqual({
      productId: "p1",
      variants: [{ id: "v1", price: "1.00" }],
    });
    expect(productUpdateInput("p1", { variants: state.variants })).toBeNull();
  });

  it("describes changes for the preview", () => {
    const lines = describeChanges(
      { tags: ["a", "b"], variants: [{ id: "v", title: "M", price: "10.00" }] },
      { tags: ["a", "c"], variants: [{ id: "v", title: "M", price: "12.00" }] },
      {},
    );
    expect(lines).toEqual([
      { field: "Tags", from: "− b", to: "+ c" },
      { field: "Price · M", from: "10.00", to: "12.00" },
    ]);
  });
});

describe("CSV import", () => {
  it("maps Shopify export headers and ignores the rest", () => {
    const { rows, mapped, ignored, errors } = mapTable([
      [
        "Handle",
        "Title",
        "Variant SKU",
        "Variant Price",
        "Option1 Value",
        "Tags",
      ],
      ["classic-tee", "", "TEE-M", "24.00", "M", ""],
      ["", "", "", "", "", ""],
    ]);
    expect(errors).toEqual([]);
    expect(mapped).toEqual([
      "Handle",
      "Title",
      "Variant SKU",
      "Variant Price",
      "Tags",
    ]);
    expect(ignored).toEqual(["Option1 Value"]);
    expect(rows).toEqual([
      { row: 2, handle: "classic-tee", sku: "TEE-M", price: "24.00" },
    ]);
  });

  it("requires a column to match on", () => {
    expect(mapTable([["Title"], ["x"]]).errors[0]).toMatch(
      /Handle, Variant SKU or ID/,
    );
  });

  it("matches by handle and SKU and reports problems per row", () => {
    const { targets, warnings } = targetsFromCsv(
      [tee],
      [
        { row: 2, handle: "classic-tee", tagsAdd: "sale", status: "draft" },
        { row: 3, sku: "tee-m", price: "$24.50", compareAtPrice: "clear" },
        { row: 4, handle: "classic-tee", price: "20" },
        { row: 5, handle: "missing" },
        { row: 6, handle: "classic-tee", sku: "NOPE", price: "1" },
        { row: 7, sku: "TEE-S", price: "abc" },
        { row: 8, sku: "TEE-S", compareAtPrice: "1,299.00" },
      ],
    );
    expect(targets.get(tee.id)).toEqual({
      tags: ["cotton", "Summer", "sale"],
      status: "DRAFT",
      variants: {
        "gid://shopify/ProductVariant/12": {
          price: "24.50",
          compareAtPrice: null,
        },
        "gid://shopify/ProductVariant/11": { compareAtPrice: "1299.00" },
      },
    });
    expect(warnings).toEqual([
      "Row 4: “Classic Tee” has 2 variants; add a Variant SKU to set prices",
      "Row 5: no product found for handle “missing”",
      "Row 6: SKU “NOPE” wasn't found on “Classic Tee”",
      "Row 7: price “abc” isn't a valid amount",
    ]);
  });
});

describe("bulk JSONL", () => {
  it("rebuilds products from flat bulk query output, in any order", () => {
    const text = [
      `{"id":"gid://shopify/ProductVariant/11","title":"S","sku":"TEE-S","price":"19.99","compareAtPrice":null,"__parentId":"gid://shopify/Product/1"}`,
      `{"id":"gid://shopify/Product/1","title":"Classic Tee","handle":"classic-tee","descriptionHtml":"","vendor":"Acme","productType":"","status":"DRAFT","tags":["a"],"featuredMedia":null}`,
      `{"id":"gid://shopify/Collection/10","__parentId":"gid://shopify/Product/1"}`,
    ].join("\n");
    const [p] = snapshotsFromJsonl(parseJsonl(text));
    expect(p.status).toBe("DRAFT");
    expect(p.collectionIds).toEqual(["gid://shopify/Collection/10"]);
    expect(p.variants.map((v) => v.sku)).toEqual(["TEE-S"]);
  });

  it("maps bulk mutation results back to lines", () => {
    const results = resultErrorsByLine(
      [
        `{"data":{"productUpdate":{"product":{"id":"p1"},"userErrors":[]}},"__lineNumber":0}`,
        `{"data":{"productUpdate":{"product":null,"userErrors":[{"field":["title"],"message":"Title can't be blank"}]}},"__lineNumber":1}`,
        `{"errors":[{"message":"Throttled"}],"__lineNumber":2}`,
      ].join("\n"),
    );
    expect([...results]).toEqual([
      [0, null],
      [1, "Title can't be blank"],
      [2, "Throttled"],
    ]);
  });
});

describe("filter query", () => {
  it("always states the status so drafts aren't dropped by default", () => {
    expect(buildProductQuery(EMPTY_FILTER)).toBe(
      "status:active,draft,archived,unlisted",
    );
    expect(
      buildProductQuery({
        ...EMPTY_FILTER,
        text: "tee",
        tag: "summer sale",
        collectionId: "gid://shopify/Collection/42",
      }),
    ).toBe(
      '(tee) AND status:active,draft,archived,unlisted AND tag:"summer sale" AND collection_id:42',
    );
  });
});
