import { prisma } from "@/lib/db";
import { isOpportunityStage, stageLabel } from "@/lib/stages";
import { getSalesforceService, SalesforceSyncError } from "@/server/integrations/salesforce";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";

export type SyncOutcome = {
  attempted: number;
  synced: number;
  skipped: number;
  failed: number;
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
): Promise<SyncOutcome> {
  const salesforce = getSalesforceService();

  const items = await prisma.checkInOpportunity.findMany({
    where: {
      recipient: { campaignId: filter.campaignId },
      ...(filter.recipientId ? { recipientId: filter.recipientId } : {}),
      ...(filter.itemIds ? { id: { in: filter.itemIds } } : {}),
      submittedAt: { not: null },
      syncStatus: { in: ["PENDING", "FAILED"] },
    },
    include: {
      recipient: { include: { contact: true, campaign: { select: { name: true } } } },
      opportunity: { select: { externalId: true, accountId: true, internalRepId: true } },
    },
  });

  const outcome: SyncOutcome = { attempted: items.length, synced: 0, skipped: 0, failed: 0 };

  for (const item of items) {
    const nextStage = item.updatedStatus;
    if (!isOpportunityStage(nextStage)) {
      outcome.skipped += 1;
      continue;
    }

    const stageChanged = nextStage !== item.previousStatus;
    const label = `${item.customerName} — ${item.projectName ?? item.opportunityName}`;

    const auditContext = {
      campaignId: item.recipient.campaignId,
      contactId: item.recipient.contactId,
      accountId: item.opportunity.accountId,
      repId: item.opportunity.internalRepId,
      opportunityId: item.opportunityId,
    };

    // Nothing to push when the stage is unchanged — notes are not written.
    if (!stageChanged) {
      await prisma.checkInOpportunity.update({
        where: { id: item.id },
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

    try {
      // Stage only. The recipient's comment is stored locally and shown in the
      // admin UI and audit trail, but is never written to Salesforce.
      await salesforce.applyUpdate({
        externalId: item.opportunity.externalId,
        stage: nextStage,
      });

      await prisma.$transaction([
        prisma.checkInOpportunity.update({
          where: { id: item.id },
          data: {
            syncStatus: "SYNCED",
            syncedAt: new Date(),
            syncError: null,
            syncAttempts: { increment: 1 },
          },
        }),
        prisma.opportunity.update({
          where: { id: item.opportunityId },
          data: { currentStage: nextStage, lastSyncedAt: new Date() },
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

      await prisma.checkInOpportunity.update({
        where: { id: item.id },
        data: { syncStatus: "FAILED", syncError: message, syncAttempts: { increment: 1 } },
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
