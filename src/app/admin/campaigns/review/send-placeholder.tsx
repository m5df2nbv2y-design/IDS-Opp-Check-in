"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { pluralize } from "@/lib/format";
import type { DraftSummary } from "@/server/services/campaign-draft-service";

/**
 * ===========================================================================
 *  THE SEND BOUNDARY — DELIBERATELY INERT.
 * ===========================================================================
 *
 * This is where the outbound integration will eventually attach. It exists now
 * so the full discovery → review → selection → send UX can be exercised and
 * reviewed, but it sends nothing, creates no recipients, mints no tokens, and
 * does not touch Salesforce.
 *
 * When the real send is wired up, it belongs BEHIND a server action that:
 *   1. re-reads the selections server-side rather than trusting the client,
 *   2. re-verifies each selected opportunity still resolves to a contact with
 *      an email (Salesforce may have changed since selection),
 *   3. converts the DRAFT campaign into IN_PROGRESS, creating one
 *      CheckInRecipient per contact and one CheckInOpportunity per selection,
 *   4. sends exactly one email per recipient, recording per-recipient failures
 *      rather than aborting the batch.
 *
 * `launchCampaign()` in campaign-service.ts already does 3 and 4 for the
 * previous whole-catalog flow; it needs narrowing to a selection set. That is
 * the next deliberate step, not this one.
 */
export function SendPlaceholder({ summary }: { summary: DraftSummary }) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Card className="border-brand/30 px-6 py-5">
      <h2 className="text-[15px] font-semibold tracking-tight text-ink">Send</h2>

      <label className="mt-3 flex items-start gap-2.5 text-[14px] text-body">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]"
        />
        <span>
          I have reviewed the {summary.selectedContacts}{" "}
          {pluralize(summary.selectedContacts, "recipient")} above and confirm these are
          the people who should be contacted.
        </span>
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!confirmed} title="Sending is not implemented yet">
          Send {summary.selectedOpportunities}{" "}
          {pluralize(summary.selectedOpportunities, "check-in")} to {summary.selectedContacts}{" "}
          {pluralize(summary.selectedContacts, "contact")}
        </Button>

        <span className="rounded-full border border-warning/25 bg-warning-soft px-3 py-1 text-[12px] font-semibold text-warning">
          Not wired up
        </span>
      </div>

      <p className="mt-3 text-[13px] text-muted">
        Sending is deliberately not implemented in this iteration. This button is the
        architectural boundary where the outbound integration will attach — it currently
        sends nothing, creates no check-in links, and does not modify Salesforce. Your
        selection is saved and will still be here.
      </p>
    </Card>
  );
}
