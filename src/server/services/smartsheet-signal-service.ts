import { prisma } from "@/lib/db";
import { getSmartsheetService } from "@/server/integrations/smartsheet";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";
import {
  matchSignalToOpportunity,
  type OpportunityCandidate,
} from "./signal-matching-service";

export type SignalIngestResult = {
  fetched: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
};

/**
 * Pull signals from Smartsheet and match each one against the currently
 * cached opportunity catalog (populated by catalog-service.ts's Salesforce
 * refresh — this function never calls Salesforce itself).
 *
 * Upserts by externalId, so re-running is idempotent: the same fixed set of
 * mock signals never duplicates, and a real provider's re-delivered webhook
 * would land on the same row instead of creating a second one.
 */
export async function refreshSmartsheetSignals(actor = "system"): Promise<SignalIngestResult> {
  const smartsheet = getSmartsheetService();
  const signals = await smartsheet.getSignals();

  const opportunities = await prisma.opportunity.findMany({
    where: { isOpen: true },
    include: { account: { select: { id: true, name: true } } },
  });
  const candidates: OpportunityCandidate[] = opportunities.map((opportunity) => ({
    id: opportunity.id,
    externalId: opportunity.externalId,
    accountId: opportunity.accountId,
    accountName: opportunity.account.name,
    opportunityName: opportunity.opportunityName,
    projectName: opportunity.projectName,
    customerName: opportunity.customerName,
  }));

  const result: SignalIngestResult = { fetched: signals.length, matched: 0, ambiguous: 0, unmatched: 0 };

  for (const signal of signals) {
    const match = matchSignalToOpportunity(signal, candidates);

    const fields = {
      sheetName: signal.sheetName,
      signalType: signal.signalType,
      title: signal.title,
      message: signal.message,
      assignedToName: signal.assignedToName,
      dueDate: signal.dueDate,
      occurredAt: signal.occurredAt,
      sourceUrl: signal.sourceUrl,
      rawAccountName: signal.relatedAccountName,
      rawProjectName: signal.relatedProjectName,
      rawOpportunityExternalId: signal.relatedOpportunityExternalId,
      matchStatus: match.status,
      matchReason: match.reason,
      opportunityId: match.status === "MATCHED" ? match.opportunityId : null,
      accountId: match.status !== "UNMATCHED" ? match.accountId : null,
    };

    const existing = await prisma.opportunitySignal.findUnique({
      where: { externalId: signal.externalId },
    });

    await prisma.opportunitySignal.upsert({
      where: { externalId: signal.externalId },
      create: { externalId: signal.externalId, provider: smartsheet.info.id, ...fields },
      // Re-ingesting refreshes the raw signal and match result, but never
      // touches the PM's review/draft workflow state on an existing row.
      update: fields,
    });

    if (match.status === "MATCHED") result.matched += 1;
    else if (match.status === "AMBIGUOUS") result.ambiguous += 1;
    else result.unmatched += 1;

    if (!existing) {
      await recordAudit({
        type: AUDIT_EVENTS.SIGNAL_INGESTED,
        summary: `Smartsheet signal ingested: "${signal.title}" (${signal.sheetName})`,
        actor,
        actorKind: "SYSTEM",
        detail: `${match.status} — ${match.reason}`,
        opportunityId: match.status === "MATCHED" ? match.opportunityId : null,
        accountId: match.status !== "UNMATCHED" ? match.accountId : null,
      });
    }
  }

  return result;
}

/** Every signal, newest first, with enough context to act on it. */
export async function listSignals() {
  return prisma.opportunitySignal.findMany({
    orderBy: { occurredAt: "desc" },
    include: {
      opportunity: { include: { internalRep: true, account: true } },
      account: true,
    },
  });
}

/**
 * For an AMBIGUOUS signal: every currently open opportunity at that account,
 * so a PM can see the candidates without the app guessing which one is meant.
 * Queried fresh rather than snapshotted at ingest time, so it always reflects
 * the current catalog.
 */
export async function listOpenOpportunitiesForAccount(accountId: string) {
  return prisma.opportunity.findMany({
    where: { accountId, isOpen: true },
    include: { internalRep: true, account: true },
    orderBy: { amount: "desc" },
  });
}

export async function markSignalReviewed(signalId: string, actor: string) {
  const signal = await prisma.opportunitySignal.findUniqueOrThrow({ where: { id: signalId } });

  await prisma.opportunitySignal.update({
    where: { id: signalId },
    data: {
      status: signal.status === "NEW" ? "REVIEWED" : signal.status,
      reviewedAt: new Date(),
      reviewedBy: actor,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.SIGNAL_REVIEWED,
    summary: `Smartsheet signal reviewed: "${signal.title}"`,
    actor,
    actorKind: "ADMIN",
    opportunityId: signal.opportunityId,
    accountId: signal.accountId,
  });
}

export async function saveSignalDraftResponse(signalId: string, draftResponse: string, actor: string) {
  const trimmed = draftResponse.trim();
  const signal = await prisma.opportunitySignal.findUniqueOrThrow({ where: { id: signalId } });

  await prisma.opportunitySignal.update({
    where: { id: signalId },
    data: {
      draftResponse: trimmed || null,
      draftedAt: trimmed ? new Date() : null,
      status: trimmed ? "DRAFTED" : signal.status === "DRAFTED" ? "REVIEWED" : signal.status,
    },
  });

  await recordAudit({
    type: AUDIT_EVENTS.SIGNAL_DRAFTED,
    summary: `Draft response saved for Smartsheet signal: "${signal.title}"`,
    actor,
    actorKind: "ADMIN",
    detail: trimmed || null,
    opportunityId: signal.opportunityId,
    accountId: signal.accountId,
  });
}
