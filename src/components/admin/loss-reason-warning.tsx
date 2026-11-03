import type { LossReasonHealth } from "@/server/services/loss-reason-health";

/**
 * Shown to administrators when Closed Lost cannot be answered.
 *
 * The consequence is stated first and in plain terms, because the technical
 * reason is useless to someone who does not yet know what is broken: a
 * recipient who picks Closed Lost cannot finish their check-in at all. The
 * named refusal and the remedy follow.
 *
 * Silent when healthy. A banner that appears when everything is fine teaches
 * people to ignore banners.
 */
export function LossReasonWarning({ health }: { health: LossReasonHealth | null }) {
  if (!health || health.ok) return null;

  return (
    <div
      role="status"
      className="mb-4 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3"
    >
      <p className="text-[13px] font-semibold text-warning">
        Closed Lost answers cannot be submitted right now
      </p>
      <p className="mt-1 text-[13px] text-body">
        Salesforce is not returning the loss reasons, so a recipient who chooses Closed Lost sees an
        empty list and cannot complete their check-in. Every other answer still works.
      </p>
      <p className="mt-2 text-[13px] text-body">
        <span className="font-semibold">What to change:</span> {health.remedy}
      </p>
      <p className="mt-2 text-[12px] text-muted">
        Reported by Salesforce as <code className="font-mono">{health.refusal}</code> — {health.detail}
      </p>
      <p className="mt-2 text-[12px] text-muted">
        Choices are cached for ten minutes, so allow a little time after changing Salesforce before
        rechecking.
      </p>
    </div>
  );
}
