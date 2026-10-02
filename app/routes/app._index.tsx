import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  MANUAL_SECONDS_PER_CHANGE,
  getDashboard,
} from "../services/jobs.server";
import {
  JobStatusBadge,
  SOURCE_LABELS,
  formatDuration,
} from "../components/JobUi";

const RANGES = [7, 30, 90];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const days = Number(new URL(request.url).searchParams.get("days"));
  const range = RANGES.includes(days) ? days : 30;
  const stats = await getDashboard(session.shop, range);
  return {
    range,
    ...stats,
    secondsPerChange: MANUAL_SECONDS_PER_CHANGE,
    recent: stats.recent.map((j) => ({
      id: j.id,
      name: j.name,
      source: j.source,
      status: j.status,
      products: j.productCount,
      createdAt: j.createdAt.toISOString(),
    })),
  };
};

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const tiles = [
    { label: "Jobs run", value: data.jobs.toLocaleString() },
    { label: "Products updated", value: data.products.toLocaleString() },
    { label: "Field changes", value: data.changes.toLocaleString() },
    {
      label: "Time saved (est.)",
      value: `${data.hoursSaved} h`,
      help: `At ${data.secondsPerChange}s per change made by hand`,
    },
    {
      label: "Median job time",
      value:
        data.medianSeconds === null ? "—" : formatDuration(data.medianSeconds),
    },
  ];

  return (
    <s-page heading="Bulk Product Editor" inlineSize="large">
      <s-button slot="primary-action" variant="primary" href="/app/edit">
        New bulk edit
      </s-button>
      <s-button slot="secondary-actions" href="/app/import">
        Import CSV
      </s-button>

      <s-section>
        <s-stack gap="base">
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="center"
          >
            <s-heading>Last {data.range} days</s-heading>
            <s-select
              label="Range"
              labelAccessibilityVisibility="exclusive"
              value={String(data.range)}
              onChange={(e) => {
                const next = new URLSearchParams(params);
                next.set("days", e.currentTarget.value);
                navigate(`?${next.toString()}`);
              }}
            >
              {RANGES.map((r) => (
                <s-option key={r} value={String(r)}>
                  Last {r} days
                </s-option>
              ))}
            </s-select>
          </s-stack>
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(150px, 1fr))"
            gap="base"
          >
            {tiles.map((t) => (
              <s-box
                key={t.label}
                padding="base"
                background="subdued"
                borderRadius="base"
              >
                <s-stack gap="small-100">
                  <s-text color="subdued">{t.label}</s-text>
                  <s-heading>{t.value}</s-heading>
                  {t.help && <s-text color="subdued">{t.help}</s-text>}
                </s-stack>
              </s-box>
            ))}
          </s-grid>
        </s-stack>
      </s-section>

      <s-section heading="Recent jobs">
        {data.recent.length ? (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Job</s-table-header>
              <s-table-header listSlot="secondary">Type</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header format="numeric">Products</s-table-header>
              <s-table-header listSlot="kicker">Created</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.recent.map((j) => (
                <s-table-row key={j.id}>
                  <s-table-cell>
                    <s-link href={`/app/jobs/${j.id}`}>{j.name}</s-link>
                  </s-table-cell>
                  <s-table-cell>{SOURCE_LABELS[j.source]}</s-table-cell>
                  <s-table-cell>
                    <JobStatusBadge status={j.status} />
                  </s-table-cell>
                  <s-table-cell>{j.products.toLocaleString()}</s-table-cell>
                  <s-table-cell>
                    {new Date(j.createdAt).toLocaleString()}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        ) : (
          <s-stack gap="base">
            <s-paragraph>
              Change prices, tags, collections, titles, descriptions and status
              for hundreds of products at once. Every change is previewed first
              and can be undone.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" href="/app/edit">
                Start a bulk edit
              </s-button>
              <s-button href="/app/import">Import a spreadsheet</s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-ordered-list>
          <s-list-item>
            Choose products by filter, by picking, or with a spreadsheet.
          </s-list-item>
          <s-list-item>
            A bulk query reads them; you review every before → after value.
          </s-list-item>
          <s-list-item>
            Bulk mutations apply the changes. Progress updates live.
          </s-list-item>
          <s-list-item>
            Undo restores the saved original values in one click.
          </s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
