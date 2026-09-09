import { launchCampaignAction } from "../../actions";
import { ActionButton } from "@/components/admin/action-button";
import { ButtonLink } from "@/components/ui/button";
import { AccountTypeBadge, Card, EmptyState } from "@/components/ui/primitives";
import { accountTypeLabel } from "@/lib/account-types";
import { formatCompactAmount, pluralize } from "@/lib/format";
import { currentPeriod, previewCampaign } from "@/server/services/campaign-service";

export const dynamic = "force-dynamic";

/**
 * The confirmation screen. Read-only: the catalog was refreshed and recipients
 * resolved by the action that navigated here, so this shows exactly who is
 * about to be emailed before anything leaves the building.
 */
export default async function NewCampaignPage() {
  const preview = await previewCampaign();

  if (preview.recipientCount === 0) {
    return (
      <div className="space-y-6">
        <ButtonLink href="/admin" variant="ghost" size="sm" className="-ml-3">
          ← Cancel
        </ButtonLink>
        <EmptyState
          title="Nothing to send"
          body="No open opportunity currently resolves to an external contact. Check the needs-attention list on the dashboard."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <ButtonLink href="/admin" variant="ghost" size="sm" className="-ml-3 mb-1">
          ← Cancel
        </ButtonLink>
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">
          Send {currentPeriod()} check-in
        </h1>
      </div>

      <Card className="px-6 py-6">
        <p className="text-[19px] leading-relaxed text-ink">
          You&apos;re about to send opportunity check-ins to{" "}
          <strong className="font-semibold">
            {preview.recipientCount} {pluralize(preview.recipientCount, "contact")}
          </strong>{" "}
          covering{" "}
          <strong className="font-semibold">
            {preview.opportunityCount} open{" "}
            {pluralize(preview.opportunityCount, "opportunity", "opportunities")}
          </strong>{" "}
          across{" "}
          <strong className="font-semibold">
            {preview.organizationCount}{" "}
            {pluralize(preview.organizationCount, "organization")}
          </strong>
          .
        </p>
        <p className="mt-3 text-[15px] text-muted">
          The system groups opportunities by external contact automatically. Each contact receives
          one email — including the {preview.multiRepOrganizations}{" "}
          {pluralize(preview.multiRepOrganizations, "organization")} whose opportunities span
          several IDS reps. Total pipeline: {formatCompactAmount(preview.totalValue)}.
        </p>

        {preview.unresolvedCount > 0 ? (
          <p className="mt-4 rounded-xl bg-warning-soft px-4 py-3 text-[14px] text-warning">
            {preview.unresolvedCount}{" "}
            {pluralize(preview.unresolvedCount, "opportunity", "opportunities")} could not be matched
            to an external contact and {preview.unresolvedCount === 1 ? "is" : "are"} not included.
            {" "}They stay on the dashboard&apos;s needs-attention list.
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/admin" variant="secondary">
            CANCEL
          </ButtonLink>
          <ActionButton
            action={launchCampaignAction}
            variant="primary"
            pendingLabel="Sending check-ins…"
          >
            SEND CHECK-INS
          </ActionButton>
        </div>
      </Card>

      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">
          Who will receive an email
        </h2>
        <Card className="divide-y divide-line">
          {preview.recipients.map((recipient) => (
            <div
              key={recipient.contactId}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
            >
              <div className="min-w-0">
                <div className="font-semibold text-ink">{recipient.contactName}</div>
                <div className="text-[13px] text-muted">{recipient.contactEmail}</div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[13px]">
                <span className="text-body">{recipient.accountName}</span>
                <AccountTypeBadge label={accountTypeLabel(recipient.accountType)} />
                <span className="tabular-nums text-muted">
                  {recipient.opportunityCount}{" "}
                  {pluralize(recipient.opportunityCount, "opportunity", "opportunities")}
                </span>
                {recipient.internalRepNames.length > 1 ? (
                  <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px] font-medium text-muted">
                    {recipient.internalRepNames.length} IDS reps
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
