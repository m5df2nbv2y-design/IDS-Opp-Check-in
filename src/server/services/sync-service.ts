import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { isClosedStage, isOpportunityStage, stageLabel } from "@/lib/stages";
import { getSalesforceService, SalesforceSyncError } from "@/server/integrations/salesforce";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";

export type SyncOutcome = {
  attempted: number;
  synced: number;
  skipped: number;
  failed: number;
  /** Recorded locally but deliberately not pushed — write-back is disabled. */
  withheld: number;
};

/**
 * Push submitted responses back to Salesforce/SFX.
 *
 * Runs per recipient when they finish, and can be re-run by an admin for
 * anything that failed. Each opportunity syncs independently so one rejected
 * record never blocks the rest.
 */
export async function syncCampaignResponses(
  filter: { campaignId: string; recipientId?: string; itemIds?: string[] },
  actor = "system",
  approval?: { itemId: string; revision: string },
): Promise<SyncOutcome> {
  const salesforce = getSalesforceService();

  /**
   * Never write to a REAL org unless someone deliberately turned it on.
   * Reading real pipeline data must not carry a risk of modifying it.
   *
   * The mock org is exempt: those writes land in our own demo tables, and
   * showing the completed sync is the point of the demo.
   */
  const writeEnabled = salesforce.info.simulated || env.salesforce.writeEnabled;

  const items = await prisma.checkInOpportunity.findMany({
    where: {
      recipient: { campaignId: filter.campaignId },
      ...(filter.recipientId ? { recipientId: filter.recipientId } : {}),
      ...(filter.itemIds ? { id: { in: filter.itemIds } } : {}),
      submittedAt: { not: null },
      syncStatus: { in: ["PENDING", "FAILED", "WITHHELD"] },
    },
    include: {
      recipient: { include: { contact: true, campaign: { select: { name: true } } } },
      opportunity: { select: { externalId: true, accountId: true, internalRepId: true } },
    },
  });

  const outcome: SyncOutcome = {
    attempted: items.length,
    synced: 0,
    skipped: 0,
    failed: 0,
    withheld: 0,
  };

  for (const item of items) {
    const nextStage = item.updatedStatus;
    if (!isOpportunityStage(nextStage)) {
      outcome.skipped += 1;
      continue;
    }

    const stageChanged = nextStage !== item.previousStatus;
    const dateChanged = !!item.updatedCloseDate && item.updatedCloseDate.getTime() !== item.previousCloseDate?.getTime();
    const label = `${item.customerName} — ${item.projectName ?? item.opportunityName}`;

    const auditContext = {
      campaignId: item.recipient.campaignId,
      contactId: item.recipient.contactId,
      accountId: item.opportunity.accountId,
      repId: item.opportunity.internalRepId,
      opportunityId: item.opportunityId,
    };

    // Nothing to push when stage and date are unchanged; notes stay local.
    if (!stageChanged && !dateChanged) {
      await prisma.checkInOpportunity.updateMany({
        where: { id: item.id, updatedAt: item.updatedAt, syncStatus: { in: ["PENDING", "FAILED", "WITHHELD"] } },
        data: { syncStatus: "SKIPPED", syncedAt: new Date(), syncError: null },
      });
      await recordAudit({
        type: AUDIT_EVENTS.SYNC_SKIPPED,
        summary: `${label} — confirmed ${stageLabel(nextStage)}, nothing to push`,
        actor,
        actorKind: "SYSTEM",
        ...auditContext,
      });
      outcome.skipped += 1;
      continue;
    }

    // The answer is already safely stored. Withholding the push keeps
    // Salesforce untouched while still showing exactly what WOULD be sent.
    const approved = approval?.itemId === item.id && approval.revision === item.updatedAt.toISOString() && !!item.recipient.completedAt;
    if (!writeEnabled || (!salesforce.info.simulated && (!approved || isClosedStage(nextStage)))) {
      await prisma.checkInOpportunity.updateMany({
        where: { id: item.id, updatedAt: item.updatedAt, syncStatus: { in: ["PENDING", "FAILED", "WITHHELD"] } },
        data: { syncStatus: "WITHHELD", syncError: null },
      });
      await recordAudit({
        type: AUDIT_EVENTS.SYNC_WITHHELD,
        summary: `${label} — ${stageLabel(item.previousStatus)} → ${stageLabel(nextStage)} recorded, not pushed`,
        actor,
        actorKind: "SYSTEM",
        fromStatus: item.previousStatus,
        toStatus: nextStage,
        detail: !writeEnabled ? "Salesforce write-back is disabled (SALESFORCE_WRITE_ENABLED is not \"true\")." : "Individual approval is required; Closed Lost remains deferred.",
        ...auditContext,
      });
      outcome.withheld += 1;
      continue;
    }

    // Claim this exact reviewed revision once. In-flight or uncertain writes are
    // never picked up by retry-all. Approval and claim share a transaction.
    const claimed = await prisma.$transaction(async (tx) => {
      const result = await tx.checkInOpportunity.updateMany({
        where: { id: item.id, updatedAt: item.updatedAt, syncStatus: { in: ["PENDING", "FAILED", "WITHHELD"] } },
        data: { syncStatus: "SYNCING", syncAttempts: { increment: 1 } },
      });
      if (result.count && approved) await tx.auditEvent.create({ data: {
        type: "WRITEBACK_APPROVED", summary: `${label} approved for Salesforce`, actor, actorKind: "ADMIN",
        ...auditContext, fromStatus: item.previousStatus, toStatus: nextStage,
        detail: JSON.stringify({ itemId: item.id, revision: approval!.revision, closeDate: item.updatedCloseDate?.toISOString().slice(0, 10) ?? null }),
      } });
      return result.count === 1;
    });
    if (!claimed) { outcome.skipped += 1; continue; }
    let patchStarted = false;
    try {
      let expectedLastModified: Date | undefined;
      if (!salesforce.info.simulated) {
        const current = await salesforce.getOpportunity(item.opportunity.externalId);
        if (!current || current.stage !== item.previousStatus ||
            current.closeDate?.getTime() !== item.previousCloseDate?.getTime() || !current.lastModifiedDate) {
          throw new SalesforceSyncError("Salesforce changed since this check-in. Review the record before proceeding.", { code: "CONFLICT", retryable: false });
        }
        expectedLastModified = current.lastModifiedDate;
      }
      patchStarted = true;
      await salesforce.applyUpdate({
        externalId: item.opportunity.externalId,
        stage: nextStage,
        ...(dateChanged ? { closeDate: item.updatedCloseDate!.toISOString().slice(0, 10) } : {}),
        expectedLastModified,
      });

      await prisma.$transaction([
        prisma.checkInOpportunity.update({
          where: { id: item.id },
          data: {
            syncStatus: "SYNCED",
            syncedAt: new Date(),
            syncError: null,
          },
        }),
        prisma.opportunity.update({
          where: { id: item.opportunityId },
          data: { currentStage: nextStage, ...(dateChanged ? { closeDate: item.updatedCloseDate } : {}), lastSyncedAt: new Date() },
        }),
      ]);

      await recordAudit({
        type: AUDIT_EVENTS.SYNC_SUCCEEDED,
        summary: `${label} synced to Salesforce: ${stageLabel(item.previousStatus)} → ${stageLabel(nextStage)}`,
        actor,
        actorKind: "SYSTEM",
        fromStatus: item.previousStatus,
        toStatus: nextStage,
        detail: `Updated by ${item.recipient.contact.name} · internal rep ${item.internalRepName}`,
        ...auditContext,
      });
      outcome.synced += 1;
    } catch (caught) {
      const message =
        caught instanceof SalesforceSyncError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : String(caught);

      await prisma.checkInOpportunity.updateMany({
        where: { id: item.id, syncStatus: "SYNCING" },
        data: { syncStatus: !salesforce.info.simulated && patchStarted && (!(caught instanceof SalesforceSyncError) || ["NETWORK", "WRITE_UNCERTAIN"].includes(caught.code)) ? "UNCERTAIN" : "FAILED", syncError: message },
      });

      await recordAudit({
        type: AUDIT_EVENTS.SYNC_FAILED,
        summary: `${label} failed to sync to Salesforce`,
        actor,
        actorKind: "SYSTEM",
        fromStatus: item.previousStatus,
        toStatus: nextStage,
        detail: message,
        ...auditContext,
      });
      outcome.failed += 1;
    }
  }

  return outcome;
}

export async function retryFailedSyncs(campaignId: string, actor = "admin"): Promise<SyncOutcome> {
  return syncCampaignResponses({ campaignId }, actor);
}
