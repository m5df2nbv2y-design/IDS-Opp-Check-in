import { prisma } from "@/lib/db";

/**
 * Append-only audit trail. Every entry carries the full picture of a change:
 * which opportunity, at which organization, updated by which external contact,
 * for which internal IDS rep, in which campaign, and what Salesforce did.
 */
export const AUDIT_EVENTS = {
  CAMPAIGN_CREATED: "CAMPAIGN_CREATED",
  INVITE_SENT: "INVITE_SENT",
  INVITE_FAILED: "INVITE_FAILED",
  REMINDER_SENT: "REMINDER_SENT",
  CHECKIN_OPENED: "CHECKIN_OPENED",
  RESPONSE_SUBMITTED: "RESPONSE_SUBMITTED",
  RESPONSE_REVISED: "RESPONSE_REVISED",
  CHECKIN_COMPLETED: "CHECKIN_COMPLETED",
  SYNC_SUCCEEDED: "SYNC_SUCCEEDED",
  SYNC_FAILED: "SYNC_FAILED",
  SYNC_SKIPPED: "SYNC_SKIPPED",
  CATALOG_REFRESHED: "CATALOG_REFRESHED",
} as const;

export type AuditEventType = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];
export type ActorKind = "EXTERNAL_CONTACT" | "ADMIN" | "SYSTEM";

export type AuditInput = {
  type: AuditEventType;
  summary: string;
  actor: string;
  actorKind?: ActorKind;
  fromStatus?: string | null;
  toStatus?: string | null;
  detail?: string | null;
  campaignId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  repId?: string | null;
  opportunityId?: string | null;
};

export async function recordAudit(input: AuditInput) {
  return prisma.auditEvent.create({
    data: {
      type: input.type,
      summary: input.summary,
      actor: input.actor,
      actorKind: input.actorKind ?? "SYSTEM",
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      detail: input.detail ?? null,
      campaignId: input.campaignId ?? null,
      accountId: input.accountId ?? null,
      contactId: input.contactId ?? null,
      repId: input.repId ?? null,
      opportunityId: input.opportunityId ?? null,
    },
  });
}

export async function listAuditEvents(options?: { campaignId?: string; limit?: number }) {
  return prisma.auditEvent.findMany({
    where: options?.campaignId ? { campaignId: options.campaignId } : undefined,
    orderBy: { createdAt: "desc" },
    take: options?.limit ?? 150,
    include: {
      campaign: { select: { name: true } },
      account: { select: { name: true } },
      contact: { select: { name: true } },
      rep: { select: { name: true } },
      opportunity: { select: { customerName: true, opportunityName: true } },
    },
  });
}
