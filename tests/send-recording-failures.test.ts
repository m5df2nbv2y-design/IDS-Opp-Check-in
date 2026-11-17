import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { launchCampaign, sendReminders } from "@/server/services/campaign-service";
import * as audit from "@/server/services/audit-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/**
 * PR #13 findings 5 and 6: once the provider has accepted an email, a failure to
 * RECORD that outcome must cost only that one recipient's certainty, never the
 * rest of the batch.
 */

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

/** Fails the first audit of `type`, passes everything else through. */
function failFirstAudit(type: string) {
  const original = audit.recordAudit;
  let failed = false;
  vi.spyOn(audit, "recordAudit").mockImplementation(async (input, db) => {
    if (!failed && input.type === type) { failed = true; throw new Error("database unavailable"); }
    return original(input, db);
  });
}

describe("launch", () => {
  it("a sent invitation whose recording fails is UNCERTAIN, counted as unknown, and the launch carries on", async () => {
    await refreshCatalogFromSalesforce("test");
    const opportunities = await prisma.opportunity.findMany({ where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } }, select: { id: true, contactId: true } });
    const contacts = new Set(opportunities.map((o) => o.contactId)).size;
    expect(contacts).toBeGreaterThan(1);
    const send = vi.spyOn(getEmailService(), "send");
    failFirstAudit(audit.AUDIT_EVENTS.INVITE_SENT);

    const result = await launchCampaign({ opportunityIds: opportunities.map((o) => o.id), name: "Recording", period: "T", actor: "test" });

    expect(send).toHaveBeenCalledTimes(contacts);
    expect(result).toMatchObject({ recipients: contacts, emailsSent: contacts - 1, emailsFailed: 0, emailsUncertain: 1 });
    const rows = await prisma.checkInRecipient.findMany({ where: { campaignId: result.campaignId } });
    expect(rows.filter((r) => r.sendStatus === "SENT")).toHaveLength(contacts - 1);
    const unknown = rows.filter((r) => r.sendStatus === "UNCERTAIN");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].sentAt).toBeNull();
    expect(unknown[0].sendError).toMatch(/not recorded/);
    // The rolled-back success leaves no INVITE_SENT; the fallback leaves INVITE_UNCERTAIN.
    expect(await prisma.auditEvent.count({ where: { campaignId: result.campaignId, contactId: unknown[0].contactId, type: audit.AUDIT_EVENTS.INVITE_SENT } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { campaignId: result.campaignId, contactId: unknown[0].contactId, type: audit.AUDIT_EVENTS.INVITE_UNCERTAIN } })).toBe(1);
  });

  it("a confirmed rejection whose recording fails stays FAILED, not unknown", async () => {
    await refreshCatalogFromSalesforce("test");
    const opportunities = await prisma.opportunity.findMany({ where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } }, select: { id: true } });
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "", status: "FAILED", error: "rejected" });
    failFirstAudit(audit.AUDIT_EVENTS.INVITE_FAILED);

    const result = await launchCampaign({ opportunityIds: opportunities.map((o) => o.id), name: "Rejected", period: "T", actor: "test" });

    expect(result.emailsUncertain).toBe(0);
    expect(result.emailsFailed).toBe(result.recipients);
    expect(await prisma.checkInRecipient.count({ where: { campaignId: result.campaignId, sendStatus: { not: "FAILED" } } })).toBe(0);
  });
});

describe("reminders", () => {
  let campaignId: string;
  beforeEach(async () => {
    campaignId = (await launchCampaignAndCollectTokens()).campaignId;
    expect(await prisma.checkInRecipient.count({ where: { campaignId, sendStatus: "SENT" } })).toBeGreaterThan(1);
  });
  const eligible = () => prisma.checkInRecipient.count({ where: { campaignId, completedAt: null, revokedAt: null, sendStatus: "SENT" } });

  it("a claim that changed during the send does not stop the batch, and the sent reminder is audited and counted", async () => {
    const total = await eligible();
    const original = getEmailService().send.bind(getEmailService());
    let first = true;
    vi.spyOn(getEmailService(), "send").mockImplementation(async (message) => {
      if (first) {
        first = false;
        // Another actor changes this recipient's link while the reminder is in flight.
        await prisma.checkInRecipient.updateMany({ where: { campaignId, contactId: message.contactId! }, data: { tokenHash: "f".repeat(64) } });
      }
      return original(message);
    });

    // The changed recipient's emailed link is no longer theirs, so it is not counted.
    expect(await sendReminders(campaignId)).toBe(total - 1);
    const sentAudits = await prisma.auditEvent.findMany({ where: { campaignId, type: audit.AUDIT_EVENTS.REMINDER_SENT } });
    expect(sentAudits).toHaveLength(total);
    const changed = sentAudits.filter((a) => /claim changed/i.test(a.summary));
    expect(changed).toHaveLength(1);
    expect(JSON.parse(changed[0].detail!).claimChanged).toBe(true);
    // Left exactly as the other actor set it.
    expect(await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId, contactId: changed[0].contactId! } })).toMatchObject({ tokenHash: "f".repeat(64), reminderCount: 0 });
  });

  it("a recording failure on one reminder does not stop the others", async () => {
    const total = await eligible();
    const send = vi.spyOn(getEmailService(), "send");
    failFirstAudit(audit.AUDIT_EVENTS.REMINDER_SENT);

    expect(await sendReminders(campaignId)).toBe(total - 1);
    expect(send).toHaveBeenCalledTimes(total);
    expect(await prisma.checkInRecipient.count({ where: { campaignId, sendStatus: "REMINDER_PENDING" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { campaignId, type: audit.AUDIT_EVENTS.REMINDER_UNCERTAIN } })).toBe(1);
  });
});
