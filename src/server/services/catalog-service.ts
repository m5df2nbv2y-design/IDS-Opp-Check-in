import { inBatches } from "@/lib/batches";
import { prisma } from "@/lib/db";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";
import { resolveRecipients } from "./recipient-resolution-service";
import { recordSnapshot, SNAPSHOT_SOURCES } from "./snapshot-service";

export type CatalogRefreshResult = {
  reps: number;
  accounts: number;
  contacts: number;
  opportunities: number;
  resolved: number;
  unresolved: number;
  /** Observations written because something actually changed. */
  snapshotsRecorded: number;
  /** Opportunities that left the open set and whose outcome we captured. */
  outcomesObserved: number;
};

/**
 * Pull the current picture from Salesforce/SFX into the local cache and decide,
 * for every open opportunity, which external contact should review it.
 *
 * Salesforce stays the system of record — the cache exists so a campaign can
 * snapshot what was asked, and so the admin dashboard is fast. Runs on every
 * campaign launch and can be run on its own.
 */
export async function refreshCatalogFromSalesforce(
  actor = "system",
): Promise<CatalogRefreshResult> {
  const salesforce = getSalesforceService();

  const [sfReps, sfAccounts] = await Promise.all([
    salesforce.getSalesReps(),
    salesforce.getAccounts(),
  ]);
  const activeReps = sfReps.filter((rep) => rep.active);

  // Independent row writes run a few at a time instead of one by one (a full refresh
  // took ~3 minutes of round trips). Half the default pg pool (10), so pages and
  // check-ins still get a connection while a refresh runs.
  const BATCH = 5;
  // Two writes to the same row in one batch would race on its unique key; keep one per id.
  const unique = <T extends { externalId: string }>(rows: readonly T[]) => [...new Map(rows.map((row) => [row.externalId, row])).values()];

  await inBatches(unique(sfReps), BATCH, (rep) =>
    prisma.salesRep.upsert({
      where: { externalId: rep.externalId },
      create: { externalId: rep.externalId, name: rep.name, email: rep.email, active: rep.active },
      update: { name: rep.name, email: rep.email, active: rep.active },
    }),
  );

  await inBatches(unique(sfAccounts), BATCH, (account) =>
    prisma.account.upsert({
      where: { externalId: account.externalId },
      create: {
        externalId: account.externalId,
        name: account.name,
        type: account.type,
        active: account.active,
      },
      update: { name: account.name, type: account.type, active: account.active },
    }),
  );

  // Every contact is stored, including those without an email: resolution
  // needs them to tell "primary contact has no email" from "contact not found".
  // Duplicate records are NOT collapsed — the primary contact role names one
  // specific record, and substituting another person is never correct.
  const canonical = await salesforce.getExternalContacts();

  const storedAccounts = await prisma.account.findMany({ select: { id: true, externalId: true, name: true } });
  const accountIdByExternalId = new Map(storedAccounts.map((account) => [account.externalId, account.id]));
  const accountNameById = new Map(storedAccounts.map((account) => [account.id, account.name]));

  await inBatches(unique(canonical), BATCH, async (contact) => {
    const accountId = accountIdByExternalId.get(contact.accountExternalId);
    if (!accountId) return;

    await prisma.externalContact.upsert({
      where: { externalId: contact.externalId },
      create: {
        externalId: contact.externalId,
        accountId,
        name: contact.name,
        email: contact.email,
        isPrimary: contact.isPrimary,
        active: contact.active,
      },
      update: {
        accountId,
        name: contact.name,
        email: contact.email,
        isPrimary: contact.isPrimary,
        active: contact.active,
      },
    });
  });

  const opportunities = await salesforce.getOpenOpportunities({
    ownerExternalIds: activeReps.map((rep) => rep.externalId),
  });

  const resolution = resolveRecipients({ opportunities, contacts: canonical });

  const storedReps = await prisma.salesRep.findMany({ select: { id: true, externalId: true, name: true } });
  const repIdByExternalId = new Map(storedReps.map((rep) => [rep.externalId, rep.id]));
  const repNameById = new Map(storedReps.map((rep) => [rep.id, rep.name]));
  const contactIdByExternalId = new Map(
    (await prisma.externalContact.findMany()).map((contact) => [contact.externalId, contact.id]),
  );

  const seenExternalIds: string[] = [];
  let snapshotsRecorded = 0;

  await inBatches([...new Map(resolution.results.map((r) => [r.opportunity.externalId, r])).values()], BATCH, async ({ opportunity, resolution: outcome }) => {
    const accountId = accountIdByExternalId.get(opportunity.accountExternalId);
    const internalRepId = repIdByExternalId.get(opportunity.ownerExternalId);
    // Without an account or an active owner there is nothing to attach the
    // opportunity to; these are counted by the provider's own skip logging.
    if (!accountId || !internalRepId) return;

    const contactId =
      outcome.status === "RESOLVED"
        ? (contactIdByExternalId.get(outcome.contactExternalId) ?? null)
        : null;

    seenExternalIds.push(opportunity.externalId);

    const fields = {
      accountId,
      customerName: opportunity.customerName,
      opportunityName: opportunity.opportunityName,
      projectName: opportunity.projectName,
      amount: opportunity.amount,
      currentStage: opportunity.stage,
      internalRepId,
      contactId,
      resolutionStatus: contactId ? "RESOLVED" : "UNRESOLVED",
      resolutionReason: outcome.reason,
      salesforceUrl: opportunity.url,
      closeDate: opportunity.closeDate,
      salesforceCreatedAt: opportunity.createdDate ?? null,
      salesforceLastModifiedAt: opportunity.lastModifiedDate ?? null,
      isOpen: true,
      lastSyncedAt: new Date(),
    };

    const stored = await prisma.opportunity.upsert({
      where: { externalId: opportunity.externalId },
      create: { externalId: opportunity.externalId, ...fields },
      update: fields,
      // Names come from the maps above, not a join on every row.
    });

    // Append-only history. Writes only when something material changed, so a
    // refresh over an unchanging pipeline costs nothing.
    if (
      await recordSnapshot({
        opportunityId: stored.id,
        externalId: stored.externalId,
        source: SNAPSHOT_SOURCES.CATALOG_REFRESH,
        amount: stored.amount,
        stage: stored.currentStage,
        closeDate: stored.closeDate,
        isOpen: true,
        isWon: null,
        accountId: stored.accountId,
        accountName: accountNameById.get(stored.accountId) ?? "",
        internalRepId: stored.internalRepId,
        internalRepName: repNameById.get(stored.internalRepId) ?? "",
      })
    ) {
      snapshotsRecorded += 1;
    }
  });

  // ---- Terminal outcomes -------------------------------------------------
  // An opportunity that has left the open set can never be returned by the
  // open-opportunity query again, so its Won/Lost result is only learnable by
  // asking for it explicitly — now, before the knowledge is lost for good.
  const departed = await prisma.opportunity.findMany({
    where: { externalId: { notIn: seenExternalIds }, outcomeObservedAt: null },
    include: { account: true, internalRep: true },
  });

  let outcomesObserved = 0;

  if (departed.length > 0) {
    const outcomes = await salesforce.getOpportunityOutcomes(
      departed.map((opportunity) => opportunity.externalId),
    );
    const byExternalId = new Map(outcomes.map((outcome) => [outcome.externalId, outcome]));

    for (const opportunity of departed) {
      const outcome = byExternalId.get(opportunity.externalId);
      // No outcome returned means the record is gone or unreadable. Leave
      // outcomeObservedAt null so a later refresh can try again rather than
      // freezing a guess.
      if (!outcome || !outcome.isClosed) continue;

      const observedAt = new Date();
      await prisma.opportunity.update({
        where: { id: opportunity.id },
        data: {
          isOpen: false,
          isWon: outcome.isWon,
          finalStage: outcome.stageName,
          finalAmount: outcome.amount,
          closedAt: outcome.closeDate,
          outcomeObservedAt: observedAt,
        },
      });

      await recordSnapshot({
        opportunityId: opportunity.id,
        externalId: opportunity.externalId,
        source: SNAPSHOT_SOURCES.OUTCOME_OBSERVED,
        amount: outcome.amount,
        stage: outcome.stageName,
        closeDate: outcome.closeDate,
        isOpen: false,
        isWon: outcome.isWon,
        accountId: opportunity.accountId,
        accountName: opportunity.account.name,
        internalRepId: opportunity.internalRepId,
        internalRepName: opportunity.internalRep.name,
      });

      await recordAudit({
        type: AUDIT_EVENTS.OPPORTUNITY_CLOSED,
        summary: `${opportunity.customerName} — ${opportunity.opportunityName} closed ${outcome.isWon ? "Won" : "Lost"} at ${outcome.stageName}`,
        actor,
        actorKind: "SYSTEM",
        fromStatus: opportunity.currentStage,
        toStatus: outcome.stageName,
        detail: `Final amount ${outcome.amount}. Observed ${observedAt.toISOString()}.`,
        accountId: opportunity.accountId,
        repId: opportunity.internalRepId,
        opportunityId: opportunity.id,
      });

      outcomesObserved += 1;
    }
  }

  // Anything still absent from the open set stops being offered, whether or not
  // its outcome could be read.
  await prisma.opportunity.updateMany({
    where: { externalId: { notIn: seenExternalIds } },
    data: { isOpen: false },
  });

  const result: CatalogRefreshResult = {
    reps: activeReps.length,
    accounts: sfAccounts.length,
    contacts: canonical.length,
    opportunities: seenExternalIds.length,
    resolved: resolution.resolvedCount,
    unresolved: resolution.unresolvedCount,
    snapshotsRecorded,
    outcomesObserved,
  };

  await recordAudit({
    type: AUDIT_EVENTS.CATALOG_REFRESHED,
    summary: `Pulled ${result.opportunities} open opportunities across ${result.accounts} organizations from ${salesforce.info.label}`,
    actor,
    actorKind: "SYSTEM",
    detail: [
      `${result.resolved} routed to a contact`,
      result.unresolved > 0 ? `${result.unresolved} need attention` : null,
      result.snapshotsRecorded > 0 ? `${result.snapshotsRecorded} snapshots recorded` : null,
      result.outcomesObserved > 0 ? `${result.outcomesObserved} outcomes observed` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  return result;
}

/** Opportunities we could not route to anyone — the admin attention list. */
export async function listUnresolvedOpportunities() {
  return prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "UNRESOLVED" },
    include: { account: true, internalRep: true },
    orderBy: { amount: "desc" },
  });
}

/** Every organization with its contacts and open opportunities. */
export async function listOrganizations() {
  return prisma.account.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    include: {
      contacts: { orderBy: [{ isPrimary: "desc" }, { name: "asc" }] },
      opportunities: {
        where: { isOpen: true },
        orderBy: { amount: "desc" },
        include: { internalRep: true, contact: true },
      },
    },
  });
}

/** The newest Salesforce refresh, as recorded in the audit trail; null before the first one. */
export async function getLastCatalogRefresh(): Promise<{ at: Date; summary: string } | null> {
  const last = await prisma.auditEvent.findFirst({
    where: { type: AUDIT_EVENTS.CATALOG_REFRESHED },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, summary: true },
  });
  return last ? { at: last.createdAt, summary: last.summary } : null;
}
