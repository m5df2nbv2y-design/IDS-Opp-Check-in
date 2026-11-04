import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { launchCampaign, sendReminders } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import type { EmailSendResult } from "@/server/integrations/email/types";
import { resetDatabase } from "./fixtures";

// Controlled provider outcome for sendReminders only; launch uses the real service.
let override: ((msg: { linkUrl?: string | null }) => Promise<EmailSendResult>) | null = null;
vi.mock("@/server/integrations/email", async (orig) => {
  const real = await orig<typeof import("@/server/integrations/email")>();
  return {
    ...real,
    getEmailService: () => {
      const svc = real.getEmailService();
      return override ? { info: svc.info, send: (m: never) => override!(m) } : svc;
    },
  };
});

async function campaignWithRecipient() {
  await refreshCatalogFromSalesforce("test");
  const opp = await prisma.opportunity.findFirstOrThrow({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null }, contact: { name: "Jane Doe" } },
  });
  const { campaignId } = await launchCampaign({ opportunityIds: [opp.id], name: "R", period: "T", actor: "test" });
  const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });
  override = async () => ({ id: "x", status: "SENT" });
  return { campaignId, recipient };
}

const audits = (campaignId: string, type: string) => prisma.auditEvent.findMany({ where: { campaignId, type } });

describe("reminder safety", () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    override = null;
    vi.restoreAllMocks();
  });

  it("a SENT reminder still increments reminderCount", async () => {
    const { campaignId, recipient } = await campaignWithRecipient();
    expect(await sendReminders(campaignId, "test")).toEqual({ sent: 1, failed: 0, skipped: 0 });
    const after = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(after.reminderCount).toBe(1);
    expect(after.tokenHash).not.toBe(recipient.tokenHash);
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_SENT)).toHaveLength(1);
  });

  it("a FAILED send restores the previous token and records REMINDER_FAILED", async () => {
    const { campaignId, recipient } = await campaignWithRecipient();
    override = async () => ({ id: "", status: "FAILED", error: "boom" });
    expect(await sendReminders(campaignId, "test")).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const after = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(after.tokenHash).toBe(recipient.tokenHash);
    expect(after.tokenHint).toBe(recipient.tokenHint);
    expect(after.expiresAt.getTime()).toBe(recipient.expiresAt.getTime());
    expect(after.reminderCount).toBe(0);
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_FAILED)).toHaveLength(1);
  });

  it("an unknown status does not restore the token and is recorded as failed", async () => {
    const { campaignId, recipient } = await campaignWithRecipient();
    override = async () => ({ id: "", status: "UNCERTAIN" }) as unknown as EmailSendResult;
    expect(await sendReminders(campaignId, "test")).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const after = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(after.tokenHash).not.toBe(recipient.tokenHash);
    expect(after.reminderCount).toBe(0);
    const [row] = await audits(campaignId, AUDIT_EVENTS.REMINDER_FAILED);
    expect(row.detail).toMatch(/unknown/i);
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_ATTEMPTED)).toHaveLength(1);
  });

  it("a recipient whose token changed since the batch began is skipped, not emailed", async () => {
    const { campaignId, recipient } = await campaignWithRecipient();
    const send = vi.fn(async () => ({ id: "x", status: "SENT" }) as EmailSendResult);
    override = send;
    const original = prisma.$transaction.bind(prisma) as (...a: unknown[]) => Promise<unknown>;
    let rivalRan = false;
    vi.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
      if (!rivalRan) {
        rivalRan = true;
        await prisma.checkInRecipient.update({ where: { id: recipient.id }, data: { tokenHash: "rival-token" } });
      }
      return original(...args);
    }) as unknown as typeof prisma.$transaction);
    expect(await sendReminders(campaignId, "test")).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(rivalRan).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_ATTEMPTED)).toHaveLength(0);
    expect((await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).tokenHash).toBe(
      "rival-token",
    );
  });

  it("an attempt row exists before the send and holds no raw token", async () => {
    const { campaignId } = await campaignWithRecipient();
    let attemptsAtSend = -1;
    let rawToken = "";
    override = async (msg) => {
      attemptsAtSend = (await audits(campaignId, AUDIT_EVENTS.REMINDER_ATTEMPTED)).length;
      rawToken = msg.linkUrl!.split("/checkin/")[1];
      return { id: "x", status: "SENT" };
    };
    await sendReminders(campaignId, "test");
    expect(attemptsAtSend).toBe(1);
    expect(rawToken.length).toBeGreaterThan(10);
    const all = JSON.stringify(await prisma.auditEvent.findMany({ where: { campaignId } }));
    expect(all).not.toContain(rawToken);
    expect(all).not.toContain("/checkin/");
  });

  it("a thrown send restores the token, records REMINDER_FAILED and the batch continues", async () => {
    await refreshCatalogFromSalesforce("test");
    const opps = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    });
    const two = [...new Map(opps.map((o) => [o.contactId, o])).values()].slice(0, 2);
    expect(two).toHaveLength(2);
    const { campaignId } = await launchCampaign({ opportunityIds: two.map((o) => o.id), name: "R", period: "T", actor: "test" });
    const before = await prisma.checkInRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    let calls = 0;
    override = async () => {
      calls += 1;
      if (calls === 1) throw new Error("live send refused");
      return { id: "x", status: "SENT" };
    };
    expect(await sendReminders(campaignId, "test")).toEqual({ sent: 1, failed: 1, skipped: 0 });
    const after = await prisma.checkInRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    expect(after.filter((r, i) => r.tokenHash === before[i].tokenHash)).toHaveLength(1);
    const [row] = await audits(campaignId, AUDIT_EVENTS.REMINDER_FAILED);
    expect(row.detail).toMatch(/send threw before an outcome was known/);
    expect(row.detail).toContain("live send refused");
  });
});
