import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { DraftEmailConflictError, readEmailCopy, validateEmailCopy, type EmailCopy } from "@/lib/check-in-copy";
import { checkInUrl, issueToken } from "@/lib/tokens";
import { getEmailService } from "@/server/integrations/email";
import {
  buildInviteEmail,
  buildReminderEmail,
} from "@/server/integrations/email/templates/check-in-email";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { AUDIT_EVENTS, recordAudit, type AuditEventType } from "./audit-service";
import { recordSnapshot, SNAPSHOT_SOURCES } from "./snapshot-service";

/** Provider text for the audit table: no URLs or check-in paths (they can carry a token), capped length. */
export function safeErrorText(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\/checkin\/\S*/gi, "[link removed]")
    .slice(0, 300);
}

export type RecipientStatus =
  | "PENDING"
  | "SENT"
  | "OPENED"
  | "IN_PROGRESS"
  | "COMPLETE"
  | "SYNC_ERROR"
  | "SEND_FAILED";

export const RECIPIENT_STATUS_LABELS: Record<RecipientStatus, string> = {
  PENDING: "Not Sent",
  SENT: "Sent",
  OPENED: "Opened",
  IN_PROGRESS: "In Progress",
  COMPLETE: "Complete",
  SYNC_ERROR: "Sync Error",
  SEND_FAILED: "Send Failed",
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
  unresolvedOpportunities: number;
  /** Set only by resumeLaunch: selected opportunities still unreached after the run. */
  unreachedAfter?: number;
};

/** A recipient younger than this may belong to a launch still building it. */
const ORPHAN_GRACE_MS = 2 * 60_000;

/** True only for a unique violation on (campaignId, contactId), not e.g. tokenHash. */
function isRecipientClaimConflict(error: unknown): boolean {
  type Constraint = { index?: unknown; fields?: unknown };
  type Meta = { target?: unknown; driverAdapterError?: { cause?: { constraint?: Constraint } } };
  const e = error as { code?: string; meta?: Meta } | null;
  if (e?.code !== "P2002") return false;
  const constraint = e.meta?.driverAdapterError?.cause?.constraint;
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

  const byContact = new Map<string, typeof opportunities>();
  for (const opportunity of opportunities) {
    const list = byContact.get(opportunity.contactId!);
    if (list) list.push(opportunity);
    else byContact.set(opportunity.contactId!, [opportunity]);
  }

  if (!options.resume && options.campaignId && options.expectedEmailRevision !== undefined) {
    const claimed = await prisma.campaign.updateMany({
      where: { id: options.campaignId, status: "DRAFT", emailRevision: options.expectedEmailRevision },
      data: { name, status: "IN_PROGRESS", startedAt: new Date() },
    });
    if (claimed.count !== 1) throw new DraftEmailConflictError("The email draft changed or was already sent. Reload and review it again.");
  }

  const campaign = options.campaignId
    ? options.resume || options.expectedEmailRevision !== undefined
      ? await prisma.campaign.findUniqueOrThrow({ where: { id: options.campaignId } })
      : await prisma.campaign.update({
        where: { id: options.campaignId },
        data: { name, status: "IN_PROGRESS", startedAt: new Date() },
      })
    : await prisma.campaign.create({
        data: { name, period, status: "IN_PROGRESS", startedAt: new Date() },
      });

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

  const expiresAt = new Date(Date.now() + env.checkInTokenTtlDays * 24 * 60 * 60 * 1000);
  let emailsSent = 0;
  let emailsFailed = 0;

  /** Attach items to a recipient and mark the intervention point on the observation timeline. */
  const addItems = async (recipientId: string, items: typeof opportunities, startPosition: number) => {
    await prisma.checkInOpportunity.createMany({
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
      });
    }
  };

  for (const [contactId, items] of byContact) {
    const contact = items[0].contact!;
    const token = issueToken();

    // The (campaignId, contactId) unique constraint is the claim: if another
    // launch or resume created this contact first, skip — it owns the send.
    let recipient;
    try {
      recipient = await prisma.checkInRecipient.create({
        data: {
          campaignId: campaign.id,
          contactId,
          tokenHash: token.hash,
          tokenHint: token.hint,
          expiresAt,
        },
      });
    } catch (error) {
      if (!isRecipientClaimConflict(error)) throw error;
      if (options.resume) {
        // Already invited by an earlier launch: attach any missing items to the
        // live link instead of emailing again. Done or revoked links get nothing;
        // a sendable opportunity left that way is reported via `unreachedAfter`, not fixed here.
        const existing = await prisma.checkInRecipient.findUnique({
          where: { campaignId_contactId: { campaignId: campaign.id, contactId } },
          include: { items: { select: { opportunityId: true, position: true } } },
        });
        // A fresh, item-less, unsent recipient is still being built by whoever
        // created it; that run attaches the items itself, so leave it alone.
        const beingBuilt =
          existing !== null &&
          existing.items.length === 0 &&
          existing.sendStatus === "PENDING" &&
          existing.sentAt === null &&
          existing.createdAt.getTime() > Date.now() - ORPHAN_GRACE_MS;
        if (existing && !beingBuilt && !existing.completedAt && !existing.revokedAt) {
          const have = new Set(existing.items.map((i) => i.opportunityId));
          const missing = items.filter((i) => !have.has(i.id));
          if (missing.length > 0) {
            const next = Math.max(-1, ...existing.items.map((i) => i.position)) + 1;
            try {
              await addItems(existing.id, missing, next);
            } catch (addError) {
              // A rival run attached some of these first: the pair is already
              // reached, which is the goal. Anything else is a real failure.
              if ((addError as { code?: string })?.code !== "P2002") throw addError;
            }
          }
        }
      }
      continue;
    }

    await addItems(recipient.id, items, 0);

    if (!sendEmails) continue;

    let result: { status: string; error?: string };
    try {
      result = await getEmailService().send(
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
    );
    } catch (err) {
      // Never retried: the mail may or may not have gone. Record it so it is not silently "reached".
      result = { status: "FAILED", error: safeErrorText(err instanceof Error ? err.message : "send threw") };
    }

    if (result.status === "SENT") {
      emailsSent += 1;
      await prisma.checkInRecipient.update({
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
      });
    } else {
      emailsFailed += 1;
      await prisma.checkInRecipient.update({
        where: { id: recipient.id },
        data: { sendStatus: "FAILED", sendError: safeErrorText(result.error ?? "Unknown error") },
      });
      await recordAudit({
        type: AUDIT_EVENTS.INVITE_FAILED,
        summary: `Check-in email to ${contact.name} failed`,
        actor,
        actorKind: "ADMIN",
        detail: result.error ? safeErrorText(result.error) : null,
        campaignId: campaign.id,
        contactId,
        accountId: contact.accountId,
      });
    }
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
    unresolvedOpportunities: unresolved,
  };
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
  // Crash orphans: a recipient created but never given items or sent.
  await prisma.checkInRecipient.deleteMany({
    where: {
      campaignId,
      sendStatus: "PENDING",
      sentAt: null,
      items: { none: {} },
      createdAt: { lt: new Date(Date.now() - ORPHAN_GRACE_MS) },
    },
  });
  const opportunityIds = await getUnreachedOpportunityIds(campaignId);
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
      unreachedAfter: 0,
    };
  }
  const result = await launchCampaign({
    opportunityIds,
    campaignId,
    actor,
    emailCopy: readEmailCopy(campaign),
    resume: true,
  });
  const unreachedAfter = (await getUnreachedOpportunityIds(campaignId)).length;
  await closeCampaignIfDone(campaignId);
  return { ...result, unreachedAfter };
}

/**
 * Re-issue a link and send the "you haven't completed your check-in" nudge.
 * The token is rotated, which invalidates the previous link — the reminder is
 * always the newest valid entry point.
 */
export async function sendReminders(
  campaignId: string,
  actor = "admin",
): Promise<{ sent: number; failed: number; skipped: number }> {
  const recipients = await prisma.checkInRecipient.findMany({
    where: { campaignId, completedAt: null, revokedAt: null },
    include: { contact: { include: { account: true } }, campaign: true, items: true },
  });

  const expiresAt = new Date(Date.now() + env.checkInTokenTtlDays * 24 * 60 * 60 * 1000);
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const recipient of recipients) {
    if (recipient.items.length === 0) {
      skipped += 1;
      continue;
    }

    const who = `${recipient.contact.name} at ${recipient.contact.account.name}`;
    const audit = (type: AuditEventType, summary: string, detail?: string) =>
      recordAudit({
        type,
        summary,
        detail,
        actor,
        actorKind: "ADMIN",
        campaignId,
        contactId: recipient.contactId,
        accountId: recipient.contact.accountId,
      });

    const token = issueToken();
    // CAS rotation and the attempt row commit together: a lost race leaves no attempt row, a crash
    // after rotation leaves an attempt with no outcome. Hint only, never the token.
    const rotated = await prisma.$transaction(async (tx) => {
      const r = await tx.checkInRecipient.updateMany({
        where: { id: recipient.id, completedAt: null, revokedAt: null, tokenHash: recipient.tokenHash },
        data: { tokenHash: token.hash, tokenHint: token.hint, expiresAt },
      });
      if (r.count > 0) {
        await tx.auditEvent.create({
          data: {
            type: AUDIT_EVENTS.REMINDER_ATTEMPTED,
            summary: `Reminder attempted for ${who}`,
            detail: `new token hint ${token.hint}`,
            actor,
            actorKind: "ADMIN",
            campaignId,
            contactId: recipient.contactId,
            accountId: recipient.contact.accountId,
          },
        });
      }
      return r.count;
    });
    if (rotated === 0) {
      skipped += 1;
      continue;
    }

    const restore = () =>
      prisma.checkInRecipient.updateMany({
        where: { id: recipient.id, tokenHash: token.hash },
        data: { tokenHash: recipient.tokenHash, tokenHint: recipient.tokenHint, expiresAt: recipient.expiresAt },
      });

    let result: Awaited<ReturnType<ReturnType<typeof getEmailService>["send"]>> | undefined;
    let thrown: string | undefined;
    try {
      result = await getEmailService().send(
        buildReminderEmail({
          contactName: recipient.contact.name,
          contactEmail: recipient.contact.email,
          organizationName: recipient.contact.account.name,
          opportunityCount: recipient.items.length,
          checkInUrl: checkInUrl(env.appBaseUrl, token.token),
          campaignId,
          contactId: recipient.contactId,
        }),
      );
    } catch (err) {
      thrown = err instanceof Error ? err.message : "unknown error";
    }

    // A failure while recording the outcome must not abort the rest of the batch.
    const log = (err: unknown) =>
      console.error(`sendReminders: could not record outcome for recipient ${recipient.id}`, err);
    try {
      if (result?.status === "SENT") {
        sent += 1;
        await prisma.checkInRecipient.update({
          where: { id: recipient.id },
          data: { remindedAt: new Date(), reminderCount: { increment: 1 } },
        });
        await audit(AUDIT_EVENTS.REMINDER_SENT, `Reminder sent to ${who}`);
      } else if (thrown !== undefined || result?.status === "FAILED") {
        failed += 1;
        try {
          await restore();
        } catch (err) {
          log(err);
        }
        await audit(
          AUDIT_EVENTS.REMINDER_FAILED,
          `Reminder failed for ${who}`,
          thrown !== undefined
            ? `send threw before an outcome was known: ${safeErrorText(thrown)}`
            : safeErrorText(result?.error ?? "send failed"),
        );
      } else {
        // Unknown outcome: the email may have been delivered, so keep the new token and never retry.
        failed += 1;
        await audit(
          AUDIT_EVENTS.REMINDER_FAILED,
          `Reminder outcome unknown for ${who}`,
          `Outcome unknown (status ${String(result?.status)}); new token kept, not restored`,
        );
      }
    } catch (err) {
      log(err);
    }
  }

  return { sent, failed, skipped };
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
  /** Selected, still-sendable opportunities that no recipient of this campaign received. */
  unreachedCount: number;
  recipients: RecipientProgress[];
};

/**
 * Selections that should have produced a check-in item but did not (a half-sent
 * launch). Opportunities that are no longer open/resolved cannot be sent, so
 * they are not a shortfall. A revoked recipient's items still count as reached.
 */
export async function getUnreachedOpportunityIds(campaignId: string): Promise<string[]> {
  const [selections, reached] = await Promise.all([
    prisma.campaignSelection.findMany({
      where: {
        campaignId,
        opportunity: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
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

/** Marks the campaign COMPLETE once every recipient has finished. */
export async function closeCampaignIfDone(campaignId: string): Promise<void> {
  const outstanding = await prisma.checkInRecipient.count({
    where: { campaignId, completedAt: null, revokedAt: null },
  });
  if (outstanding > 0) return;
  // A half-sent launch is not finished just because everyone it reached is.
  if ((await getUnreachedOpportunityIds(campaignId)).length > 0) return;

  await prisma.campaign.updateMany({
    where: { id: campaignId, completedAt: null },
    data: { status: "COMPLETE", completedAt: new Date() },
  });
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
