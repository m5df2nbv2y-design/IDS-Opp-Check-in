import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";
import { formatAmount, pluralize } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import {
  getDraftSummary,
  getOrCreateDraft,
  getReviewRecipients,
} from "@/server/services/campaign-draft-service";
import { SendPlaceholder } from "./send-placeholder";

export const dynamic = "force-dynamic";

/**
 * The final review step. Shows exactly what would be sent, grouped by the
 * person who would receive it — one contact, one email, every opportunity they
 * were selected for.
 *
 * The send action is an architectural boundary only: it is deliberately inert
 * (see ./send-placeholder.tsx). Nothing here can email anyone or modify
 * Salesforce.
 */
export default async function ReviewPage() {
  const draft = await getOrCreateDraft();
  const [summary, recipients] = await Promise.all([
    getDraftSummary(draft.id),
    getReviewRecipients(draft.id),
  ]);

  if (summary.selectedOpportunities === 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <ButtonLink href="/admin" variant="ghost" size="sm" className="-ml-3">
          ← Back to selection
        </ButtonLink>
        <EmptyState
          title="Nothing selected"
          body="Choose the opportunities you want to contact on the selection queue first."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <ButtonLink href="/admin" variant="ghost" size="sm" className="-ml-3 mb-1">
          ← Back to selection
        </ButtonLink>
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Review before sending</h1>
        <p className="mt-1 text-[15px] text-muted">{summary.campaignName}</p>
      </div>

      <Card className="px-6 py-5">
        <p className="text-[19px] leading-relaxed text-ink">
          You are about to send{" "}
          <strong className="font-semibold">
            {summary.selectedOpportunities} {pluralize(summary.selectedOpportunities, "check-in")}
          </strong>{" "}
          to{" "}
          <strong className="font-semibold">
            {summary.selectedContacts} {pluralize(summary.selectedContacts, "contact")}
          </strong>{" "}
          across{" "}
          <strong className="font-semibold">
            {summary.selectedAccounts} {pluralize(summary.selectedAccounts, "account")}
          </strong>
          .
        </p>
        <p className="mt-2 text-[14px] text-muted">
          Each contact receives one email covering every opportunity listed under their
          name below. Only the opportunities you selected are included.
        </p>
      </Card>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">
          Every recipient and exactly what they will be asked about
        </h2>

        <Card className="divide-y divide-line">
          {recipients.map((recipient) => (
            <div key={recipient.contactId} className="px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className="font-semibold text-ink">{recipient.contactName}</span>
                  <span className="text-[13px] text-muted"> — {recipient.contactEmail}</span>
                </div>
                <div className="text-[13px] text-muted">
                  {recipient.accountName} ·{" "}
                  {recipient.opportunities.length}{" "}
                  {pluralize(recipient.opportunities.length, "opportunity", "opportunities")}
                </div>
              </div>

              <ul className="mt-2 space-y-1">
                {recipient.opportunities.map((opportunity) => (
                  <li
                    key={opportunity.id}
                    className="flex flex-wrap items-center gap-x-3 text-[13px] text-body"
                  >
                    <span className="text-muted">•</span>
                    <span>{opportunity.name}</span>
                    <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px] font-medium text-muted">
                      {stageLabel(opportunity.stage)}
                    </span>
                    <span className="tabular-nums text-muted">
                      {formatAmount(opportunity.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      </section>

      <SendPlaceholder summary={summary} />
    </div>
  );
}
