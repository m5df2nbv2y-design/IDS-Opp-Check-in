import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { checkInUrl, issueToken } from "@/lib/tokens";
import { getEmailService } from "@/server/integrations/email";
import {
  buildInviteEmail,
  buildReminderEmail,
} from "@/server/integrations/email/templates/check-in-email";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";

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
};

/**
 * Group opportunities by external contact, create one recipient per contact,
 * mint a token, and send one personalized email each. A contact responsible for
 * opportunities belonging to three different IDS reps receives ONE email
 * covering all of them.
 *
 * `opportunityIds` scopes the launch to an explicit, human-selected set. It is
 * REQUIRED for any admin-initiated send — there is deliberately no code path
 * that launches against the whole catalog from the UI. Omitting it (the seed
 * script and tests) falls back to every resolved opportunity, which is why the
 * seed is guarded by assertDemoEnvironment().
 */
export async function launchCampaign(options?: {
  name?: string;
  period?: string;
  actor?: string;
  sendEmails?: boolean;
  /** Explicit selection. When omitted, every resolved opportunity is included. */
  opportunityIds?: string[];
  /** Convert this existing DRAFT campaign rather than creating a new one. */
  campaignId?: string;
}): Promise<LaunchResult> {
  const actor = options?.actor ?? "admin";
  const period = options?.period ?? currentPeriod();
  const name = options?.name ?? `${period} Check-In`;
  const sendEmails = options?.sendEmails ?? true;

  const opportunities = await prisma.opportunity.findMany({
    where: {
      isOpen: true,
      resolutionStatus: "RESOLVED",
      contactId: { not: null },
      ...(options?.opportunityIds ? { id: { in: options.opportunityIds } } : {}),
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

  const campaign = options?.campaignId
    ? await prisma.campaign.update({
        where: { id: options.campaignId },
        data: { name, status: "IN_PROGRESS", startedAt: new Date() },
      })
    : await prisma.campaign.create({
        data: { name, period, status: "IN_PROGRESS", startedAt: new Date() },
      });

  const expiresAt = new Date(Date.now() + env.checkInTokenTtlDays * 24 * 60 * 60 * 1000);
  let emailsSent = 0;
  let emailsFailed = 0;

  for (const [contactId, items] of byContact) {
    const contact = items[0].contact!;
    const token = issueToken();

    const recipient = await prisma.checkInRecipient.create({
      data: {
        campaignId: campaign.id,
        contactId,
        tokenHash: token.hash,
        tokenHint: token.hint,
        expiresAt,
      },
    });

    await prisma.checkInOpportunity.createMany({
      data: items.map((opportunity, index) => ({
        recipientId: recipient.id,
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
        position: index,
      })),
    });

    if (!sendEmails) continue;

    const result = await getEmailService().send(
      buildInviteEmail({
        contactName: contact.name,
        contactEmail: contact.email,
        organizationName: contact.account.name,
        opportunityCount: items.length,
        checkInUrl: checkInUrl(env.appBaseUrl, token.token),
        campaignId: campaign.id,
        contactId,
      }),
    );

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
        data: { sendStatus: "FAILED", sendError: result.error ?? "Unknown error" },
      });
      await recordAudit({
        type: AUDIT_EVENTS.INVITE_FAILED,
        summary: `Check-in email to ${contact.name} failed`,
        actor,
        actorKind: "ADMIN",
        detail: result.error ?? null,
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
    summary: `${campaign.name} launched to ${byContact.size} external contacts covering ${opportunities.length} opportunities`,
    actor,
    actorKind: "ADMIN",
    campaignId: campaign.id,
    detail: `Source: ${getSalesforceService().info.label}${unresolved > 0 ? ` · ${unresolved} opportunities need a contact` : ""}`,
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
 * Re-issue a link and send the "you haven't completed your check-in" nudge.
 * The token is rotated, which invalidates the previous link — the reminder is
 * always the newest valid entry point.
 */
export async function sendReminders(campaignId: string, actor = "admin"): Promise<number> {
  const recipients = await prisma.checkInRecipient.findMany({
    where: { campaignId, completedAt: null, revokedAt: null },
    include: { contact: { include: { account: true } }, campaign: true, items: true },
  });

  const expiresAt = new Date(Date.now() + env.checkInTokenTtlDays * 24 * 60 * 60 * 1000);
  let sent = 0;

  for (const recipient of recipients) {
    if (recipient.items.length === 0) continue;

    const token = issueToken();
    await prisma.checkInRecipient.update({
      where: { id: recipient.id },
      data: { tokenHash: token.hash, tokenHint: token.hint, expiresAt },
    });

    const result = await getEmailService().send(
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

    if (result.status === "SENT") {
      sent += 1;
      await prisma.checkInRecipient.update({
        where: { id: recipient.id },
        data: { remindedAt: new Date(), reminderCount: { increment: 1 } },
      });
      await recordAudit({
        type: AUDIT_EVENTS.REMINDER_SENT,
        summary: `Reminder sent to ${recipient.contact.name} at ${recipient.contact.account.name}`,
        actor,
        actorKind: "ADMIN",
        campaignId,
        contactId: recipient.contactId,
        accountId: recipient.contact.accountId,
      });
    }
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
  recipients: RecipientProgress[];
};

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
