import { formatDateTime } from "@/lib/format";

/** The line beside "Refresh from Salesforce": when it last ran and what it pulled. */
export function LastRefreshed({ last }: { last: { at: Date; summary: string } | null }) {
  return (
    <p role="status" className="mt-1 ml-auto max-w-sm text-[13px] text-muted">
      {last ? `Last refreshed ${formatDateTime(last.at)} · ${last.summary}` : "Not refreshed yet"}
    </p>
  );
}
