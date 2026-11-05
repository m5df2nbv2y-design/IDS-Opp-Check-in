"use client";

import { useState, useTransition } from "react";
import type { ReconcileActionResult } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import type { ObservedOutcome } from "@/server/services/reconcile-service";

/** Shown for anything that is not an expected refusal — never the thrown text. */
export const RECONCILE_FAILED_MESSAGE =
  "Could not record this. Reload the page, re-check Salesforce, and try again.";

/**
 * Runs one attestation and returns the notice to show, or null on success.
 * A refusal carries its own fixed message; a throw (no session, wrong role,
 * tampered input, an unexpected failure) is never converted to success and its
 * text is never shown.
 */
export async function runReconcile(run: () => Promise<ReconcileActionResult>): Promise<string | null> {
  try {
    const result = await run();
    return result.ok ? null : result.message;
  } catch {
    return RECONCILE_FAILED_MESSAGE;
  }
}

const CHOICES: { outcome: ObservedOutcome; label: string; confirm: string }[] = [
  {
    outcome: "APPLIED",
    label: "It is in Salesforce",
    confirm:
      "Confirm the change IS in Salesforce? This marks the write complete and nothing will attempt it again.",
  },
  {
    outcome: "NOT_APPLIED",
    label: "It is not there",
    confirm:
      "Confirm the change is NOT in Salesforce? This does not retry — it makes the response approvable again so you can decide.",
  },
];

/** Presentational: `pending` is the outcome being recorded, which disables both buttons. */
export function ReconcileControlsView({
  pending,
  notice,
  onChoose,
  onReload,
}: {
  pending: ObservedOutcome | null;
  notice: string | null;
  onChoose: (outcome: ObservedOutcome) => void;
  onReload: () => void;
}) {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {CHOICES.map(({ outcome, label }) => (
          <Button
            key={outcome}
            variant="secondary"
            disabled={pending !== null}
            onClick={() => onChoose(outcome)}
          >
            {pending === outcome ? "Recording…" : label}
          </Button>
        ))}
      </div>
      <div aria-live="polite">
        {notice ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] text-danger">
            <p>{notice}</p>
            <Button variant="secondary" size="sm" onClick={onReload}>
              Reload
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The two outcome buttons for one UNCERTAIN response. They share one pending
 * state, so a second click cannot start a second attestation while the first
 * is in flight, and an expected refusal is shown here instead of thrown.
 */
export function ReconcileControls({
  action,
}: {
  action: (observed: ObservedOutcome) => Promise<ReconcileActionResult>;
}) {
  const [isPending, startTransition] = useTransition();
  const [choice, setChoice] = useState<ObservedOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <ReconcileControlsView
      pending={isPending ? choice : null}
      notice={notice}
      onChoose={(outcome) => {
        const { confirm } = CHOICES.find((c) => c.outcome === outcome)!;
        if (!window.confirm(confirm)) return;
        setChoice(outcome);
        setNotice(null);
        startTransition(async () => {
          setNotice(await runReconcile(() => action(outcome)));
        });
      }}
      onReload={() => window.location.reload()}
    />
  );
}
