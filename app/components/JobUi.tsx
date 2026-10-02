import type { ChangeLine } from "../lib/diff";

const STATUS: Record<
  string,
  {
    label: string;
    tone: "info" | "success" | "warning" | "critical" | "neutral" | "caution";
  }
> = {
  SNAPSHOTTING: { label: "Reading products", tone: "info" },
  READY: { label: "Ready to apply", tone: "caution" },
  APPLYING: { label: "Applying", tone: "info" },
  COMPLETED: { label: "Completed", tone: "success" },
  PARTIAL: { label: "Partly applied", tone: "warning" },
  FAILED: { label: "Failed", tone: "critical" },
  DISCARDED: { label: "Discarded", tone: "neutral" },
};

export function JobStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <s-badge tone={s.tone}>{s.label}</s-badge>;
}

export const SOURCE_LABELS: Record<string, string> = {
  EDITOR: "Bulk edit",
  CSV: "CSV import",
  ROLLBACK: "Undo",
};

// Polaris has no progress bar component, so this is a plain element styled with admin tokens.
export function ProgressBar({
  value,
  label,
}: {
  value: number;
  label: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        height: 8,
        borderRadius: 4,
        background: "var(--p-color-bg-fill-tertiary, #e3e3e3)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: "var(--p-color-bg-fill-brand, #303030)",
          transition: "width .4s ease",
        }}
      />
    </div>
  );
}

export function ChangeList({ lines }: { lines: ChangeLine[] }) {
  return (
    <s-stack gap="small-300">
      {lines.map((l, i) => (
        <s-stack key={i} direction="inline" gap="small-200" alignItems="center">
          <s-text type="strong">{l.field}</s-text>
          {l.from && (
            <s-text color="subdued">
              <s>{l.from}</s>
            </s-text>
          )}
          {l.from && l.to && <s-text color="subdued">→</s-text>}
          {l.to && <s-text>{l.to}</s-text>}
        </s-stack>
      ))}
    </s-stack>
  );
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${seconds % 60}s`;
}
