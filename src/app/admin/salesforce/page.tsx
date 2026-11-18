import Link from "next/link";
import { clearMockValidationBlockAction } from "../actions";
import { ActionButton } from "@/components/admin/action-button";
import { AccountTypeBadge, Card, EmptyState } from "@/components/ui/primitives";
import { accountTypeFromSalesforce, accountTypeLabel } from "@/lib/account-types";
import { prisma } from "@/lib/db";
import { formatAmount, formatDateTime } from "@/lib/format";
import { env } from "@/lib/env";
import { requireAdminPage } from "@/server/auth/require-admin";
import { getSalesforceService, type SalesforceService } from "@/server/integrations/salesforce";
import { sanitizeProviderError } from "@/server/services/audit-service";

export const dynamic = "force-dynamic";

/**
 * A window into the system of record, so a demo can end with "and here is the
 * opportunity in Salesforce, already updated". Only meaningful with the mock
 * provider — against a real org this points you at Salesforce itself.
 */
export default async function SalesforcePage({ searchParams }: PageProps<"/admin/salesforce">) {
  // The layout guards too, but a page renders alongside its layout, so the check must not run first.
  await requireAdminPage();
  const provider = getSalesforceService();

  if (!provider.info.simulated) {
    const check = (await searchParams).check === "1" ? await runReadinessCheck(provider) : null;
    return (
      <div className="space-y-6">
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Salesforce</h1>
        <EmptyState
          title={`Connected to ${provider.info.label}`}
          body="Records live in Salesforce — use the Salesforce links on each response to open them there."
        />
        <Card className="space-y-4 px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-ink">Write readiness</h2>
            <Link href="/admin/salesforce?check=1" prefetch={false} className="text-sm font-semibold text-ink underline">
              Run check
            </Link>
          </div>
          <WriteSwitches />
          {check ? <ReadinessResult check={check} /> : (
            <p className="text-[13px] text-muted">Read-only: the check makes no changes in Salesforce.</p>
          )}
        </Card>
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

      <Card className="space-y-3 px-6 py-5">
        <h2 className="text-lg font-semibold text-ink">Write readiness</h2>
        <WriteSwitches />
        <p className="text-[13px] text-muted">The write-readiness check needs the live Salesforce org.</p>
      </Card>

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

type ReadinessCheck =
  | { error: string }
  | {
      username: string;
      fields: { name: string; updateable: boolean }[];
      total: number;
      editableCount: number;
      blockedByOwner: [string, number][];
    };

/** Runs only on ?check=1. Any failure becomes a message, never the error page. */
async function runReadinessCheck(provider: SalesforceService): Promise<ReadinessCheck> {
  if (!provider.checkWriteReadiness) return { error: "This Salesforce provider cannot run the check." };
  try {
    const open = await prisma.opportunity.findMany({
      where: { isOpen: true },
      select: { externalId: true, internalRep: { select: { name: true } } },
    });
    const result = await provider.checkWriteReadiness(open.map((opp) => opp.externalId));
    const blocked = new Map<string, number>();
    for (const opp of open) {
      if (result.editable[opp.externalId] === true) continue;
      blocked.set(opp.internalRep.name, (blocked.get(opp.internalRep.name) ?? 0) + 1);
    }
    const blockedTotal = [...blocked.values()].reduce((sum, n) => sum + n, 0);
    return {
      username: result.username,
      fields: result.fields,
      total: open.length,
      editableCount: open.length - blockedTotal,
      blockedByOwner: [...blocked].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    };
  } catch (caught) {
    return { error: sanitizeProviderError(caught instanceof Error ? caught.message : String(caught)) ?? "Unknown error." };
  }
}

function OnOff({ on }: { on: boolean }) {
  return <span className="font-semibold text-ink">{on ? "on" : "off"}</span>;
}

/** Setting values only — never a credential or the instance URL. */
function WriteSwitches() {
  const { writeEnabled, write } = env.salesforce;
  const lossField = write.lossReasonField.trim();
  return (
    <ul className="space-y-1 text-[14px] text-body">
      <li>Salesforce writes (SALESFORCE_WRITE_ENABLED): <OnOff on={writeEnabled} /></li>
      <li>Closed Lost (SF_WRITE_CLOSED_LOST): <OnOff on={write.closedLost} /></li>
      <li>Probability (SF_WRITE_PROBABILITY): <OnOff on={write.probability} /></li>
      <li>
        Loss reason field (SF_FIELD_LOSS_REASON):{" "}
        {lossField ? (
          <span className="font-mono font-semibold text-ink">{lossField}</span>
        ) : (
          <span className="font-semibold text-danger">not configured — Closed Lost can&apos;t be written</span>
        )}
      </li>
    </ul>
  );
}

function ReadinessResult({ check }: { check: ReadinessCheck }) {
  if ("error" in check) {
    return <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-[13px] text-danger">{check.error}</p>;
  }
  // Readiness follows the switches: a field counts only when a switched-on write would send it.
  const { write } = env.salesforce;
  const lossField = write.lossReasonField.trim();
  const required = (name: string) =>
    name === "StageName" || name === "CloseDate" ||
    (name === "Probability" && write.probability) ||
    (name === lossField && write.closedLost);
  const closedLostUnconfigured = write.closedLost && !lossField;
  const fieldsOk = check.fields.every((field) => field.updateable || !required(field.name));
  const ready = fieldsOk && !closedLostUnconfigured && check.total > 0 && check.editableCount === check.total;
  return (
    <div className="space-y-3 text-[14px] text-body">
      <p>Integration user: <span className="font-semibold text-ink">{check.username}</span></p>
      <ul className="space-y-1">
        {check.fields.map((field) => (
          <li key={field.name}>
            <span className="font-mono">{field.name}</span>:{" "}
            {required(field.name) ? (
              <span className={field.updateable ? "text-success" : "font-semibold text-danger"}>
                {field.updateable ? "editable" : "not editable"}
              </span>
            ) : (
              <span className="text-muted">not written</span>
            )}
          </li>
        ))}
      </ul>
      {closedLostUnconfigured ? (
        <p className="font-semibold text-danger">Closed Lost is on but SF_FIELD_LOSS_REASON is not configured.</p>
      ) : null}
      <p>
        {check.editableCount} of {check.total} open opportunities editable
        {check.total === 0 ? " — the cache is empty; refresh from Salesforce first." : null}
      </p>
      {check.blockedByOwner.length > 0 ? (
        <ul className="space-y-1">
          {check.blockedByOwner.map(([owner, count]) => (
            <li key={owner}>{owner}: {count} not editable</li>
          ))}
        </ul>
      ) : null}
      <p role="status" className={ready ? "font-semibold text-success" : "font-semibold text-danger"}>
        {ready ? "Ready: the integration user can make every write on every cached open opportunity." : "Not ready: fix the items above before switching writes on."}
      </p>
    </div>
  );
}
