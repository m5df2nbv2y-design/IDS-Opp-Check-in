import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SendingReceipt from "@/app/admin/campaigns/[id]/receipt/page";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { readReminderRecovery, recipientSendNote, sendReminders } from "@/server/services/campaign-service";
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

/** Fragments of the stored recovery JSON that must never reach the page. */
function recoveryFragments(sendError: string | null) {
  const recovery = readReminderRecovery(sendError)!;
  return [sendError!, recovery.attempt, recovery.previous.hash, recovery.previous.hint, recovery.previous.expiresAt, "&quot;version&quot;", "&quot;previous&quot;", "&quot;attempt&quot;"];
}

describe("sending receipt and reminder recovery metadata", () => {
  it("a definite rejection shows a readable restored-link message, never the raw recovery JSON", async () => {
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "rejected", status: "FAILED" });
    await sendReminders(campaignId);

    const row = await recipient();
    expect(row.sendStatus).toBe("SENT");
    expect(readReminderRecovery(row.sendError)).not.toBeNull(); // evidence stays in the database
    expect((await resolveCheckInToken(oldToken)).ok).toBe(true); // old link restored

    const html = await renderReceipt();
    expect(html).toContain("Reminder rejected; previous link restored.");
    for (const fragment of recoveryFragments(row.sendError)) expect(html).not.toContain(fragment);
  });

  it("an unresolved reminder shows the pending/unresolved message, never the raw recovery JSON", async () => {
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "unknown", status: "UNCERTAIN" });
    await sendReminders(campaignId);

    const row = await recipient();
    expect(row.sendStatus).toBe("REMINDER_UNCERTAIN");
    const html = await renderReceipt();
    expect(html).toContain("Reminder pending or unresolved");
    for (const fragment of recoveryFragments(row.sendError)) expect(html).not.toContain(fragment);
  });

  it("an ordinary invitation error is still shown as its own text", () => {
    expect(recipientSendNote({ sendStatus: "FAILED", sendError: "The provider rejected the send." })).toBe("The provider rejected the send.");
    expect(recipientSendNote({ sendStatus: "SENT", sendError: null })).toBeNull();
  });
});
