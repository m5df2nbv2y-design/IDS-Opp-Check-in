import Link from "next/link";
import { refreshDiscoveryAction } from "./actions";
import { AccountSelectionList } from "@/components/admin/account-selection-list";
import { ActionButton } from "@/components/admin/action-button";
import { SelectionBar } from "@/components/admin/selection-bar";
import { SelectionFilters } from "@/components/admin/selection-filters";
import { SignalList, type SignalListItem } from "@/components/admin/signal-list";
import { Card, EmptyState, StatTile } from "@/components/ui/primitives";
import { formatDate, pluralize } from "@/lib/format";
import {
  getDraftSummary,
  getOrCreateDraft,
  listDraftAccounts,
  listOwnersWithOpenOpportunities,
} from "@/server/services/campaign-draft-service";
import { listCampaigns } from "@/server/services/campaign-service";
import {
  listOpenOpportunitiesForAccount,
  listSignals,
} from "@/server/services/smartsheet-signal-service";

export const dynamic = "force-dynamic";

/**
 * Sales Operations selection queue.
 *
 * The workflow is deliberately: Salesforce discovery → review → explicit
 * selection → send selected. There is no action anywhere on this page that
 * contacts everyone who was discovered — that is the point of the design, not
 * an omission.
 */
export default async function AdminDashboardPage({
  searchParams,
}: PageProps<"/admin">) {
  const params = await searchParams;
  const filters = {
    search: typeof params.q === "string" ? params.q : undefined,
    ownerId: typeof params.owner === "string" ? params.owner : undefined,
    status: typeof params.status === "string" ? params.status : undefined,
  };

  const draft = await getOrCreateDraft();

  const [accounts, summary, owners, campaigns, signals] = await Promise.all([
    listDraftAccounts(draft.id, filters),
    getDraftSummary(draft.id),
    listOwnersWithOpenOpportunities(),
    listCampaigns(),
    listSignals(),
  ]);

  const sent = campaigns.filter((campaign) => campaign.status !== "DRAFT");
  const shownOpportunities = accounts.reduce((sum, a) => sum + a.opportunities.length, 0);
  const shownSendable = accounts.reduce((sum, a) => sum + a.selectableCount, 0);
  const shownNeedsAttention = accounts.reduce((sum, a) => sum + a.needsAttentionCount, 0);
  const filtered = Boolean(filters.search || filters.ownerId || filters.status);

  const signalItems: SignalListItem[] = await Promise.all(
    signals.slice(0, 5).map(async (signal) => ({
      id: signal.id,
      sheetName: signal.sheetName,
      signalType: signal.signalType,
      title: signal.title,
      message: signal.message,
      assignedToName: signal.assignedToName,
      dueDate: signal.dueDate,
      occurredAt: signal.occurredAt,
      sourceUrl: signal.sourceUrl,
      rawAccountName: signal.rawAccountName,
      rawProjectName: signal.rawProjectName,
      matchStatus: signal.matchStatus,
      matchReason: signal.matchReason,
      status: signal.status,
      reviewedAt: signal.reviewedAt,
      draftResponse: signal.draftResponse,
      draftedAt: signal.draftedAt,
      opportunity: signal.opportunity,
      account: signal.account,
      candidates:
        signal.matchStatus === "AMBIGUOUS" && signal.accountId
          ? await listOpenOpportunitiesForAccount(signal.accountId)
          : undefined,
    })),
  );

  return (
    <div className="space-y-6 pb-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">
            Opportunity Check-In
          </h1>
          <p className="mt-1 max-w-2xl text-[15px] text-muted">
            Review the opportunities discovered in Salesforce and choose which ones to
            contact. Nothing is sent until you select it and confirm.
          </p>
        </div>
        <ActionButton action={refreshDiscoveryAction} pendingLabel="Refreshing…">
          Refresh from Salesforce
        </ActionButton>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label={filtered ? "Shown (filtered)" : "Open opportunities"}
          value={shownOpportunities}
          hint={`${accounts.length} ${pluralize(accounts.length, "account")}`}
        />
        <StatTile label="Ready to select" value={shownSendable} />
        <StatTile
          label="Needs attention"
          value={shownNeedsAttention}
          tone={shownNeedsAttention > 0 ? "danger" : "default"}
          hint="no recipient — not sendable"
        />
        <StatTile
          label="Selected"
          value={summary.selectedOpportunities}
          tone={summary.selectedOpportunities > 0 ? "success" : "default"}
          hint={`${summary.selectedContacts} ${pluralize(summary.selectedContacts, "contact")}`}
        />
      </div>

      <SelectionFilters owners={owners} />

      {accounts.length === 0 ? (
        <EmptyState
          title={filtered ? "Nothing matches those filters" : "No open opportunities"}
          body={
            filtered
              ? "Try a different search term, owner, or status."
              : "Refresh from Salesforce to pull the current open opportunities and resolve their recipients."
          }
        />
      ) : (
        <AccountSelectionList accounts={accounts} />
      )}

      {signalItems.length > 0 ? (
        <section className="space-y-3 pt-2">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-[17px] font-semibold tracking-tight text-ink">
              Smartsheet signals{" "}
              <span className="font-normal text-muted">({signals.length})</span>
            </h2>
          </div>
          <SignalList signals={signalItems} />
        </section>
      ) : null}

      {sent.length > 0 ? (
        <section className="space-y-3 pt-2">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Sent campaigns</h2>
          <Card className="divide-y divide-line">
            {sent.map((campaign) => (
              <Link
                key={campaign.id}
                href={`/admin/campaigns/${campaign.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-canvas"
              >
                <div>
                  <div className="font-semibold text-ink">{campaign.name}</div>
                  <div className="text-[13px] text-muted">
                    {campaign.recipientCount} contacts · {campaign.opportunityCount} opportunities ·{" "}
                    {formatDate(campaign.startedAt ?? campaign.createdAt)}
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

      <SelectionBar summary={summary} />
    </div>
  );
}
