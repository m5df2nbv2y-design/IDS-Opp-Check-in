import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { getCampaignSummary, readReminderRecovery, sendReminders } from "@/server/services/campaign-service";
import { resolveCheckInToken } from "@/server/services/response-service";
import * as audit from "@/server/services/audit-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

let campaignId: string;
let recipientId: string;
let oldToken: string;
beforeEach(async () => {
  await resetDatabase();
  const launch = await launchCampaignAndCollectTokens();
  campaignId = launch.campaignId;
  oldToken = launch.tokens.get("Jane Doe")!;
  const target = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId, contact: { name: "Jane Doe" } } });
  recipientId = target.id;
  await prisma.checkInRecipient.updateMany({ where: { campaignId, id: { not: recipientId } }, data: { completedAt: new Date() } });
});
afterEach(() => vi.restoreAllMocks());
const recipient = () => prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipientId } });

describe("durable reminder recovery", () => {
  it("a definitive rejection restores the old token and commits its audit", async () => {
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "rejected", status: "FAILED" });
    expect(await sendReminders(campaignId)).toBe(0);
    expect((await resolveCheckInToken(oldToken)).ok).toBe(true);
    expect(await recipient()).toMatchObject({ sendStatus: "SENT", reminderCount: 0 });
    expect((await getCampaignSummary(campaignId))?.recipients.find(r => r.recipientId === recipientId)?.deliveryNote).toContain("previous link restored");
    expect(await prisma.auditEvent.count({ where: { campaignId, type: audit.AUDIT_EVENTS.REMINDER_FAILED } })).toBe(1);
  });

  it.each(["unknown", "throw"])("%s outcomes retain the new token and block replay", async outcome => {
    const send = vi.spyOn(getEmailService(), "send");
    if (outcome === "throw") send.mockRejectedValue(new Error("secret provider body"));
    else send.mockResolvedValue({ id: "unknown", status: "UNCERTAIN" });
    expect(await sendReminders(campaignId)).toBe(0);
    const row = await recipient();
    expect(row.sendStatus).toBe("REMINDER_UNCERTAIN");
    expect(readReminderRecovery(row.sendError)?.previous.hash).toHaveLength(64);
    expect(row.sendError).not.toContain(oldToken);
    expect((await resolveCheckInToken(oldToken)).ok).toBe(false);
    await sendReminders(campaignId);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await getCampaignSummary(campaignId))?.unresolvedDeliveryCount).toBe(1);
  });

  it("a pending attempt blocks overlapping batches without an age takeover", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const send = vi.spyOn(getEmailService(), "send").mockImplementation(async () => { entered(); await gate; return { id: "accepted", status: "SENT" }; });
    const first = sendReminders(campaignId);
    await ready;
    try {
      expect((await recipient()).sendStatus).toBe("REMINDER_PENDING");
      expect(await sendReminders(campaignId)).toBe(0);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { release(); }
    expect(await first).toBe(1);
    expect(await recipient()).toMatchObject({ sendStatus: "SENT", reminderCount: 1, sendError: null });
  });

  it.each(["SENT", "FAILED"] as const)("%s finalization rolls back when audit fails, retaining recovery evidence", async status => {
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "result", status });
    const original = audit.recordAudit;
    vi.spyOn(audit, "recordAudit").mockImplementation(async (input, db) => {
      if (input.type === audit.AUDIT_EVENTS.REMINDER_SENT || input.type === audit.AUDIT_EVENTS.REMINDER_FAILED) throw new Error("audit unavailable");
      return original(input, db);
    });
    await expect(sendReminders(campaignId)).rejects.toThrow("audit unavailable");
    const row = await recipient();
    expect(row).toMatchObject({ sendStatus: "REMINDER_PENDING", reminderCount: 0 });
    expect(readReminderRecovery(row.sendError)).not.toBeNull();
    expect((await resolveCheckInToken(oldToken)).ok).toBe(false);
    expect(await sendReminders(campaignId)).toBe(0);
  });

  it("never turns a provisioned but unsent invitation into a reminder", async () => {
    await prisma.checkInRecipient.update({ where: { id: recipientId }, data: { sentAt: null, sendStatus: "PENDING" } });
    const send = vi.spyOn(getEmailService(), "send");
    expect(await sendReminders(campaignId)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["REMINDER_PENDING", "REMINDER_UNCERTAIN"])("%s preserves completed progress and its separate unresolved warning", async sendStatus => {
    const before = await getCampaignSummary(campaignId);
    await prisma.checkInRecipient.update({ where: { id: recipientId }, data: { sendStatus, completedAt: new Date() } });
    const summary = await getCampaignSummary(campaignId);
    expect(summary?.recipients.find(r => r.recipientId === recipientId)?.status).toBe("COMPLETE");
    expect(summary?.completedCount).toBe(before!.completedCount + 1);
    expect(summary?.unresolvedDeliveryCount).toBe(1);
  });

  it.each(["REMINDER_PENDING", "REMINDER_UNCERTAIN"])("%s preserves sync errors and its separate unresolved warning", async sendStatus => {
    await prisma.checkInRecipient.update({ where: { id: recipientId }, data: { sendStatus } });
    await prisma.checkInOpportunity.updateMany({ where: { recipientId }, data: { syncStatus: "FAILED" } });
    const summary = await getCampaignSummary(campaignId);
    expect(summary?.recipients.find(r => r.recipientId === recipientId)?.status).toBe("SYNC_ERROR");
    expect(summary?.syncErrorCount).toBe(1);
    expect(summary?.unresolvedDeliveryCount).toBe(1);
  });

  it("rejects malformed recovery data", () => {
    for (const value of [null, "{}", "not json", JSON.stringify({ version: 1, kind: "REMINDER", attempt: "x", previous: { hash: oldToken } })]) expect(readReminderRecovery(value)).toBeNull();
  });
});
