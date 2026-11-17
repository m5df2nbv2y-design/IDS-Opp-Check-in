import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SendingReceipt from "@/app/admin/campaigns/[id]/receipt/page";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { getCampaignSummary, readReminderRecovery, recipientSendNote, sendReminders } from "@/server/services/campaign-service";
import { resolveCheckInToken } from "@/server/services/response-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

let campaignId: string;
let recipientId: string;
let oldToken: string;

beforeEach(async () => {
  await resetDatabase();
  const launch = await launchCampaignAndCollectTokens();
  campaignId = launch.campaignId;
  oldToken = launch.tokens.get("Jane Doe")!;
  recipientId = (await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId, contact: { name: "Jane Doe" } } })).id;
  await prisma.checkInRecipient.updateMany({ where: { campaignId, id: { not: recipientId } }, data: { completedAt: new Date() } });
});
afterEach(() => vi.restoreAllMocks());

const renderReceipt = async () => renderToStaticMarkup(await SendingReceipt({ params: Promise.resolve({ id: campaignId }) } as never));
const recipient = () => prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipientId } });

/** Every stored recovery field name and value; React escapes quotes, so keys are checked in their escaped form. */
function recoveryFragments(sendError: string | null) {
  const recovery = readReminderRecovery(sendError)!;
  const keys = ["version", "kind", "attempt", "previous", "hash", "hint", "expiresAt", "outcome", "error"].map((key) => `&quot;${key}&quot;`);
  return [recovery.attempt, recovery.previous.hash, recovery.previous.hint, recovery.previous.expiresAt, ...keys];
}

describe("sending receipt and reminder recovery metadata", () => {
  it("a definite rejection shows a readable restored-link message, never the stored recovery JSON", async () => {
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "rejected", status: "FAILED", error: "Rejected at https://example.invalid/checkin/SECRETTOKEN123" });
    await sendReminders(campaignId);

    const row = await recipient();
    expect(row.sendStatus).toBe("SENT");
    expect(readReminderRecovery(row.sendError)).not.toBeNull(); // evidence stays in the database
    expect(row.sendError).toContain('"error"'); // the stored JSON also carries a sanitized provider error member
    expect((await resolveCheckInToken(oldToken)).ok).toBe(true); // old link restored

    const html = await renderReceipt();
    expect(html).toContain("Reminder rejected; previous link restored.");
    expect(html).not.toContain("SECRETTOKEN123");
    for (const fragment of recoveryFragments(row.sendError)) expect(html).not.toContain(fragment);
    expect((await getCampaignSummary(campaignId))?.recipients.find((r) => r.recipientId === recipientId)?.deliveryNote).toBe("Reminder rejected; previous link restored");
  });

  it.each(["returned UNCERTAIN", "thrown error"])("an unresolved reminder (%s) shows the pending/unresolved message, never the recovery JSON", async (kind) => {
    const send = vi.spyOn(getEmailService(), "send");
    if (kind === "thrown error") send.mockRejectedValue(new Error("secret provider body"));
    else send.mockResolvedValue({ id: "unknown", status: "UNCERTAIN" });
    await sendReminders(campaignId);

    const row = await recipient();
    expect(row.sendStatus).toBe("REMINDER_UNCERTAIN");
    const html = await renderReceipt();
    expect(html).toContain("Reminder pending or unresolved");
    expect(html).not.toContain("secret provider body");
    for (const fragment of recoveryFragments(row.sendError)) expect(html).not.toContain(fragment);
  });

  it("a pending reminder shows the pending/unresolved message while the send is in flight", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(getEmailService(), "send").mockImplementation(async () => { entered(); await gate; return { id: "accepted", status: "SENT" }; });
    const first = sendReminders(campaignId);
    await ready;
    try {
      const row = await recipient();
      expect(row.sendStatus).toBe("REMINDER_PENDING");
      const html = await renderReceipt();
      expect(html).toContain("Reminder pending or unresolved");
      for (const fragment of recoveryFragments(row.sendError)) expect(html).not.toContain(fragment);
    } finally {
      release();
      await first;
    }
  });

  it("recovery metadata is summarised, never printed or called 'restored' without a definite rejection", () => {
    const recognised = readReminderRecovery(
      JSON.stringify({ version: 1, kind: "REMINDER", attempt: "c3a2f5fd-4d9d-45fe-852d-5d301ad46146", previous: { hash: "a".repeat(64), hint: "abc123", expiresAt: "2026-12-19T23:54:39.895Z" } }),
    );
    expect(recognised).not.toBeNull();
    const withoutOutcome = JSON.stringify(recognised);
    const futureVersion = JSON.stringify({ version: 2, kind: "REMINDER", attempt: "x", previous: { hash: "not-hex" } });
    const rejected = JSON.stringify({ ...recognised, outcome: "FAILED" });

    expect(recipientSendNote({ sendStatus: "SENT", sendError: rejected })).toBe("Reminder rejected; previous link restored.");
    for (const sendError of [withoutOutcome, futureVersion]) {
      const note = recipientSendNote({ sendStatus: "SENT", sendError })!;
      expect(note).toContain("recovery evidence is on file");
      expect(note).not.toContain("restored");
      expect(note).not.toContain("{");
    }
  });

  it("an ordinary invitation error is still shown as its own text", () => {
    expect(recipientSendNote({ sendStatus: "FAILED", sendError: "The provider rejected the send." })).toBe("The provider rejected the send.");
    expect(recipientSendNote({ sendStatus: "SENT", sendError: null })).toBeNull();
  });
});
