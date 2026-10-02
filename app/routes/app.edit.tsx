import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listCollections } from "../services/shopify-bulk.server";
import type { loader as previewLoader } from "./app.products-preview";
import { createEditorJob } from "../services/jobs.server";
import {
  COMPARE_AT_LABELS,
  DESCRIPTION_OP_LABELS,
  PRICE_OP_LABELS,
  ROUNDING_LABELS,
  validateOperations,
} from "../lib/operations";
import { splitTags } from "../lib/plan";
import {
  buildProductQuery,
  EMPTY_FILTER,
  type ProductFilter,
} from "../lib/query";
import type {
  CompareAtOp,
  DescriptionOp,
  EditOperations,
  EditorSpec,
  PriceOp,
  Rounding,
} from "../lib/types";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  return { collections: await listCollections(admin) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const { name, spec } = JSON.parse(String(form.get("payload"))) as {
    name: string;
    spec: EditorSpec;
  };

  const errors = validateOperations(spec.operations);
  if (spec.selection.mode === "ids" && !spec.selection.ids.length) {
    errors.push("Pick at least one product.");
  }
  if (spec.selection.mode === "ids" && spec.selection.ids.length > 500) {
    errors.push("Pick 500 products or fewer, or use a filter instead.");
  }
  if (errors.length) return { errors };

  try {
    const job = await createEditorJob(
      admin,
      session.shop,
      name.trim().slice(0, 120) || "Bulk edit",
      { ...spec, kind: "EDITOR" },
    );
    return redirect(`/app/jobs/${job.id}`);
  } catch (e) {
    return { errors: [(e as Error).message] };
  }
};

type Picked = { id: string; title: string };

export default function BulkEdit() {
  const { collections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const preview = useFetcher<typeof previewLoader>();

  const [name, setName] = useState("");
  const [mode, setMode] = useState<"filter" | "ids">("filter");
  const [filter, setFilter] = useState<ProductFilter>(EMPTY_FILTER);
  const [picked, setPicked] = useState<Picked[]>([]);

  const [priceOp, setPriceOp] = useState<PriceOp | "">("");
  const [priceValue, setPriceValue] = useState("");
  const [rounding, setRounding] = useState<Rounding>("none");
  const [compareOp, setCompareOp] = useState<CompareAtOp | "">("");
  const [compareValue, setCompareValue] = useState("");
  const [tagsAdd, setTagsAdd] = useState("");
  const [tagsRemove, setTagsRemove] = useState("");
  const [collAdd, setCollAdd] = useState<Picked[]>([]);
  const [collRemove, setCollRemove] = useState<Picked[]>([]);
  const [titleFind, setTitleFind] = useState("");
  const [titleReplace, setTitleReplace] = useState("");
  const [titlePrefix, setTitlePrefix] = useState("");
  const [titleSuffix, setTitleSuffix] = useState("");
  const [descOp, setDescOp] = useState<DescriptionOp | "">("");
  const [descFind, setDescFind] = useState("");
  const [descValue, setDescValue] = useState("");
  const [vendor, setVendor] = useState<string | null>(null);
  const [productType, setProductType] = useState<string | null>(null);
  const [status, setStatus] = useState<EditOperations["status"] | "">("");

  const query = useMemo(() => buildProductQuery(filter), [filter]);
  const collectionById = useMemo(
    () => new Map(collections.map((c) => [c.id, c])),
    [collections],
  );

  // Live match count, debounced while typing.
  useEffect(() => {
    if (mode !== "filter") return;
    const t = setTimeout(
      () =>
        preview.load(`/app/products-preview?q=${encodeURIComponent(query)}`),
      350,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode]);

  // A blank number must fail validation, not silently become 0 (NaN serializes to null).
  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const operations: EditOperations = {};
  if (priceOp)
    operations.price = { op: priceOp, value: num(priceValue), rounding };
  if (compareOp)
    operations.compareAt = {
      op: compareOp,
      ...(compareOp === "set" || compareOp === "pct_above"
        ? { value: num(compareValue) }
        : {}),
    };
  if (tagsAdd.trim() || tagsRemove.trim())
    operations.tags = {
      add: splitTags(tagsAdd),
      remove: splitTags(tagsRemove),
    };
  if (collAdd.length || collRemove.length)
    operations.collections = {
      add: collAdd.map((c) => c.id),
      remove: collRemove.map((c) => c.id),
    };
  if (titleFind || titlePrefix || titleSuffix)
    operations.title = {
      find: titleFind,
      replace: titleReplace,
      prefix: titlePrefix,
      suffix: titleSuffix,
    };
  if (descOp)
    operations.description = { op: descOp, find: descFind, value: descValue };
  if (vendor !== null) operations.vendor = vendor;
  if (productType !== null) operations.productType = productType;
  if (status) operations.status = status;

  const changeCount = Object.keys(operations).length;
  const submitting = navigation.state === "submitting";

  const pickProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      filter: { variants: false, draft: true, archived: true },
      selectionIds: picked.map((p) => ({ id: p.id })),
    });
    if (selected)
      setPicked(selected.map((p) => ({ id: p.id, title: p.title })));
  };

  const pickCollections = async (
    current: Picked[],
    set: (p: Picked[]) => void,
  ) => {
    const selected = await shopify.resourcePicker({
      type: "collection",
      multiple: true,
      action: "select",
      selectionIds: current.map((c) => ({ id: c.id })),
    });
    if (selected) set(selected.map((c) => ({ id: c.id, title: c.title })));
  };

  const onPreview = () => {
    const spec: EditorSpec = {
      kind: "EDITOR",
      selection:
        mode === "filter"
          ? { mode, query }
          : { mode, ids: picked.map((p) => p.id) },
      operations,
      collectionTitles: Object.fromEntries(
        [...collAdd, ...collRemove].map((c) => [c.id, c.title]),
      ),
    };
    submit({ payload: JSON.stringify({ name, spec }) }, { method: "post" });
  };

  const matchCount = preview.data
    ? `${preview.data.count}${preview.data.atLeast ? "+" : ""}`
    : "…";

  return (
    <s-page heading="New bulk edit" inlineSize="base">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={onPreview}
        disabled={!changeCount || submitting}
        {...(submitting ? { loading: true } : {})}
      >
        Preview changes
      </s-button>

      {actionData?.errors?.length ? (
        <s-banner tone="critical" heading="Fix these before previewing">
          <s-unordered-list>
            {actionData.errors.map((e) => (
              <s-list-item key={e}>{e}</s-list-item>
            ))}
          </s-unordered-list>
        </s-banner>
      ) : null}

      <s-section heading="1. Choose products">
        <s-stack gap="base">
          <s-select
            label="Products to edit"
            value={mode}
            onChange={(e) => setMode(e.currentTarget.value as "filter" | "ids")}
          >
            <s-option value="filter">All products matching a filter</s-option>
            <s-option value="ids">Products I pick</s-option>
          </s-select>

          {mode === "filter" ? (
            <>
              <s-search-field
                label="Search"
                placeholder="Title, SKU, barcode…"
                value={filter.text}
                onInput={(e) =>
                  setFilter({ ...filter, text: e.currentTarget.value })
                }
              />
              <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                <s-select
                  label="Status"
                  value={filter.status}
                  onChange={(e) =>
                    setFilter({ ...filter, status: e.currentTarget.value })
                  }
                >
                  <s-option value="">Any status</s-option>
                  <s-option value="active">Active</s-option>
                  <s-option value="draft">Draft</s-option>
                  <s-option value="archived">Archived</s-option>
                </s-select>
                <s-select
                  label="Collection"
                  value={filter.collectionId}
                  onChange={(e) =>
                    setFilter({
                      ...filter,
                      collectionId: e.currentTarget.value,
                    })
                  }
                >
                  <s-option value="">Any collection</s-option>
                  {collections.map((c) => (
                    <s-option key={c.id} value={c.id}>
                      {c.title}
                    </s-option>
                  ))}
                </s-select>
                <s-text-field
                  label="Vendor"
                  value={filter.vendor}
                  onInput={(e) =>
                    setFilter({ ...filter, vendor: e.currentTarget.value })
                  }
                />
                <s-text-field
                  label="Product type"
                  value={filter.productType}
                  onInput={(e) =>
                    setFilter({ ...filter, productType: e.currentTarget.value })
                  }
                />
                <s-text-field
                  label="Tag"
                  value={filter.tag}
                  onInput={(e) =>
                    setFilter({ ...filter, tag: e.currentTarget.value })
                  }
                />
              </s-grid>
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-stack gap="small-200">
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    alignItems="center"
                  >
                    <s-text type="strong">{matchCount} products match</s-text>
                    {preview.state === "loading" && (
                      <s-spinner size="base" accessibilityLabel="Counting" />
                    )}
                  </s-stack>
                  {preview.data?.products.map((p) => (
                    <s-stack
                      key={p.id}
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-thumbnail
                        size="small-200"
                        alt={p.title}
                        src={p.imageUrl ?? undefined}
                      />
                      <s-text>{p.title}</s-text>
                      <s-text color="subdued">
                        {p.variants} variant{p.variants === 1 ? "" : "s"} ·{" "}
                        {p.status.toLowerCase()}
                      </s-text>
                    </s-stack>
                  ))}
                  <s-text color="subdued">
                    <code>{query}</code>
                  </s-text>
                </s-stack>
              </s-box>
            </>
          ) : (
            <s-stack gap="small-200">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button onClick={pickProducts}>
                  {picked.length ? "Change selection" : "Select products"}
                </s-button>
                <s-text color="subdued">{picked.length} selected</s-text>
              </s-stack>
              <s-stack direction="inline" gap="small-200">
                {picked.slice(0, 30).map((p) => (
                  <s-chip key={p.id}>{p.title}</s-chip>
                ))}
                {picked.length > 30 && (
                  <s-chip>+{picked.length - 30} more</s-chip>
                )}
              </s-stack>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      <s-section heading="2. Prices">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="2fr 1fr 1.4fr" gap="base">
            <s-select
              label="Price"
              value={priceOp}
              onChange={(e) =>
                setPriceOp(e.currentTarget.value as PriceOp | "")
              }
            >
              <s-option value="">No change</s-option>
              {Object.entries(PRICE_OP_LABELS).map(([k, v]) => (
                <s-option key={k} value={k}>
                  {v}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              label={priceOp.endsWith("pct") ? "Percent" : "Amount"}
              value={priceValue}
              min={0}
              step={0.01}
              disabled={!priceOp}
              onInput={(e) => setPriceValue(e.currentTarget.value)}
            />
            <s-select
              label="Rounding"
              value={rounding}
              disabled={!priceOp}
              onChange={(e) => setRounding(e.currentTarget.value as Rounding)}
            >
              {Object.entries(ROUNDING_LABELS).map(([k, v]) => (
                <s-option key={k} value={k}>
                  {v}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-grid gridTemplateColumns="2fr 1fr" gap="base">
            <s-select
              label="Compare-at price"
              value={compareOp}
              onChange={(e) =>
                setCompareOp(e.currentTarget.value as CompareAtOp | "")
              }
            >
              <s-option value="">No change</s-option>
              {Object.entries(COMPARE_AT_LABELS).map(([k, v]) => (
                <s-option key={k} value={k}>
                  {v}
                </s-option>
              ))}
            </s-select>
            {(compareOp === "set" || compareOp === "pct_above") && (
              <s-number-field
                label={compareOp === "set" ? "Amount" : "Percent"}
                value={compareValue}
                min={0}
                step={0.01}
                onInput={(e) => setCompareValue(e.currentTarget.value)}
              />
            )}
          </s-grid>
          <s-text color="subdued">
            Applies to every variant. To run a sale, decrease the price and set
            compare-at to “use the current price”.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="3. Tags and collections">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field
              label="Add tags"
              details="Comma separated"
              value={tagsAdd}
              onInput={(e) => setTagsAdd(e.currentTarget.value)}
            />
            <s-text-field
              label="Remove tags"
              details="Comma separated, not case sensitive"
              value={tagsRemove}
              onInput={(e) => setTagsRemove(e.currentTarget.value)}
            />
          </s-grid>
          {(
            [
              ["Add to collections", collAdd, setCollAdd],
              ["Remove from collections", collRemove, setCollRemove],
            ] as const
          ).map(([label, list, set]) => (
            <s-stack key={label} gap="small-200">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button onClick={() => pickCollections(list, set)}>
                  {label}
                </s-button>
                {list.map((c) => {
                  const info = collectionById.get(c.id);
                  return (
                    <s-clickable-chip
                      key={c.id}
                      removable
                      accessibilityLabel={`Remove ${c.title}`}
                      onRemove={() => set(list.filter((x) => x.id !== c.id))}
                    >
                      {c.title}
                      {info && !info.editable ? " (not editable)" : ""}
                      {info?.automated && label.startsWith("Remove")
                        ? " (automated)"
                        : ""}
                    </s-clickable-chip>
                  );
                })}
              </s-stack>
            </s-stack>
          ))}
          <s-text color="subdued">
            Products are added as manual picks. In collections with automated
            conditions, products that match the conditions stay in after a
            removal.
          </s-text>
        </s-stack>
      </s-section>

      <s-section heading="4. Title and description">
        <s-stack gap="base">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-text-field
              label="Find in title"
              value={titleFind}
              onInput={(e) => setTitleFind(e.currentTarget.value)}
            />
            <s-text-field
              label="Replace with"
              value={titleReplace}
              disabled={!titleFind}
              onInput={(e) => setTitleReplace(e.currentTarget.value)}
            />
            <s-text-field
              label="Add prefix"
              value={titlePrefix}
              onInput={(e) => setTitlePrefix(e.currentTarget.value)}
            />
            <s-text-field
              label="Add suffix"
              value={titleSuffix}
              onInput={(e) => setTitleSuffix(e.currentTarget.value)}
            />
          </s-grid>
          <s-select
            label="Description"
            value={descOp}
            onChange={(e) =>
              setDescOp(e.currentTarget.value as DescriptionOp | "")
            }
          >
            <s-option value="">No change</s-option>
            {Object.entries(DESCRIPTION_OP_LABELS).map(([k, v]) => (
              <s-option key={k} value={k}>
                {v}
              </s-option>
            ))}
          </s-select>
          {descOp === "replace" && (
            <s-text-field
              label="Find"
              value={descFind}
              onInput={(e) => setDescFind(e.currentTarget.value)}
            />
          )}
          {descOp && (
            <s-text-area
              label={descOp === "replace" ? "Replace with (HTML)" : "HTML"}
              rows={4}
              value={descValue}
              onInput={(e) => setDescValue(e.currentTarget.value)}
            />
          )}
        </s-stack>
      </s-section>

      <s-section heading="5. Organization">
        <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
          <s-stack gap="small-200">
            <s-checkbox
              label="Set vendor"
              checked={vendor !== null}
              onChange={(e) => setVendor(e.currentTarget.checked ? "" : null)}
            />
            {vendor !== null && (
              <s-text-field
                label="Vendor"
                labelAccessibilityVisibility="exclusive"
                value={vendor}
                onInput={(e) => setVendor(e.currentTarget.value)}
              />
            )}
          </s-stack>
          <s-stack gap="small-200">
            <s-checkbox
              label="Set product type"
              checked={productType !== null}
              onChange={(e) =>
                setProductType(e.currentTarget.checked ? "" : null)
              }
            />
            {productType !== null && (
              <s-text-field
                label="Product type"
                labelAccessibilityVisibility="exclusive"
                value={productType}
                onInput={(e) => setProductType(e.currentTarget.value)}
              />
            )}
          </s-stack>
          <s-select
            label="Status"
            value={status ?? ""}
            onChange={(e) =>
              setStatus(e.currentTarget.value as EditOperations["status"] | "")
            }
          >
            <s-option value="">No change</s-option>
            <s-option value="ACTIVE">Active</s-option>
            <s-option value="DRAFT">Draft</s-option>
            <s-option value="ARCHIVED">Archived</s-option>
          </s-select>
        </s-grid>
      </s-section>

      <s-section slot="aside" heading="Summary">
        <s-stack gap="base">
          <s-text-field
            label="Job name"
            placeholder="e.g. Summer sale 20% off"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
          <s-paragraph>
            {mode === "filter"
              ? `${matchCount} products`
              : `${picked.length} picked products`}{" "}
            · {changeCount} type{changeCount === 1 ? "" : "s"} of change
          </s-paragraph>
          <s-paragraph color="subdued">
            Nothing changes in your store yet. Next you&apos;ll see every before
            → after value and can apply, adjust or discard.
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
