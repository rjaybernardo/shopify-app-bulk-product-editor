import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { useActionData, useNavigation, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import Papa from "papaparse";
import { authenticate } from "../shopify.server";
import { createCsvJob } from "../services/jobs.server";
import {
  MAX_CSV_ROWS,
  TEMPLATE_EXAMPLE,
  TEMPLATE_HEADERS,
  mapTable,
} from "../lib/csv";
import type { CsvRow } from "../lib/types";

const CSV_FIELDS = new Set<keyof CsvRow>([
  "row",
  "id",
  "handle",
  "sku",
  "title",
  "descriptionHtml",
  "vendor",
  "productType",
  "status",
  "tags",
  "tagsAdd",
  "tagsRemove",
  "price",
  "compareAtPrice",
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, redirect } = await authenticate.admin(request);
  const form = await request.formData();
  const fileName = String(form.get("fileName") || "upload.csv").slice(0, 200);
  const raw = JSON.parse(String(form.get("rows") || "[]")) as unknown[];

  if (!Array.isArray(raw) || !raw.length) {
    return { error: "The file has no rows with changes." };
  }
  if (raw.length > MAX_CSV_ROWS) {
    return { error: `Files are limited to ${MAX_CSV_ROWS} rows.` };
  }
  // Rows were mapped in the browser; keep only known string fields.
  const rows: CsvRow[] = raw.map((r, i) => {
    const row: CsvRow = { row: i + 2 };
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (!CSV_FIELDS.has(k as keyof CsvRow)) continue;
      if (k === "row") row.row = Number(v) || row.row;
      else if (typeof v === "string" && v)
        (row as Record<string, unknown>)[k] = v.slice(0, 65000);
    }
    return row;
  });

  try {
    const job = await createCsvJob(admin, session.shop, `Import: ${fileName}`, {
      kind: "CSV",
      fileName,
      rows,
      collectionTitles: {},
    });
    return redirect(`/app/jobs/${job.id}`);
  } catch (e) {
    return { error: (e as Error).message };
  }
};

type Parsed = {
  fileName: string;
  rows: CsvRow[];
  mapped: string[];
  ignored: string[];
  errors: string[];
};

async function readTable(file: File): Promise<unknown[][]> {
  if (/\.xlsx$/i.test(file.name)) {
    // Loaded on demand so the spreadsheet parser stays out of the main bundle.
    const { default: readXlsxFile } = await import("read-excel-file");
    return (await readXlsxFile(file)) as unknown[][];
  }
  const text = await file.text();
  const result = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  return result.data;
}

function downloadTemplate() {
  const csv = Papa.unparse([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE]);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "bulk-edit-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export default function Import() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const onFile = async (file: File | undefined) => {
    setParsed(null);
    setReadError(null);
    if (!file) return;
    setReading(true);
    try {
      const table = await readTable(file);
      setParsed({ fileName: file.name, ...mapTable(table) });
    } catch (e) {
      setReadError(`Couldn't read ${file.name}: ${(e as Error).message}`);
    } finally {
      setReading(false);
    }
  };

  const canImport = parsed && !parsed.errors.length && parsed.rows.length > 0;
  const submitting = navigation.state === "submitting";

  return (
    <s-page heading="Import from CSV or Excel" inlineSize="base">
      <s-button
        slot="primary-action"
        variant="primary"
        disabled={!canImport || submitting}
        {...(submitting ? { loading: true } : {})}
        onClick={() =>
          parsed &&
          submit(
            { fileName: parsed.fileName, rows: JSON.stringify(parsed.rows) },
            { method: "post" },
          )
        }
      >
        Preview changes
      </s-button>
      <s-button slot="secondary-actions" onClick={downloadTemplate}>
        Download template
      </s-button>

      {(actionData?.error || readError) && (
        <s-banner tone="critical">{actionData?.error ?? readError}</s-banner>
      )}

      <s-section heading="Upload a file">
        <s-stack gap="base">
          <s-drop-zone
            label="CSV or Excel file"
            accept=".csv,.tsv,.txt,.xlsx"
            accessibilityLabel="Upload a CSV, TSV or Excel file"
            onChange={(e) => {
              const files = (e.currentTarget as unknown as { files?: File[] })
                .files;
              onFile(files?.[0]);
            }}
          />
          {reading && <s-spinner accessibilityLabel="Reading file" />}
          <s-paragraph color="subdued">
            Export products from Shopify (Products → Export), edit them in Excel
            or Google Sheets, and upload the file here. Only columns you fill in
            change; blank cells are left alone.
          </s-paragraph>
        </s-stack>
      </s-section>

      {parsed && (
        <s-section heading={parsed.fileName}>
          <s-stack gap="base">
            {parsed.errors.map((e) => (
              <s-banner key={e} tone="critical">
                {e}
              </s-banner>
            ))}
            <s-stack direction="inline" gap="large">
              <s-stack gap="small-100">
                <s-text color="subdued">Rows with changes</s-text>
                <s-heading>{parsed.rows.length}</s-heading>
              </s-stack>
              <s-stack gap="small-100">
                <s-text color="subdued">Columns used</s-text>
                <s-heading>{parsed.mapped.length}</s-heading>
              </s-stack>
            </s-stack>
            <s-stack direction="inline" gap="small-200">
              {parsed.mapped.map((c) => (
                <s-badge key={c} tone="success">
                  {c}
                </s-badge>
              ))}
              {parsed.ignored.map((c) => (
                <s-badge key={c} tone="neutral">
                  {c} · ignored
                </s-badge>
              ))}
            </s-stack>
            <s-paragraph color="subdued">
              Next, the app reads your catalog, matches each row by handle, SKU
              or ID, and shows every change before anything is saved.
            </s-paragraph>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Supported columns">
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">Handle</s-text>,{" "}
            <s-text type="strong">Variant SKU</s-text> or{" "}
            <s-text type="strong">ID</s-text> to match products
          </s-list-item>
          <s-list-item>Title, Body (HTML), Vendor, Type, Status</s-list-item>
          <s-list-item>Tags (replaces all), Tags Add, Tags Remove</s-list-item>
          <s-list-item>
            Variant Price, Variant Compare At Price (write “clear” to remove)
          </s-list-item>
        </s-unordered-list>
        <s-paragraph color="subdued">
          Prices are matched to a variant by SKU. Products with one variant
          don&apos;t need a SKU.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
