import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/tokens";
import { isOpportunityStage, stageLabel, type OpportunityStage } from "@/lib/stages";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";
import { syncCampaignResponses } from "./sync-service";

export type InviteRejection = "NOT_FOUND" | "EXPIRED" | "REVOKED";

export type CheckInSessionItem = {
  id: string;
  /** End customer / project site — the card headline. */
  customerName: string;
  /** The project line. */
  projectName: string;
  amount: number;
  currentStage: string;
  selectedStage: OpportunityStage | null;
  /** The date Salesforce currently expects this to close. */
  currentCloseDate: string | null;
  /** The recipient's revised date, if they gave one. ISO yyyy-mm-dd. */
  selectedCloseDate: string | null;
  comment: string;
  submitted: boolean;
};

export type CheckInSession = {
  recipientId: string;
  campaignId: string;
  campaignName: string;
  contactId: string;
  contactName: string;
  organizationName: string;
  completedAt: Date | null;
  items: CheckInSessionItem[];
};

type ResolveResult = { ok: true; session: CheckInSession } | { ok: false; reason: InviteRejection };

/**
 * Resolve a raw check-in token to one external contact's session.
 *
 * The token is never stored — only its hash — so this is the only way in, and
 * it fails closed. A token resolves to exactly one recipient record, which is
 * what prevents one contact from reaching another's check-in.
 */
export async function resolveCheckInToken(token: string): Promise<ResolveResult> {
  if (!token || token.length < 20) return { ok: false, reason: "NOT_FOUND" };

  const recipient = await prisma.checkInRecipient.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      contact: { include: { account: true } },
      campaign: true,
      items: { orderBy: { position: "asc" } },
    },
  });

  if (!recipient) return { ok: false, reason: "NOT_FOUND" };
  if (recipient.revokedAt) return { ok: false, reason: "REVOKED" };
  if (recipient.expiresAt.getTime() < Date.now()) return { ok: false, reason: "EXPIRED" };

  return {
    ok: true,
    session: {
      recipientId: recipient.id,
      campaignId: recipient.campaignId,
      campaignName: recipient.campaign.name,
      contactId: recipient.contactId,
      contactName: recipient.contact.name,
      organizationName: recipient.contact.account.name,
      completedAt: recipient.completedAt,
      items: recipient.items.map((item) => ({
        id: item.id,
        customerName: item.customerName,
        projectName: item.projectName ?? item.opportunityName,
        amount: item.amount,
        currentStage: item.previousStatus,
        selectedStage: isOpportunityStage(item.updatedStatus) ? item.updatedStatus : null,
        currentCloseDate: item.previousCloseDate?.toISOString().slice(0, 10) ?? null,
        selectedCloseDate: item.updatedCloseDate?.toISOString().slice(0, 10) ?? null,
        comment: item.repComment ?? "",
        submitted: item.submittedAt !== null,
      })),
    },
  };
}

/** Accepts only a plain yyyy-mm-dd date, ignoring anything else. */
function parseCloseDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Records the first open of a personalized link. Idempotent. */
export async function markCheckInOpened(recipientId: string): Promise<void> {
  const recipient = await prisma.checkInRecipient.findUnique({
    where: { id: recipientId },
    include: { contact: { include: { account: true } } },
  });
  if (!recipient || recipient.openedAt) return;

  await prisma.checkInRecipient.update({
    where: { id: recipientId },
    data: { openedAt: new Date() },
  });

  await recordAudit({
    type: AUDIT_EVENTS.CHECKIN_OPENED,
    summary: `${recipient.contact.name} at ${recipient.contact.account.name} opened their check-in`,
    actor: recipient.contact.name,
    actorKind: "EXTERNAL_CONTACT",
    campaignId: recipient.campaignId,
    contactId: recipient.contactId,
    accountId: recipient.contact.accountId,
  });
}

export type SaveResponseResult =
  | { ok: true; revised: boolean }
  | { ok: false; reason: "NOT_FOUND" | "ALREADY_COMPLETED" | "INVALID_STAGE" };

/**
 * Save one opportunity answer. Called as the recipient advances, so a
 * half-finished check-in is never lost and re-answering revises the value.
 *
 * The item must belong to the recipient the token resolved to — this is the
 * cross-recipient authorization check.
 */
export async function saveResponse(input: {
  token: string;
  itemId: string;
  stage: string;
  comment?: string | null;
  /** Revised close date as ISO yyyy-mm-dd, or null to leave it unchanged. */
  closeDate?: string | null;
}): Promise<SaveResponseResult> {
  if (!isOpportunityStage(input.stage)) return { ok: false, reason: "INVALID_STAGE" };

  const resolved = await resolveCheckInToken(input.token);
  if (!resolved.ok) return { ok: false, reason: "NOT_FOUND" };
  if (resolved.session.completedAt) return { ok: false, reason: "ALREADY_COMPLETED" };

  const item = await prisma.checkInOpportunity.findFirst({
    where: { id: input.itemId, recipientId: resolved.session.recipientId },
    include: { opportunity: { select: { accountId: true, internalRepId: true, id: true } } },
  });
  if (!item) return { ok: false, reason: "NOT_FOUND" };

  const revised = item.submittedAt !== null;
  const comment = input.comment?.trim() ? input.comment.trim() : null;

  // Recorded for the confirmed future write scope. Still never pushed to
  // Salesforce — capturing it is what makes close-date movement measurable.
  const closeDate = parseCloseDate(input.closeDate);

  await prisma.$transaction([
    prisma.checkInOpportunity.update({
      where: { id: item.id },
      data: {
        updatedStatus: input.stage,
        updatedCloseDate: closeDate,
        repComment: comment,
        submittedAt: new Date(),
        syncStatus: "PENDING",
        syncError: null,
      },
    }),
    prisma.checkInRecipient.updateMany({
      where: { id: resolved.session.recipientId, startedAt: null },
      data: { startedAt: new Date() },
    }),
  ]);

  const changed = input.stage !== item.previousStatus;
  await recordAudit({
    type: revised ? AUDIT_EVENTS.RESPONSE_REVISED : AUDIT_EVENTS.RESPONSE_SUBMITTED,
    summary: changed
      ? `${item.customerName} — ${item.projectName ?? item.opportunityName}: ${stageLabel(item.previousStatus)} → ${stageLabel(input.stage)}`
      : `${item.customerName} — ${item.projectName ?? item.opportunityName}: confirmed ${stageLabel(input.stage)}`,
    actor: resolved.session.contactName,
    actorKind: "EXTERNAL_CONTACT",
    fromStatus: item.previousStatus,
    toStatus: input.stage,
    detail: comment,
    campaignId: resolved.session.campaignId,
    contactId: resolved.session.contactId,
    accountId: item.opportunity.accountId,
    repId: item.opportunity.internalRepId,
    opportunityId: item.opportunityId,
  });

  return { ok: true, revised };
}

export type CompleteResult =
  | { ok: true; alreadyCompleted: boolean; submitted: number; total: number }
  | { ok: false; reason: "NOT_FOUND" | "INCOMPLETE" };

/**
 * Finish the check-in: lock the recipient and push everything to Salesforce.
 * Calling it twice is safe — the second call reports `alreadyCompleted` instead
 * of re-syncing.
 */
export async function completeCheckIn(token: string): Promise<CompleteResult> {
  const resolved = await resolveCheckInToken(token);
  if (!resolved.ok) return { ok: false, reason: "NOT_FOUND" };

  const { session } = resolved;
  const submitted = session.items.filter((item) => item.submitted).length;

  if (session.completedAt) {
    return { ok: true, alreadyCompleted: true, submitted, total: session.items.length };
  }
  if (submitted < session.items.length) return { ok: false, reason: "INCOMPLETE" };

  await prisma.checkInRecipient.update({
    where: { id: session.recipientId },
    data: { completedAt: new Date() },
  });

  await recordAudit({
    type: AUDIT_EVENTS.CHECKIN_COMPLETED,
    summary: `${session.contactName} at ${session.organizationName} completed their check-in (${submitted} opportunities)`,
    actor: session.contactName,
    actorKind: "EXTERNAL_CONTACT",
    campaignId: session.campaignId,
    contactId: session.contactId,
  });

  await syncCampaignResponses(
    { campaignId: session.campaignId, recipientId: session.recipientId },
    session.contactName,
  );

  await closeCampaignIfDone(session.campaignId);

  return { ok: true, alreadyCompleted: false, submitted, total: session.items.length };
}

/** Marks the campaign COMPLETE once every recipient has finished. */
async function closeCampaignIfDone(campaignId: string): Promise<void> {
  const outstanding = await prisma.checkInRecipient.count({
    where: { campaignId, completedAt: null, revokedAt: null },
  });
  if (outstanding > 0) return;

  await prisma.campaign.updateMany({
    where: { id: campaignId, completedAt: null },
    data: { status: "COMPLETE", completedAt: new Date() },
  });
}
