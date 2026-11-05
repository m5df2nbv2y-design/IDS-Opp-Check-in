import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { DraftEmailConflictError, readEmailCopy, validateEmailCopy, type EmailCopy } from "@/lib/check-in-copy";
import { checkInUrl, issueToken } from "@/lib/tokens";
import { getEmailService } from "@/server/integrations/email";
import type { EmailSendResult } from "@/server/integrations/email/types";
import {
  buildInviteEmail,
  buildReminderEmail,
} from "@/server/integrations/email/templates/check-in-email";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { AUDIT_EVENTS, recordAudit, sanitizeProviderError } from "./audit-service";
import { recordSnapshot, SNAPSHOT_SOURCES } from "./snapshot-service";

export type RecipientStatus =
  | "PENDING"
  | "SENT"
  | "OPENED"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "SYNC_ERROR"
  | "SEND_FAILED"
  | "SEND_UNCERTAIN";

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  PENDING: "Delivery pending",
  SENT: "Sent",
  OPENED: "Opened",
  IN_PROGRESS: "In Progress",
  COMPLETE: "Complete",
  SYNC_ERROR: "Sync Error",
  SEND_FAILED: "Send Failed",
  SEND_UNCERTAIN: "Delivery unresolved",
};

/** "Fall 2026" / "Spring 2026" — IDS runs this twice a year. */
export function currentPeriod(date = new Date()): string {
  const season = date.getUTCMonth() < 6 ? "Spring" : "Fall";
  return `${season} ${date.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Preview — what the admin sees before committing to a send.
// ---------------------------------------------------------------------------

export type CampaignPreview = {
  /** Opportunities that will actually be sent (routed to a contact). */
  opportunityCount: number;
  /** Every open opportunity, routed or not. */
  totalOpenCount: number;
  recipientCount: number;
  /** Every contact record on file, including those with no opportunities. */
  contactsOnFile: number;
  organizationCount: number;
  totalValue: number;
  /** Organizations whose opportunities span more than one internal IDS rep. */
  multiRepOrganizations: number;
  countsByAccountType: { type: string; organizations: number; opportunities: number }[];
  unresolvedCount: number;
  /** Recipient rows, largest first — exactly who would be emailed. */
  recipients: {
    contactId: string;
    contactName: string;
    contactEmail: string;
    accountName: string;
    accountType: string;
    opportunityCount: number;
    internalRepNames: string[];
  }[];
};

/**
 * Everything the confirmation screen needs, computed from the cached catalog.
 * Read-only — nothing is created and no email is sent.
 */
export async function previewCampaign(): Promise<CampaignPreview> {
  const opportunities = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    include: { contact: { include: { account: true } }, internalRep: true, account: true },
  });

  const byContact = new Map<string, typeof opportunities>();
  for (const opportunity of opportunities) {
    const list = byContact.get(opportunity.contactId!);
    if (list) list.push(opportunity);
    else byContact.set(opportunity.contactId!, [opportunity]);
  }

  const recipients = [...byContact.entries()]
    .map(([contactId, items]) => {
      const contact = items[0].contact!;
      return {
        contactId,
        contactName: contact.name,
        contactEmail: contact.email,
        accountName: contact.account.name,
        accountType: contact.account.type,
        opportunityCount: items.length,
        internalRepNames: [...new Set(items.map((item) => item.internalRep.name))].sort(),
      };
    })
    .sort((a, b) => b.opportunityCount - a.opportunityCount || a.contactName.localeCompare(b.contactName));

  const byAccount = new Map<string, { type: string; reps: Set<string>; opportunities: number }>();
  for (const opportunity of opportunities) {
    const entry = byAccount.get(opportunity.accountId) ?? {
      type: opportunity.account.type,
      reps: new Set<string>(),
      opportunities: 0,
    };
    entry.reps.add(opportunity.internalRepId);
    entry.opportunities += 1;
    byAccount.set(opportunity.accountId, entry);
  }

  const countsByType = new Map<string, { organizations: number; opportunities: number }>();
  for (const entry of byAccount.values()) {
    const current = countsByType.get(entry.type) ?? { organizations: 0, opportunities: 0 };
    current.organizations += 1;
    current.opportunities += entry.opportunities;
    countsByType.set(entry.type, current);
  }

  const [unresolvedCount, totalOpenCount, contactsOnFile] = await Promise.all([
    prisma.opportunity.count({ where: { isOpen: true, resolutionStatus: "UNRESOLVED" } }),
    prisma.opportunity.count({ where: { isOpen: true } }),
    prisma.externalContact.count(),
  ]);

  return {
    opportunityCount: opportunities.length,
    totalOpenCount,
    recipientCount: recipients.length,
    contactsOnFile,
    organizationCount: byAccount.size,
    totalValue: opportunities.reduce((sum, item) => sum + item.amount, 0),
    multiRepOrganizations: [...byAccount.values()].filter((entry) => entry.reps.size > 1).length,
    countsByAccountType: [...countsByType.entries()]
      .map(([type, counts]) => ({ type, ...counts }))
      .sort((a, b) => b.opportunities - a.opportunities),
    unresolvedCount,
    recipients,
  };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export type LaunchResult = {
  campaignId: string;
  name: string;
  recipients: number;
  opportunities: number;
  emailsSent: number;
  emailsFailed: number;
  emailsUncertain?: number;
  unresolvedOpportunities: number;
  /** Set only by resumeLaunch: selected opportunities still unreached after the run. */
  unreachedAfter?: number;
};

/** True only for a unique violation on (campaignId, contactId), not e.g. tokenHash. */
function isRecipientClaimConflict(error: unknown): boolean {
  const e = error as { code?: string; meta?: Record<string, unknown> } | null;
  if (e?.code !== "P2002") return false;
  const constraint = (e.meta?.driverAdapterError as { cause?: { constraint?: { index?: string; fields?: string[] } } } | undefined)?.cause?.constraint;
  const target = e.meta?.target ?? constraint?.index ?? constraint?.fields;
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");
  return text.includes("campaignId") && text.includes("contactId");
}

/**
 * Group the given opportunities by external contact, create one recipient per
 * contact, mint a token, and send one personalized email each. A contact
 * responsible for opportunities belonging to three different IDS reps receives
 * ONE email covering all of them.
 *
 * `opportunityIds` is REQUIRED and has no fallback. There is deliberately no
 * way — accidental or otherwise — to launch against the whole catalog: an
 * omitted list is a programming error, not an instruction to contact everyone.
 * Callers that genuinely want every resolved opportunity (the guarded seed
 * script) must query for them and pass them explicitly, so the intent is
 * visible at the call site.
 */
export async function launchCampaign(options: {
  /** The explicit, human-selected set to contact. Never optional. */
  opportunityIds: string[];
  name?: string;
  period?: string;
  actor?: string;
  sendEmails?: boolean;
  /** Convert this existing DRAFT campaign rather than creating a new one. */
  campaignId?: string;
  emailCopy?: EmailCopy;
  expectedEmailRevision?: number;
  /** Finish an IN_PROGRESS campaign: leave its name, status and startedAt alone. */
  resume?: boolean;
}): Promise<LaunchResult> {
  // Runtime half of the type-level guarantee: a JavaScript caller, a bad cast,
  // or a deserialized payload cannot slip past the compiler into a full send.
  if (!Array.isArray(options?.opportunityIds)) {
    throw new Error(
      "launchCampaign requires an explicit opportunityIds array. There is no " +
        "whole-catalog fallback — pass the selected opportunities.",
    );
  }

  const actor = options.actor ?? "admin";
  const period = options.period ?? currentPeriod();
  const name = options.name ?? `${period} Check-In`;
  const sendEmails = options.sendEmails ?? true;
  // Reject invalid copy before creating campaigns, tokens or recipients.
  const emailCopy = options.emailCopy ? validateEmailCopy(options.emailCopy) : undefined;

  const opportunities = await prisma.opportunity.findMany({
    where: {
      isOpen: true,
      resolutionStatus: "RESOLVED",
      contactId: { not: null },
      id: { in: options.opportunityIds },
    },
    include: { contact: { include: { account: true } }, internalRep: true, account: true },
    orderBy: { amount: "desc" },
  });

  // Never turn an explicit launch selection into a silent partial send.
  // Resuming an existing campaign reports persisted shortfalls separately.
  if ((!options.resume || !options.campaignId) && opportunities.length !== new Set(options.opportunityIds).size) {
    throw new Error("Some selected opportunities are missing or no longer eligible. Review your selection before launching.");
  }

  const byContact = new Map<string, typeof opportunities>();
  for (const opportunity of opportunities) {
    const list = byContact.get(opportunity.contactId!);
    if (list) list.push(opportunity);
    else byContact.set(opportunity.contactId!, [opportunity]);
  }

  const previousCampaign = options.campaignId ? await prisma.campaign.findUniqueOrThrow({ where: { id: options.campaignId } }) : null;
  if (previousCampaign && !["DRAFT", "IN_PROGRESS"].includes(previousCampaign.status)) throw new Error("Only draft or in-progress campaigns can launch.");
  if (!options.resume && options.campaignId && (previousCampaign?.status === "DRAFT" || options.expectedEmailRevision !== undefined)) {
    const claimed = await prisma.campaign.updateMany({
      where: { id: options.campaignId, status: "DRAFT", ...(options.expectedEmailRevision !== undefined ? { emailRevision: options.expectedEmailRevision } : {}) },
      data: { name, status: "IN_PROGRESS", startedAt: new Date() },
    });
    if (claimed.count !== 1) throw new DraftEmailConflictError("The email draft changed or was already sent. Reload and review it again.");
  }

  const campaign = options.campaignId
    ? await prisma.campaign.findUniqueOrThrow({ where: { id: options.campaignId } })
    : await prisma.campaign.create({ data: { name, period, status: "IN_PROGRESS", startedAt: new Date() } });

  // `opportunityIds` IS the selection — it is the explicit, human-chosen set,
  // which is why it has no fallback. Record it with the values frozen at this
  // moment, exactly as the draft flow does, so "what pipeline did we choose to
  // intervene on?" stays answerable no matter which path launched the campaign.
  // Without this, a campaign launched programmatically loses that figure
  // permanently — the Opportunity row is a mutable cache and moves on.
  //
  // A draft converted by sendDraft has already recorded its selections, and
  // those carry the original selection time — so existing rows are left alone
  // rather than overwritten. (skipDuplicates is not available on the SQLite
  // adapter, so the filter is explicit.)
  const alreadyRecorded = new Set(
    (
      await prisma.campaignSelection.findMany({
        where: { campaignId: campaign.id },
        select: { opportunityId: true },
      })
    ).map((selection) => selection.opportunityId),
  );

  const newSelections = opportunities.filter(
    (opportunity) => !alreadyRecorded.has(opportunity.id),
  );

  const existingRouting = await prisma.auditEvent.findFirst({ where: { campaignId: campaign.id, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
  if (previousCampaign?.status === "IN_PROGRESS" && (!existingRouting || newSelections.length > 0)) {
    throw new Error("Existing campaign selections and routing require review; launch cannot expand approved work.");
  }
  if (newSelections.length > 0) {
    await prisma.campaignSelection.createMany({
      data: newSelections.map((opportunity) => ({
        campaignId: campaign.id,
        opportunityId: opportunity.id,
        selectedBy: actor,
        amountAtSelection: opportunity.amount,
        stageAtSelection: opportunity.currentStage,
        closeDateAtSelection: opportunity.closeDate,
      })),
    });
  }

  if (!options.resume) {
    await prisma.$transaction(async (tx) => {
      await tx.campaign.update({ where: { id: campaign.id }, data: { id: campaign.id } });
      const previous = await tx.auditEvent.findFirst({ where: { campaignId: campaign.id, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
      if (!previous) {
        const selected = await tx.campaignSelection.findMany({ where: { campaignId: campaign.id }, include: { opportunity: true } });
        await recordAudit({ type: AUDIT_EVENTS.CAMPAIGN_ROUTING, summary: "Approved invitation routing", actor, actorKind: "ADMIN", campaignId: campaign.id,
          detail: JSON.stringify({ version: 1, routes: Object.fromEntries(selected.map(({ opportunity: o }) => [o.id, o.contactId])) }) }, tx);
      }
    });
  }

  const expiresAt = new Date(Date.now() + env.checkInTokenTtlDays * 24 * 60 * 60 * 1000);
  let emailsSent = 0;
  let emailsFailed = 0;
  let emailsUncertain = 0;

  /** Attach items to a recipient and mark the intervention point on the observation timeline. */
  const addItems = async (tx: Prisma.TransactionClient, recipientId: string, items: typeof opportunities, startPosition: number) => {
    await tx.checkInOpportunity.createMany({
      data: items.map((opportunity, index) => ({
        recipientId,
        opportunityId: opportunity.id,
        customerName: opportunity.customerName,
        opportunityName: opportunity.opportunityName,
        projectName: opportunity.projectName,
        amount: opportunity.amount,
        salesforceUrl: opportunity.salesforceUrl,
        accountName: opportunity.account.name,
        internalRepName: opportunity.internalRep.name,
        previousStatus: opportunity.currentStage,
        // Snapshotted for the confirmed future write scope. Not captured from
        // the recipient yet, and never written to Salesforce today.
        previousCloseDate: opportunity.closeDate,
        position: startPosition + index,
      })),
    });

    // Mark the intervention point on the observation timeline, so "state when
    // we asked" is queryable from one place without joining the check-in items.
    for (const opportunity of items) {
      await recordSnapshot({
        opportunityId: opportunity.id,
        externalId: opportunity.externalId,
        source: SNAPSHOT_SOURCES.CAMPAIGN_LAUNCH,
        amount: opportunity.amount,
        stage: opportunity.currentStage,
        closeDate: opportunity.closeDate,
        isOpen: true,
        isWon: null,
        accountId: opportunity.accountId,
        accountName: opportunity.account.name,
        internalRepId: opportunity.internalRepId,
        internalRepName: opportunity.internalRep.name,
      }, tx);
    }
  };

  for (const [contactId, items] of byContact) {
    const contact = items[0].contact!;
    const token = issueToken();

    // The (campaignId, contactId) unique constraint is the claim: if another
    // launch or resume created this contact first, skip — it owns the send.
    let recipient;
    try {
      recipient = await prisma.$transaction(async (tx) => {
        // Share the campaign lock with completion and recovery. Nothing becomes
        // externally visible until this recipient's complete item set commits.
        await tx.campaign.update({ where: { id: campaign.id }, data: { id: campaign.id } });
        const current = await tx.campaign.findUniqueOrThrow({ where: { id: campaign.id } });
        if (current.status !== "IN_PROGRESS") throw new Error("Campaign is no longer in progress.");
        const manifest = await tx.auditEvent.findFirst({ where: { campaignId: campaign.id, type: AUDIT_EVENTS.CAMPAIGN_ROUTING }, orderBy: { createdAt: "asc" } });
        const routes: Record<string, string | null> = JSON.parse(manifest?.detail ?? "{}").routes ?? {};
        const selected = await tx.campaignSelection.findMany({ where: { campaignId: campaign.id }, include: { opportunity: true } });
        const approved = selected.filter(s => routes[s.opportunityId] === contactId);
        const itemIds = new Set(items.map(o => o.id));
        if (approved.length !== items.length || approved.some(({ opportunity: o }) => !itemIds.has(o.id) || o.contactId !== contactId || !o.isOpen || o.resolutionStatus !== "RESOLVED")) return null;
        const row = await tx.checkInRecipient.create({
          data: { campaignId: campaign.id, contactId, tokenHash: token.hash, tokenHint: token.hint, expiresAt },
        });
        await addItems(tx, row.id, items, 0);
        return row;
      });
    } catch (error) {
      if (!isRecipientClaimConflict(error)) throw error;
      continue;
    }

    if (!recipient || !sendEmails) continue;

    const result = await getEmailService().send(
      buildInviteEmail({
        contactName: contact.name,
        contactEmail: contact.email,
        organizationName: contact.account.name,
        opportunityCount: items.length,
        checkInUrl: checkInUrl(env.appBaseUrl, token.token),
        campaignId: campaign.id,
        contactId,
        copy: emailCopy,
      }),
    ).catch(() => ({ id: "", status: "UNCERTAIN" as const, error: "Invitation acceptance is unresolved. Reconcile before sending again." }));

    await prisma.$transaction(async (tx) => {
      if (result.status === "SENT") {
        emailsSent += 1;
        await tx.checkInRecipient.update({
          where: { id: recipient.id },
          data: { sentAt: new Date(), sendStatus: "SENT" },
        });
        await recordAudit({
          type: AUDIT_EVENTS.INVITE_SENT,
          summary: `Check-in sent to ${contact.name} at ${contact.account.name}`,
          actor,
          actorKind: "ADMIN",
          detail: `${items.length} opportunities · internal reps: ${[...new Set(items.map((i) => i.internalRep.name))].join(", ")}`,
          campaignId: campaign.id,
          contactId,
          accountId: contact.accountId,
        }, tx);
      } else {
        // Anything the provider contract does not name as FAILED is unknown, never a rejection.
        const outcome = result.status === "FAILED" ? "FAILED" : "UNCERTAIN";
        if (outcome === "FAILED") emailsFailed += 1;
        else emailsUncertain += 1;
        await tx.checkInRecipient.update({
          where: { id: recipient.id },
          data: { sendStatus: outcome, sendError: sanitizeProviderError(result.error) ?? "Unknown error" },
        });
        await recordAudit({
          type: outcome === "UNCERTAIN" ? AUDIT_EVENTS.INVITE_UNCERTAIN : AUDIT_EVENTS.INVITE_FAILED,
          summary: `Check-in email to ${contact.name} ${outcome === "UNCERTAIN" ? "has unresolved acceptance" : "failed"}`,
          actor,
          actorKind: "ADMIN",
          detail: sanitizeProviderError(result.error),
          campaignId: campaign.id,
          contactId,
          accountId: contact.accountId,
        }, tx);
      }
    });
  }

  const unresolved = await prisma.opportunity.count({
    where: { isOpen: true, resolutionStatus: "UNRESOLVED" },
  });

  await recordAudit({
    type: AUDIT_EVENTS.CAMPAIGN_CREATED,
    summary: `${campaign.name} ${options.resume ? "resumed" : "launched"} to ${byContact.size} external contacts covering ${opportunities.length} opportunities`,
    actor,
    actorKind: "ADMIN",
    campaignId: campaign.id,
    detail: `Source: ${getSalesforceService().info.label}${unresolved > 0 ? ` · ${unresolved} opportunities need a contact` : ""}${options.resume ? ` · ${(await getUnreachedOpportunityIds(campaign.id)).length} still unreached` : ""}`,
  });

  return {
    campaignId: campaign.id,
    name: campaign.name,
    recipients: byContact.size,
    opportunities: opportunities.length,
    emailsSent,
    emailsFailed,
    emailsUncertain,
    unresolvedOpportunities: unresolved,
  };
}

/** Marks the campaign COMPLETE once every recipient has finished and every persisted selection is reached. */
export async function closeCampaignIfDone(campaignId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.campaign.update({ where: { id: campaignId }, data: { id: campaignId } });
    const outstanding = await tx.checkInRecipient.count({ where: { campaignId, completedAt: null, revokedAt: null } });
    if (outstanding > 0) return;
    const selections = await tx.campaignSelection.findMany({ where: { campaignId }, select: { opportunityId: true } });
    const reached = await tx.checkInOpportunity.findMany({ where: { recipient: { campaignId } }, select: { opportunityId: true } });
    const reachedIds = new Set(reached.map(item => item.opportunityId));
    if (selections.some(selection => !reachedIds.has(selection.opportunityId))) return;
    await tx.campaign.updateMany({ where: { id: campaignId, status: "IN_PROGRESS", completedAt: null }, data: { status: "COMPLETE", completedAt: new Date() } });
  });
}

/**
 * Finish a half-sent launch: email every selected contact that has no recipient
 * row yet. Contacts that already have one are never re-sent.
 */
export async function resumeLaunch(campaignId: string, actor = "admin"): Promise<LaunchResult> {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (campaign.status !== "IN_PROGRESS") {
    throw new Error("Only an IN_PROGRESS campaign can be resumed.");
  }
  const opportunityIds = await getRecoverableOpportunityIds(campaignId);
  if (opportunityIds.length === 0) {
    await closeCampaignIfDone(campaignId);
    return {
      campaignId,
      name: campaign.name,
      recipients: 0,
      opportunities: 0,
      emailsSent: 0,
      emailsFailed: 0,
      unresolvedOpportunities: await prisma.opportunity.count({
        where: { isOpen: true, resolutionStatus: "UNRESOLVED" },
      }),
      unreachedAfter: (await getUnreachedOpportunityIds(campaignId)).length,
    };
  }
  const result = await launchCampaign({
    opportunityIds,
    campaignId,
    actor,
    emailCopy: readEmailCopy(campaign),
    resume: true,
  });
  await closeCampaignIfDone(campaignId);
  return { ...result, unreachedAfter: (await getUnreachedOpportunityIds(campaignId)).length };
}

/**
 * Re-issue a link and send the "you haven't completed your check-in" nudge.
 * The durable claim rotates the token before sending. A confirmed rejection
 * restores the prior link; unknown acceptance retains recovery evidence and
 * blocks another send. A crash cannot guarantee uninterrupted old-link access.
 */
export async function sendReminders(campaignId: string, actor = "admin"): Promise<number> {
  const recipients = await prisma.checkInRecipient.findMany({
    where: { campaignId, completedAt: null, revokedAt: null },
    include: { contact: { include: { account: true } }, campaign: true, items: true },
  });

  const expiresAt = new Date(Date.now() + env.checkInTokenTtlDays * 24 * 60 * 60 * 1000);
  let sent = 0;
  for (const recipient of recipients) {
    // PENDING and unknown invitation outcomes must never become resend orders.
    if (!recipient.items.length || recipient.sendStatus !== "SENT") continue;
    const token = issueToken();
    const metadata = JSON.stringify({ version: 1, attempt: randomUUID(), kind: "REMINDER", previous: {
      hash: recipient.tokenHash, hint: recipient.tokenHint, expiresAt: recipient.expiresAt.toISOString(),
    } });
    if (!readReminderRecovery(metadata)) throw new Error("Invalid reminder recovery metadata");
    const claim = await prisma.$transaction(async tx => {
      const claimed = await tx.checkInRecipient.updateMany({
        where: { id: recipient.id, tokenHash: recipient.tokenHash, sendStatus: "SENT", sendError: recipient.sendError, completedAt: null, revokedAt: null },
        data: { tokenHash: token.hash, tokenHint: token.hint, expiresAt, sendStatus: "REMINDER_PENDING", sendError: metadata },
      });
      if (claimed.count === 1) await recordAudit({ type: AUDIT_EVENTS.REMINDER_STARTED, summary: `Reminder attempt started for ${recipient.contact.name}`, actor, actorKind: "ADMIN", campaignId, contactId: recipient.contactId, detail: JSON.stringify({ attempt: JSON.parse(metadata).attempt }) }, tx);
      return claimed;
    });
    if (claim.count !== 1) continue;
    const result = await getEmailService().send(buildReminderEmail({
      contactName: recipient.contact.name, contactEmail: recipient.contact.email,
      organizationName: recipient.contact.account.name, opportunityCount: recipient.items.length,
      checkInUrl: checkInUrl(env.appBaseUrl, token.token), campaignId, contactId: recipient.contactId,
    })).catch((): EmailSendResult => ({ id: "", status: "UNCERTAIN" }));
    const safeError = sanitizeProviderError(result.error);
    await prisma.$transaction(async (tx) => {
      const finalized = await tx.checkInRecipient.updateMany({
        where: { id: recipient.id, tokenHash: token.hash, sendStatus: "REMINDER_PENDING", sendError: metadata },
        data: result.status === "SENT"
          ? { sendStatus: "SENT", sendError: null, remindedAt: new Date(), reminderCount: { increment: 1 } }
          : result.status === "FAILED"
            ? { sendStatus: "SENT", sendError: JSON.stringify({ ...JSON.parse(metadata), outcome: "FAILED", ...(safeError ? { error: safeError } : {}) }), tokenHash: recipient.tokenHash, tokenHint: recipient.tokenHint, expiresAt: recipient.expiresAt }
            : { sendStatus: "REMINDER_UNCERTAIN" },
      });
      if (finalized.count !== 1) throw new Error("Reminder claim changed; reconciliation required.");
      await recordAudit({
        type: result.status === "SENT" ? AUDIT_EVENTS.REMINDER_SENT : result.status === "FAILED" ? AUDIT_EVENTS.REMINDER_FAILED : AUDIT_EVENTS.REMINDER_UNCERTAIN,
        summary: result.status === "SENT" ? `Reminder sent to ${recipient.contact.name}` : result.status === "FAILED" ? `Reminder rejected for ${recipient.contact.name}; prior link restored` : `Reminder acceptance unresolved for ${recipient.contact.name}; manual reconciliation required`,
        actor, actorKind: "ADMIN", campaignId, contactId: recipient.contactId, accountId: recipient.contact.accountId,
        detail: JSON.stringify({ attempt: JSON.parse(metadata).attempt, outcome: result.status, ...(safeError ? { error: safeError } : {}) }),
      }, tx);
    });
    if (result.status === "SENT") sent += 1;
  }

  return sent;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export type RecipientProgress = {
  recipientId: string;
  contactId: string;
  contactName: string;
  contactEmail: string;
  accountName: string;
  accountType: string;
  opportunityCount: number;
  submittedCount: number;
  changedCount: number;
  syncErrorCount: number;
  internalRepNames: string[];
  status: RecipientStatus;
  sentAt: Date | null;
  openedAt: Date | null;
  completedAt: Date | null;
  reminderCount: number;
  tokenHint: string;
  deliveryNote?: string | null;
};

export type CampaignSummary = {
  id: string;
  name: string;
  period: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  opportunityCount: number;
  organizationCount: number;
  recipientCount: number;
  emailsSent: number;
  emailsFailed: number;
  openedCount: number;
  startedCount: number;
  completedCount: number;
  pendingCount: number;
  syncErrorCount: number;
  totalValue: number;
  /** All approved opportunities without invitation items, including unsafe drift. */
  unreachedCount: number;
  recoverableCount: number;
  unresolvedDeliveryCount: number;
  reminderEligibleCount: number;
  recipients: RecipientProgress[];
};

/**
 * Every approved selection without an invitation item remains visible, including
 * routing and eligibility drift that requires review. Revoked items count as reached.
 */
export async function getUnreachedOpportunityIds(campaignId: string): Promise<string[]> {
  const [selections, reached] = await Promise.all([
    prisma.campaignSelection.findMany({
      where: {
        campaignId,
      },
      select: { opportunityId: true },
    }),
    prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId } },
      select: { opportunityId: true },
    }),
  ]);
  const reachedIds = new Set(reached.map((item) => item.opportunityId));
  return selections.map((s) => s.opportunityId).filter((id) => !reachedIds.has(id));
}

/** Validate recovery evidence before it can be used by manual reconciliation. */
export function readReminderRecovery(value: string | null): { version: 1; attempt: string; kind: "REMINDER"; previous: { hash: string; hint: string; expiresAt: string } } | null {
  try {
    const data = JSON.parse(value ?? "null");
    if (data?.version !== 1 || data.kind !== "REMINDER" || !/^[0-9a-f-]{36}$/.test(data.attempt) ||
      !/^[0-9a-f]{64}$/.test(data.previous?.hash) || typeof data.previous.hint !== "string" || data.previous.hint.length > 16 ||
      typeof data.previous.expiresAt !== "string" || !Number.isFinite(Date.parse(data.previous.expiresAt))) return null;
    return data;
  } catch { return null; }
}

export const REMINDER_REJECTED_NOTE = "Reminder rejected; previous link restored";
const REMINDER_UNRESOLVED_NOTE = "Reminder pending or unresolved; reconcile provider records before replacing the link.";
const REMINDER_EVIDENCE_NOTE = "Reminder recovery evidence is on file; reconcile provider records before replacing the link.";

/** True only for the state the rejection branch writes: restored SENT plus a recognised payload with outcome FAILED. */
function isRejectedReminder(recipient: { sendStatus: string; sendError: string | null }): boolean {
  const recovery = readReminderRecovery(recipient.sendError) as { outcome?: unknown } | null;
  return recipient.sendStatus === "SENT" && recovery?.outcome === "FAILED";
}

/** Anything that looks like reminder recovery metadata, including a payload this version does not recognise. */
function looksLikeReminderRecovery(value: string | null): boolean {
  if (readReminderRecovery(value)) return true;
  try { return JSON.parse(value ?? "null")?.kind === "REMINDER"; } catch { return false; }
}

/**
 * The line an admin sees for a recipient's send state. Reminder recovery
 * metadata, recognised or not, is always summarised and never printed: the
 * stored JSON (attempt id, previous hash, hint, expiry, outcome) stays in the
 * database. "Previous link restored" is only claimed for a definite rejection.
 */
export function recipientSendNote(recipient: { sendStatus: string; sendError: string | null }): string | null {
  if (recipient.sendStatus.startsWith("REMINDER_")) return REMINDER_UNRESOLVED_NOTE;
  if (isRejectedReminder(recipient)) return `${REMINDER_REJECTED_NOTE}.`;
  if (looksLikeReminderRecovery(recipient.sendError)) return REMINDER_EVIDENCE_NOTE;
  return recipient.sendError;
}

export async function getRecoverableOpportunityIds(campaignId: string): Promise<string[]> {
  const [manifest, selections, recipients, missing] = await Promise.all([
    prisma.auditEvent.findFirst({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING }, orderBy: { createdAt: "asc" } }),
    prisma.campaignSelection.findMany({ where: { campaignId }, include: { opportunity: true } }),
    prisma.checkInRecipient.findMany({ where: { campaignId }, select: { contactId: true } }),
    getUnreachedOpportunityIds(campaignId),
  ]);
  let routes: Record<string, string | null>;
  try {
    const data = JSON.parse(manifest?.detail ?? "null");
    if (data?.version !== 1 || !data.routes || typeof data.routes !== "object" || Array.isArray(data.routes)) return [];
    routes = data.routes;
  } catch { return []; }
  const existing = new Set(recipients.map(r => r.contactId));
  const missingSet = new Set(missing);
  const unsafe = new Set<string>();
  for (const { opportunity: o } of selections) {
    const original = routes[o.id];
    if (typeof original === "string" && (!o.isOpen || o.resolutionStatus !== "RESOLVED" || o.contactId !== original)) unsafe.add(original);
  }
  return selections.flatMap(({ opportunity: o }) =>
    missingSet.has(o.id) && o.contactId && routes[o.id] === o.contactId && o.isOpen && o.resolutionStatus === "RESOLVED" && !existing.has(o.contactId) && !unsafe.has(o.contactId) ? [o.id] : []);
}

export async function getCampaignSummary(campaignId: string): Promise<CampaignSummary | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      recipients: {
        include: { contact: { include: { account: true } }, items: true },
      },
    },
  });
  if (!campaign) return null;

  const recipients: RecipientProgress[] = campaign.recipients
    .map((recipient) => {
      const submitted = recipient.items.filter((item) => item.submittedAt !== null);
      const syncErrors = recipient.items.filter((item) => item.syncStatus === "FAILED");
      const changed = submitted.filter(
        (item) => item.updatedStatus !== null && item.updatedStatus !== item.previousStatus,
      );

      return {
        recipientId: recipient.id,
        contactId: recipient.contactId,
        contactName: recipient.contact.name,
        contactEmail: recipient.contact.email,
        accountName: recipient.contact.account.name,
        accountType: recipient.contact.account.type,
        opportunityCount: recipient.items.length,
        submittedCount: submitted.length,
        changedCount: changed.length,
        syncErrorCount: syncErrors.length,
        internalRepNames: [...new Set(recipient.items.map((item) => item.internalRepName))].sort(),
        status: deriveRecipientStatus({
          sendStatus: recipient.sendStatus,
          sentAt: recipient.sentAt,
          openedAt: recipient.openedAt,
          completedAt: recipient.completedAt,
          submittedCount: submitted.length,
          syncErrorCount: syncErrors.length,
        }),
        sentAt: recipient.sentAt,
        openedAt: recipient.openedAt,
        completedAt: recipient.completedAt,
        reminderCount: recipient.reminderCount,
        tokenHint: recipient.tokenHint,
        deliveryNote: isRejectedReminder(recipient) ? REMINDER_REJECTED_NOTE : null,
      };
    })
    .sort((a, b) => a.contactName.localeCompare(b.contactName));

  const items = campaign.recipients.flatMap((recipient) => recipient.items);
  const unreachedCount = (await getUnreachedOpportunityIds(campaignId)).length;

  return {
    id: campaign.id,
    name: campaign.name,
    period: campaign.period,
    status: campaign.status,
    createdAt: campaign.createdAt,
    startedAt: campaign.startedAt,
    completedAt: campaign.completedAt,
    opportunityCount: items.length,
    organizationCount: new Set(recipients.map((r) => r.accountName)).size,
    recipientCount: recipients.length,
    emailsSent: recipients.filter((r) => r.sentAt !== null).length,
    emailsFailed: recipients.filter((r) => r.status === "SEND_FAILED").length,
    openedCount: recipients.filter((r) => r.openedAt !== null).length,
    startedCount: recipients.filter((r) => r.submittedCount > 0).length,
    completedCount: recipients.filter((r) => r.status === "COMPLETE").length,
    pendingCount: recipients.filter((r) =>
      ["PENDING", "SENT", "OPENED", "IN_PROGRESS"].includes(r.status),
    ).length,
    syncErrorCount: recipients.filter((r) => r.status === "SYNC_ERROR").length,
    totalValue: items.reduce((sum, item) => sum + item.amount, 0),
    unreachedCount,
    recoverableCount: (await getRecoverableOpportunityIds(campaignId)).length,
    reminderEligibleCount: campaign.recipients.filter(r => r.sendStatus === "SENT" && !r.completedAt && !r.revokedAt && r.items.length > 0).length,
    unresolvedDeliveryCount: campaign.recipients.filter(r => ["PENDING", "UNCERTAIN", "REMINDER_PENDING", "REMINDER_UNCERTAIN"].includes(r.sendStatus)).length,
    recipients,
  };
}

export function deriveRecipientStatus(input: {
  sendStatus: string;
  sentAt: Date | null;
  openedAt: Date | null;
  completedAt: Date | null;
  submittedCount: number;
  syncErrorCount: number;
}): RecipientStatus {
  if (input.sendStatus === "FAILED") return "SEND_FAILED";
  if (input.syncErrorCount > 0) return "SYNC_ERROR";
  if (input.completedAt) return "COMPLETE";
  if (["UNCERTAIN", "REMINDER_PENDING", "REMINDER_UNCERTAIN"].includes(input.sendStatus)) return "SEND_UNCERTAIN";
  if (input.submittedCount > 0) return "IN_PROGRESS";
  if (input.openedAt) return "OPENED";
  if (input.sentAt) return "SENT";
  return "PENDING";
}

export async function listCampaigns(): Promise<CampaignSummary[]> {
  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
  const summaries = await Promise.all(
    campaigns.map((campaign) => getCampaignSummary(campaign.id)),
  );
  return summaries.filter((summary): summary is CampaignSummary => summary !== null);
}

export async function getLatestCampaign(): Promise<CampaignSummary | null> {
  const campaign = await prisma.campaign.findFirst({ orderBy: { createdAt: "desc" } });
  return campaign ? getCampaignSummary(campaign.id) : null;
}

/** All submitted responses for a campaign — the admin review list. */
export async function listResponses(campaignId: string) {
  return prisma.checkInOpportunity.findMany({
    where: { recipient: { campaignId }, submittedAt: { not: null } },
    include: { recipient: { include: { contact: { include: { account: true } } } } },
    orderBy: [{ submittedAt: "desc" }],
  });
}
