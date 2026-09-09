import { clearMockValidationBlockAction } from "../actions";
import { ActionButton } from "@/components/admin/action-button";
import { AccountTypeBadge, Card, EmptyState } from "@/components/ui/primitives";
import { accountTypeFromSalesforce, accountTypeLabel } from "@/lib/account-types";
import { prisma } from "@/lib/db";
import { formatAmount, formatDateTime } from "@/lib/format";
import { getSalesforceService } from "@/server/integrations/salesforce";

export const dynamic = "force-dynamic";

/**
 * A window into the system of record, so a demo can end with "and here is the
 * opportunity in Salesforce, already updated". Only meaningful with the mock
 * provider — against a real org this points you at Salesforce itself.
 */
export default async function SalesforcePage() {
  const provider = getSalesforceService();

  if (!provider.info.simulated) {
    return (
      <div className="space-y-6">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Salesforce</h1>
        <EmptyState
          title={`Connected to ${provider.info.label}`}
          body="Records live in Salesforce — use the Salesforce links on each response to open them there."
        />
      </div>
    );
  }

  const [records, users, accounts, contacts] = await Promise.all([
    prisma.mockSalesforceOpportunity.findMany({ orderBy: [{ lastModifiedAt: "desc" }] }),
    prisma.mockSalesforceUser.findMany(),
    prisma.mockSalesforceAccount.findMany(),
    prisma.mockSalesforceContact.findMany(),
  ]);

  const ownerName = new Map(users.map((user) => [user.externalId, user.name]));
  const accountById = new Map(accounts.map((account) => [account.externalId, account]));
  const contactName = new Map(contacts.map((contact) => [contact.externalId, contact.name]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Mock Salesforce org</h1>
        <p className="mt-1 max-w-2xl text-[15px] text-muted">
          The simulated system of record, most recently modified first. Stage changes and contact
          notes written by a completed check-in show up here — the same writes the live provider
          would make against Salesforce/SFX.
        </p>
        <p className="mt-2 text-[13px] text-muted">
          {accounts.length} accounts · {contacts.length} contacts · {users.length} users ·{" "}
          {records.length} opportunities
        </p>
      </div>

      <Card className="divide-y divide-line">
        {records.map((record) => {
          const account = accountById.get(record.accountExternalId);
          return (
            <div key={record.externalId} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-ink">{record.siteName}</div>
                  <div className="text-[14px] text-body">{record.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="text-[13px] text-muted">
                      {account?.name ?? record.accountExternalId}
                    </span>
                    {account ? (
                      <AccountTypeBadge
                        label={accountTypeLabel(accountTypeFromSalesforce(account.type))}
                      />
                    ) : null}
                  </div>
                  <div className="mt-1 font-mono text-[12px] text-muted">{record.externalId}</div>
                </div>
                <div className="flex flex-col items-end gap-1.5 text-[13px]">
                  <span className="rounded-full border border-line bg-canvas px-2.5 py-1 font-semibold text-body">
                    {record.stageName}
                  </span>
                  <span className="tabular-nums text-muted">{formatAmount(record.amount)}</span>
                  <span className="text-muted">
                    Owner: {ownerName.get(record.ownerExternalId) ?? record.ownerExternalId}
                  </span>
                  {record.contactExternalId ? (
                    <span className="text-muted">
                      Contact role: {contactName.get(record.contactExternalId) ?? "unknown"}
                    </span>
                  ) : null}
                  <span className="text-muted">Modified {formatDateTime(record.lastModifiedAt)}</span>
                </div>
              </div>

              {record.description ? (
                <p className="mt-3 rounded-xl bg-canvas px-4 py-2.5 text-[13px] text-body">
                  {record.description}
                </p>
              ) : null}

              {record.syncBlocked ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger-soft px-4 py-3">
                  <p className="text-[13px] text-danger">
                    A validation rule on this record rejects stage changes — this is what produces
                    the Sync Error state.
                  </p>
                  <ActionButton
                    action={clearMockValidationBlockAction.bind(null, record.externalId)}
                    size="sm"
                    pendingLabel="Clearing…"
                  >
                    Clear the rule
                  </ActionButton>
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
