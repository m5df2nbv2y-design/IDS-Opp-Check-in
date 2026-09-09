import type { ReactNode } from "react";
import { brand } from "@/lib/brand";
import type { RecipientStatus } from "@/server/services/campaign-service";

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return <Tag className={`rounded-card border border-line bg-surface ${className}`}>{children}</Tag>;
}

export function Wordmark({ subdued = false }: { subdued?: boolean }) {
  return (
    <span
      className={`text-[13px] font-bold uppercase tracking-[0.16em] ${subdued ? "text-muted" : "text-brand"}`}
    >
      {brand.companyName}
    </span>
  );
}

const RECIPIENT_STATUS_STYLES: Record<RecipientStatus, { label: string; className: string }> = {
  PENDING: { label: "Not Sent", className: "bg-canvas text-muted border-line-strong" },
  SENT: { label: "Sent", className: "bg-canvas text-muted border-line-strong" },
  OPENED: { label: "Opened", className: "bg-brand-soft text-brand border-brand/25" },
  IN_PROGRESS: { label: "In Progress", className: "bg-warning-soft text-warning border-warning/25" },
  COMPLETE: { label: "Complete", className: "bg-success-soft text-success border-success/25" },
  SYNC_ERROR: { label: "Sync Error", className: "bg-danger-soft text-danger border-danger/25" },
  SEND_FAILED: { label: "Send Failed", className: "bg-danger-soft text-danger border-danger/25" },
};

export function RecipientStatusBadge({ status }: { status: RecipientStatus }) {
  const style = RECIPIENT_STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${style.className}`}
    >
      {style.label}
    </span>
  );
}

const SYNC_STATUS_STYLES: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Pending sync", className: "bg-canvas text-muted border-line-strong" },
  SYNCED: { label: "Synced", className: "bg-success-soft text-success border-success/25" },
  SKIPPED: { label: "No change", className: "bg-canvas text-muted border-line-strong" },
  FAILED: { label: "Sync error", className: "bg-danger-soft text-danger border-danger/25" },
};

export function SyncStatusBadge({ status }: { status: string }) {
  const style = SYNC_STATUS_STYLES[status] ?? SYNC_STATUS_STYLES.PENDING;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${style.className}`}
    >
      {style.label}
    </span>
  );
}

export function AccountTypeBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px] font-semibold text-muted whitespace-nowrap">
      {label}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const toneClass = {
    default: "text-ink",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
  }[tone];

  return (
    <Card className="px-5 py-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className={`mt-1.5 text-3xl font-semibold tracking-tight tabular-nums ${toneClass}`}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-[13px] text-muted">{hint}</div> : null}
    </Card>
  );
}

export function StageChange({ from, to }: { from: string; to: string | null }) {
  if (!to || from === to) {
    return (
      <span className="text-[13px] text-muted">
        Confirmed <span className="font-medium text-body">{to ?? from}</span>
      </span>
    );
  }
  return (
    <span className="text-[13px] text-body">
      <span className="text-muted line-through decoration-line-strong">{from}</span>
      <span className="mx-1.5 text-muted">→</span>
      <span className="font-semibold text-ink">{to}</span>
    </span>
  );
}

/** Column check for the Sent / Opened / Completed columns. */
export function Tick({ on }: { on: boolean }) {
  return on ? (
    <span className="text-success" aria-label="yes">
      ✓
    </span>
  ) : (
    <span className="text-line-strong" aria-label="no">
      —
    </span>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card className="px-6 py-12 text-center">
      <p className="text-base font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">{body}</p>
    </Card>
  );
}
