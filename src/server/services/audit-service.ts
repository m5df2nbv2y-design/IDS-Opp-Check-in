import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Append-only audit trail. Every entry carries the full picture of a change:
 * which opportunity, at which organization, updated by which external contact,
 * for which internal IDS rep, in which campaign, and what Salesforce did.
 */
export const AUDIT_EVENTS = {
  CAMPAIGN_CREATED: "CAMPAIGN_CREATED",
  CAMPAIGN_EMAIL_DRAFTED: "CAMPAIGN_EMAIL_DRAFTED",
  INVITE_SENT: "INVITE_SENT",
  INVITE_FAILED: "INVITE_FAILED",
  INVITE_UNCERTAIN: "INVITE_UNCERTAIN",
  /**
   * An administrator settled an invitation whose provider outcome was never
   * learned, from what they saw in the sending mailbox. A human assertion, kept
   * distinct from INVITE_SENT / INVITE_FAILED, which record what the provider said.
   */
  INVITE_RECONCILED_SENT: "INVITE_RECONCILED_SENT",
  INVITE_RECONCILED_NOT_SENT: "INVITE_RECONCILED_NOT_SENT",
  /** An admin started a re-send of a FAILED invitation with a fresh link. The outcome is INVITE_SENT / INVITE_FAILED / INVITE_UNCERTAIN. */
  INVITE_RESEND_STARTED: "INVITE_RESEND_STARTED",
  REMINDER_STARTED: "REMINDER_STARTED",
  REMINDER_SENT: "REMINDER_SENT",
  REMINDER_FAILED: "REMINDER_FAILED",
  REMINDER_UNCERTAIN: "REMINDER_UNCERTAIN",
  /** A reminder was withheld: an item's opportunity closed, moved or is no longer resolved. detail: { reason }. */
  REMINDER_SKIPPED: "REMINDER_SKIPPED",
  CAMPAIGN_ROUTING: "CAMPAIGN_ROUTING",
  /** An admin excluded a shortfall opportunity that cannot resume. detail: { version: 1, opportunityId, reason }. Undone by SELECTION_RESTORED. */
  SELECTION_EXCLUDED: "SELECTION_EXCLUDED",
  /** An admin restored an excluded opportunity to the shortfall, reopening a COMPLETE campaign when it is unreached. detail: { version: 1, opportunityId }. */
  SELECTION_RESTORED: "SELECTION_RESTORED",
  /** An admin closed out a held-back contact by revoking their link. detail: { version: 1, recipientId, tokenHint, reason }. Undone by RECIPIENT_RESTORED. */
  RECIPIENT_CLOSED_OUT: "RECIPIENT_CLOSED_OUT",
  /** An admin restored a closed-out contact's existing link, reopening a COMPLETE campaign. detail: { version: 1, recipientId, tokenHint }. */
  RECIPIENT_RESTORED: "RECIPIENT_RESTORED",
  CHECKIN_OPENED: "CHECKIN_OPENED",
  RESPONSE_SUBMITTED: "RESPONSE_SUBMITTED",
  RESPONSE_REVISED: "RESPONSE_REVISED",
  CHECKIN_COMPLETED: "CHECKIN_COMPLETED",
  SYNC_SUCCEEDED: "SYNC_SUCCEEDED",
  SYNC_FAILED: "SYNC_FAILED",
  SYNC_SKIPPED: "SYNC_SKIPPED",
  SYNC_WITHHELD: "SYNC_WITHHELD",
  /**
   * An administrator reconciled an UNCERTAIN write by hand and attested to what
   * they saw in Salesforce. Deliberately distinct from SYNC_SUCCEEDED and
   * SYNC_FAILED, which record what the API told us: these two record what a
   * person told us. Collapsing them would let a human assertion masquerade as
   * an observed provider result in the audit trail.
   */
  SYNC_RECONCILED_APPLIED: "SYNC_RECONCILED_APPLIED",
  SYNC_RECONCILED_NOT_APPLIED: "SYNC_RECONCILED_NOT_APPLIED",
  CATALOG_REFRESHED: "CATALOG_REFRESHED",
  OPPORTUNITY_CLOSED: "OPPORTUNITY_CLOSED",
  SIGNAL_INGESTED: "SIGNAL_INGESTED",
  SIGNAL_REVIEWED: "SIGNAL_REVIEWED",
  SIGNAL_DRAFTED: "SIGNAL_DRAFTED",
  REPORT_EXPORTED: "REPORT_EXPORTED",
  TEST_EMAIL_SENT: "TEST_EMAIL_SENT",
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

export async function recordAudit(input: AuditInput, db: Prisma.TransactionClient = prisma) {
  return db.auditEvent.create({
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

/**
 * Persistence-time defense for provider-returned text: drops URLs and check-in
 * paths (bearer links) and caps length. It does not claim to redact every secret.
 */
export function sanitizeProviderError(text: unknown): string | null {
  if (typeof text !== "string") return null;
  return text.replace(/\bhttps?:\/\/\S*/gi, "[link removed]").replace(/\/checkin\/\S*/gi, "[link removed]").slice(0, 300);
}
