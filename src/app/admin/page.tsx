import Link from "next/link";
import { prepareCampaignAction } from "./actions";
import { ActionButton } from "@/components/admin/action-button";
import { RecipientTable } from "@/components/admin/recipient-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, StatTile } from "@/components/ui/primitives";
import { accountTypePluralLabel } from "@/lib/account-types";
import { formatCompactAmount, formatDate, pluralize } from "@/lib/format";
import { listCampaigns, previewCampaign } from "@/server/services/campaign-service";
import { listUnresolvedOpportunities } from "@/server/services/catalog-service";

export const dynamic = "force-dynamic";

/**
 * Sales Operations control center. The organizing question is
 * "who do we need to contact to update our open opportunities?" — so the
 * primary unit here is the external contact, never the internal rep.
 */
export default async function AdminDashboardPage() {
  const [preview, campaigns, unresolved] = await Promise.all([
    previewCampaign(),
    listCampaigns(),
    listUnresolvedOpportunities(),
  ]);
  const [current, ...previous] = campaigns;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">
            Opportunity Check-In
          </h1>
          <p className="mt-1 text-[15px] text-muted">
            {current
              ? `${current.name} · launched ${formatDate(current.startedAt ?? current.createdAt)}`
              : "No campaign has been launched yet."}
          </p>
        </div>
        <ActionButton action={prepareCampaignAction} variant="primary" pendingLabel="Preparing…">
          🚀 SEND CHECK-IN TO ALL
        </ActionButton>
      </div>

      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-muted">
          Ready to send
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Open opportunities"
            value={preview.totalOpenCount}
            hint={`${preview.opportunityCount} routed · ${formatCompactAmount(preview.totalValue)}`}
          />
          <StatTile
            label="External contacts"
            value={preview.recipientCount}
            hint={`one email each · ${preview.contactsOnFile} on file`}
          />
          <StatTile label="Organizations" value={preview.organizationCount} />
          <StatTile
            label="Need a contact"
            value={preview.unresolvedCount}
            tone={preview.unresolvedCount > 0 ? "danger" : "default"}
            hint={preview.unresolvedCount > 0 ? "review before sending" : "all routed"}
          />
        </div>

        <Card className="flex flex-wrap gap-x-8 gap-y-2 px-5 py-4 text-[13px] text-muted">
          <span>
            <strong className="font-semibold text-ink">{preview.multiRepOrganizations}</strong>{" "}
            {pluralize(preview.multiRepOrganizations, "organization")} with opportunities from
            multiple IDS reps
          </span>
          {preview.countsByAccountType.map((entry) => (
            <span key={entry.type}>
              <strong className="font-semibold text-ink">{entry.organizations}</strong>{" "}
              {accountTypePluralLabel(entry.type, entry.organizations).toLowerCase()} ·{" "}
              {entry.opportunities} opportunities
            </span>
          ))}
        </Card>
      </section>

      {unresolved.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">
            Needs attention{" "}
            <span className="font-normal text-muted">({unresolved.length})</span>
          </h2>
          <Card className="divide-y divide-line border-danger/30">
            {unresolved.map((opportunity) => (
              <div
                key={opportunity.id}
                className="flex flex-wrap items-start justify-between gap-3 px-5 py-4"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-ink">{opportunity.customerName}</div>
                  <div className="text-[14px] text-body">
                    {opportunity.projectName ?? opportunity.opportunityName}
                  </div>
                  <div className="mt-1 text-[13px] text-muted">
                    {opportunity.account.name} · IDS rep {opportunity.internalRep.name}
                  </div>
                </div>
                <div className="max-w-sm text-right">
                  <div className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    No external contact — this opportunity is not included in a campaign.
                  </div>
                  <a
                    href={opportunity.salesforceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block text-[13px] font-medium text-brand hover:underline"
                  >
                    Fix in Salesforce ↗
                  </a>
                </div>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {current ? (
        <>
          <section className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-[17px] font-semibold tracking-tight text-ink">{current.name}</h2>
              <ButtonLink href={`/admin/campaigns/${current.id}`} variant="ghost" size="sm">
                View details →
              </ButtonLink>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              <StatTile label="Emails sent" value={current.emailsSent} />
              <StatTile label="Opened" value={current.openedCount} />
              <StatTile label="Started" value={current.startedCount} tone="warning" />
              <StatTile label="Completed" value={current.completedCount} tone="success" />
              <StatTile
                label="Sync errors"
                value={current.syncErrorCount}
                tone={current.syncErrorCount > 0 ? "danger" : "default"}
              />
            </div>

            <RecipientTable recipients={current.recipients} />
          </section>

          {previous.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-[17px] font-semibold tracking-tight text-ink">
                Previous campaigns
              </h2>
              <Card className="divide-y divide-line">
                {previous.map((campaign) => (
                  <Link
                    key={campaign.id}
                    href={`/admin/campaigns/${campaign.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-canvas"
                  >
                    <div>
                      <div className="font-semibold text-ink">{campaign.name}</div>
                      <div className="text-[13px] text-muted">
                        {campaign.recipientCount} contacts · {campaign.opportunityCount}{" "}
                        opportunities · {formatDate(campaign.startedAt ?? campaign.createdAt)}
                      </div>
                    </div>
                    <div className="text-[13px] font-medium text-muted">
                      {campaign.completedCount} of {campaign.recipientCount} complete
                    </div>
                  </Link>
                ))}
              </Card>
            </section>
          ) : null}
        </>
      ) : (
        <EmptyState
          title="No campaign yet"
          body="Sending a check-in pulls every open opportunity from Salesforce, works out which external contact is responsible for each one, and emails them a single personalized link."
        />
      )}
    </div>
  );
}
