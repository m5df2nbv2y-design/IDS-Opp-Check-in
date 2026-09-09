import { prisma } from "@/lib/db";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";
import { dedupeContacts, resolveRecipients } from "./recipient-resolution-service";

export type CatalogRefreshResult = {
  reps: number;
  accounts: number;
  contacts: number;
  opportunities: number;
  resolved: number;
  unresolved: number;
  duplicateContactsCollapsed: number;
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

  for (const rep of sfReps) {
    await prisma.salesRep.upsert({
      where: { externalId: rep.externalId },
      create: { externalId: rep.externalId, name: rep.name, email: rep.email, active: rep.active },
      update: { name: rep.name, email: rep.email, active: rep.active },
    });
  }

  for (const account of sfAccounts) {
    await prisma.account.upsert({
      where: { externalId: account.externalId },
      create: {
        externalId: account.externalId,
        name: account.name,
        type: account.type,
        active: account.active,
      },
      update: { name: account.name, type: account.type, active: account.active },
    });
  }

  const sfContacts = await salesforce.getExternalContacts();
  // Only canonical contacts are stored; duplicate Salesforce records collapse
  // into the one human so nobody is emailed twice.
  const { canonical } = dedupeContacts(sfContacts);

  const accountIdByExternalId = new Map(
    (await prisma.account.findMany()).map((account) => [account.externalId, account.id]),
  );

  for (const contact of canonical) {
    const accountId = accountIdByExternalId.get(contact.accountExternalId);
    if (!accountId) continue;

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
  }

  const opportunities = await salesforce.getOpenOpportunities({
    ownerExternalIds: activeReps.map((rep) => rep.externalId),
  });

  const resolution = resolveRecipients({
    opportunities,
    accounts: sfAccounts,
    contacts: sfContacts,
  });

  const repIdByExternalId = new Map(
    (await prisma.salesRep.findMany()).map((rep) => [rep.externalId, rep.id]),
  );
  const contactIdByExternalId = new Map(
    (await prisma.externalContact.findMany()).map((contact) => [contact.externalId, contact.id]),
  );

  const seenExternalIds: string[] = [];

  for (const { opportunity, resolution: outcome } of resolution.results) {
    const accountId = accountIdByExternalId.get(opportunity.accountExternalId);
    const internalRepId = repIdByExternalId.get(opportunity.ownerExternalId);
    // Without an account or an active owner there is nothing to attach the
    // opportunity to; these are counted by the provider's own skip logging.
    if (!accountId || !internalRepId) continue;

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
      isOpen: true,
      lastSyncedAt: new Date(),
    };

    await prisma.opportunity.upsert({
      where: { externalId: opportunity.externalId },
      create: { externalId: opportunity.externalId, ...fields },
      update: fields,
    });
  }

  // Opportunities that closed stop being offered, but are kept so past
  // campaigns and the audit trail survive.
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
    duplicateContactsCollapsed: resolution.duplicatesCollapsed,
  };

  await recordAudit({
    type: AUDIT_EVENTS.CATALOG_REFRESHED,
    summary: `Pulled ${result.opportunities} open opportunities across ${result.accounts} organizations from ${salesforce.info.label}`,
    actor,
    actorKind: "SYSTEM",
    detail: [
      `${result.resolved} routed to a contact`,
      result.unresolved > 0 ? `${result.unresolved} need attention` : null,
      result.duplicateContactsCollapsed > 0
        ? `${result.duplicateContactsCollapsed} duplicate contact records collapsed`
        : null,
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
