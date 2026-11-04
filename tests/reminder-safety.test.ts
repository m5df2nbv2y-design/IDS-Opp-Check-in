import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { launchCampaign, resumeLaunch, sendReminders } from "@/server/services/campaign-service";
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

const LEAK = "bad https://example.invalid/checkin/SECRETTOKEN123 end " + "x".repeat(500);
const recipientOf = (campaignId: string) => prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });

describe("reminder safety", () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    override = null;
    vi.restoreAllMocks();
  });

  it("a SENT reminder rotates the link and increments reminderCount", async () => {
    const { campaignId, recipient } = await campaignWithRecipient();
    expect(await sendReminders(campaignId, "test")).toBe(1);
    const after = await recipientOf(campaignId);
    expect(after.reminderCount).toBe(1);
    expect(after.tokenHash).not.toBe(recipient.tokenHash);
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_SENT)).toHaveLength(1);
  });

  it("a returned reminder rejection restores the old link and persists no link text", async () => {
    const { campaignId, recipient } = await campaignWithRecipient();
    override = async () => ({ id: "", status: "FAILED", error: LEAK });
    expect(await sendReminders(campaignId, "test")).toBe(0);
    const after = await recipientOf(campaignId);
    expect(after.tokenHash).toBe(recipient.tokenHash);
    expect(after.reminderCount).toBe(0);
    const [row] = await audits(campaignId, AUDIT_EVENTS.REMINDER_FAILED);
    for (const text of [after.sendError!, row.detail!]) {
      expect(text).not.toContain("SECRETTOKEN123");
      expect(text).not.toContain("https://");
      expect(text).toContain("[link removed]");
    }
    expect(JSON.parse(row.detail!).error.length).toBeLessThanOrEqual(300);
  });

  it.each(["unknown", "throw"])("a %s reminder outcome is unknown, keeps the new link and blocks replay", async (kind) => {
    const { campaignId, recipient } = await campaignWithRecipient();
    override = async () => {
      if (kind === "throw") throw new Error(LEAK);
      return { id: "", status: "UNCERTAIN", error: LEAK };
    };
    expect(await sendReminders(campaignId, "test")).toBe(0);
    const after = await recipientOf(campaignId);
    expect(after.sendStatus).toBe("REMINDER_UNCERTAIN");
    expect(after.tokenHash).not.toBe(recipient.tokenHash);
    const [row] = await audits(campaignId, AUDIT_EVENTS.REMINDER_UNCERTAIN);
    expect(row.detail).not.toContain("SECRETTOKEN123");
    expect(row.detail).not.toContain("https://");
    const send = vi.fn(async () => ({ id: "x", status: "SENT" }) as EmailSendResult);
    override = send;
    expect(await sendReminders(campaignId, "test")).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("no raw token or link is stored in any audit row", async () => {
    const { campaignId } = await campaignWithRecipient();
    let rawToken = "";
    override = async (msg) => {
      rawToken = msg.linkUrl!.split("/checkin/")[1];
      return { id: "x", status: "SENT" };
    };
    await sendReminders(campaignId, "test");
    expect(rawToken.length).toBeGreaterThan(10);
    const all = JSON.stringify(await prisma.auditEvent.findMany({ where: { campaignId } }));
    expect(all).not.toContain(rawToken);
    expect(all).not.toContain("/checkin/");
  });

  it.each(["returned", "thrown"])("a %s invite failure is not retried and persists no link text", async (kind) => {
    await refreshCatalogFromSalesforce("test");
    const opps = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    });
    const two = [...new Map(opps.map((o) => [o.contactId, o])).values()].slice(0, 2);
    expect(two).toHaveLength(2);
    let calls = 0;
    override = async () => {
      calls += 1;
      if (calls === 1) {
        if (kind === "thrown") throw new Error(LEAK);
        return { id: "", status: "UNCERTAIN", error: LEAK };
      }
      return { id: "x", status: "SENT" };
    };
    const result = await launchCampaign({ opportunityIds: two.map((o) => o.id), name: "R", period: "T", actor: "test" });
    expect(result.emailsUncertain).toBe(1);
    expect(result.emailsSent).toBe(1);
    const rows = await prisma.checkInRecipient.findMany({ where: { campaignId: result.campaignId } });
    expect(rows.filter((r) => r.sendStatus === "UNCERTAIN")).toHaveLength(1);
    const [audit] = await audits(result.campaignId, AUDIT_EVENTS.INVITE_UNCERTAIN);
    for (const text of [audit.detail!, rows.find((r) => r.sendStatus === "UNCERTAIN")!.sendError!]) {
      expect(text).not.toContain("SECRETTOKEN123");
      expect(text).not.toContain("https://");
      expect(text.length).toBeLessThanOrEqual(300);
    }
    // Replay: resume must not re-send to the unknown recipient.
    const callsBefore = calls;
    await resumeLaunch(result.campaignId, "test");
    expect(calls).toBe(callsBefore);
  });
});
