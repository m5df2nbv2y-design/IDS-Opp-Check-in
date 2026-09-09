import { refreshCatalogAction } from "../actions";
import { ActionButton } from "@/components/admin/action-button";
import { AccountTypeBadge, Card, EmptyState } from "@/components/ui/primitives";
import { accountTypeLabel } from "@/lib/account-types";
import { formatAmount, pluralize } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import { RESOLUTION_REASON_LABELS, type ResolutionReason } from "@/server/services/recipient-resolution-service";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { listOrganizations } from "@/server/services/catalog-service";

export const dynamic = "force-dynamic";

/**
 * Supporting view: every external organization, its contacts, and which contact
 * each open opportunity was routed to — including why. This is where Sales Ops
 * checks the recipient resolution before launching a campaign.
 */
export default async function OrganizationsPage() {
  const organizations = await listOrganizations();
  const provider = getSalesforceService();
  const withOpportunities = organizations.filter((org) => org.opportunities.length > 0);
  const total = withOpportunities.reduce((sum, org) => sum + org.opportunities.length, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">Organizations</h1>
          <p className="mt-1 text-[15px] text-muted">
            {withOpportunities.length} {pluralize(withOpportunities.length, "organization")} ·{" "}
            {total} open {pluralize(total, "opportunity", "opportunities")} cached from{" "}
            {provider.info.label}
          </p>
        </div>
        <ActionButton action={refreshCatalogAction} pendingLabel="Refreshing…">
          Refresh from Salesforce
        </ActionButton>
      </div>

      {withOpportunities.length === 0 ? (
        <EmptyState
          title="No organizations cached yet"
          body="Refresh from Salesforce to pull accounts, contacts, and their open opportunities."
        />
      ) : (
        <div className="space-y-4">
          {withOpportunities.map((org) => {
            const reps = new Set(org.opportunities.map((o) => o.internalRepId));
            const contactsWithWork = new Set(
              org.opportunities.flatMap((o) => (o.contactId ? [o.contactId] : [])),
            );

            return (
              <Card key={org.id}>
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[17px] font-semibold tracking-tight text-ink">
                        {org.name}
                      </span>
                      <AccountTypeBadge label={accountTypeLabel(org.type)} />
                      {reps.size > 1 ? (
                        <span className="rounded-full border border-brand/25 bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">
                          {reps.size} IDS reps
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 text-[13px] text-muted">
                      {org.contacts.length} {pluralize(org.contacts.length, "contact")} ·{" "}
                      {contactsWithWork.size} receiving a check-in
                    </div>
                  </div>
                  <div className="text-[13px] text-muted">
                    {org.opportunities.length} open ·{" "}
                    {formatAmount(org.opportunities.reduce((sum, o) => sum + o.amount, 0))}
                  </div>
                </div>

                <div className="border-b border-line bg-canvas px-5 py-3">
                  <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                    {org.contacts.length === 0 ? (
                      <span className="text-[13px] font-medium text-danger">
                        No contacts on this account
                      </span>
                    ) : (
                      org.contacts.map((contact) => (
                        <span key={contact.id} className="text-[13px]">
                          <span className={contact.active ? "text-body" : "text-muted line-through"}>
                            {contact.name}
                          </span>
                          {contact.isPrimary ? (
                            <span className="ml-1.5 text-[11px] font-semibold text-brand">
                              PRIMARY
                            </span>
                          ) : null}
                          {!contact.active ? (
                            <span className="ml-1.5 text-[11px] font-semibold text-muted">
                              INACTIVE
                            </span>
                          ) : null}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                <ul className="divide-y divide-line">
                  {org.opportunities.map((opportunity) => (
                    <li key={opportunity.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-ink">{opportunity.customerName}</div>
                          <div className="text-[13px] text-muted">
                            {opportunity.projectName ?? opportunity.opportunityName}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-[13px]">
                          <span className="tabular-nums text-body">
                            {formatAmount(opportunity.amount)}
                          </span>
                          <span className="rounded-full border border-line bg-canvas px-2.5 py-1 font-medium text-body">
                            {stageLabel(opportunity.currentStage)}
                          </span>
                          <span className="text-muted">IDS: {opportunity.internalRep.name}</span>
                          <a
                            href={opportunity.salesforceUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="font-medium text-brand hover:underline"
                          >
                            SFX ↗
                          </a>
                        </div>
                      </div>
                      <div className="mt-1.5 text-[12px]">
                        {opportunity.contact ? (
                          <span className="text-muted">
                            Routes to{" "}
                            <span className="font-medium text-body">
                              {opportunity.contact.name}
                            </span>{" "}
                            —{" "}
                            {RESOLUTION_REASON_LABELS[
                              opportunity.resolutionReason as ResolutionReason
                            ] ?? opportunity.resolutionReason}
                          </span>
                        ) : (
                          <span className="font-medium text-danger">
                            No recipient —{" "}
                            {RESOLUTION_REASON_LABELS[
                              opportunity.resolutionReason as ResolutionReason
                            ] ?? "unresolved"}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
