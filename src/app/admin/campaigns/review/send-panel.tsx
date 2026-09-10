"use client";

import { useState, useTransition } from "react";
import { sendDraftAction } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { pluralize } from "@/lib/format";
import type { DraftSummary } from "@/server/services/campaign-draft-service";

/**
 * The send boundary.
 *
 * Sending is real within the application — it creates recipients, mints tokens
 * and records messages — but the EMAIL PROVIDER is what decides whether anything
 * leaves the building. With EMAIL_PROVIDER=mock the messages land in the in-app
 * outbox. Salesforce is not touched: no stage and no close date is written here.
 *
 * The server action re-resolves every selection before creating anything, so
 * this button cannot send to a recipient the client merely claims is valid.
 */
export function SendPanel({
  summary,
  emailProviderLabel,
  simulated,
}: {
  summary: DraftSummary;
  emailProviderLabel: string;
  simulated: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <Card className="border-brand/30 px-6 py-5">
      <h2 className="text-[15px] font-semibold tracking-tight text-ink">Send</h2>

      <p className="mt-1.5 text-[13px] text-muted">
        Delivery goes through the <strong className="font-semibold">{emailProviderLabel}</strong>
        {simulated
          ? " — messages are captured in the outbox, not delivered to anyone."
          : " — messages will be delivered to real recipients."}{" "}
        No Salesforce record is modified by sending.
      </p>

      <label className="mt-3 flex items-start gap-2.5 text-[14px] text-body">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={pending}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]"
        />
        <span>
          I have reviewed the {summary.selectedContacts}{" "}
          {pluralize(summary.selectedContacts, "recipient")} above and confirm these are
          the people who should be contacted.
        </span>
      </label>

      <div className="mt-4">
        <Button
          variant="primary"
          disabled={!confirmed || pending}
          onClick={() => startTransition(async () => void (await sendDraftAction()))}
        >
          {pending
            ? "Sending…"
            : `Send ${summary.selectedOpportunities} ${pluralize(summary.selectedOpportunities, "check-in")} to ${summary.selectedContacts} ${pluralize(summary.selectedContacts, "contact")}`}
        </Button>
      </div>

      <p className="mt-3 text-[13px] text-muted">
        Each selection is re-resolved against Salesforce data at this moment. Anything
        that has changed since you selected it — closed, primary contact role removed,
        email removed — is excluded and reported rather than sent.
      </p>
    </Card>
  );
}
