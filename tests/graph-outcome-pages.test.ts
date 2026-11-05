import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import SendingReceipt from "@/app/admin/campaigns/[id]/receipt/page";
import { prisma } from "@/lib/db";
import { getCampaignSummary, launchCampaign, sendReminders } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";
import { ECHO, LEAKS, useGraphProvider } from "./graph-fixtures";

/**
 * What an administrator reads after a Graph invitation of unknown outcome.
 * The pages are rendered as DOM text against a real database, with the Graph
 * adapter's fetch stubbed — no live request.
 */

// The campaign page imports server actions, which import these.
vi.mock("@/server/auth/config", () => ({ auth: async () => null, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let graph: ReturnType<typeof useGraphProvider>;

beforeEach(async () => {
  await resetDatabase();
  await refreshCatalogFromSalesforce("test");
  graph = useGraphProvider();
});
afterEach(() => {
  graph.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const unknownWithEcho = () => new Response(ECHO, { status: 503 });

/** Launch to the first N distinct contacts; `outcomes[i]` is Graph's answer for contact i (202 when omitted). */
async function launchContacts(count: number, outcomes: (number | (() => Response))[] = []) {
  const all = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    include: { contact: true },
    orderBy: { externalId: "asc" },
  });
  const opportunities = [...new Map(all.map((opportunity) => [opportunity.contactId, opportunity])).values()].slice(0, count);
  const emails = opportunities.map((o) => o.contact!.email);
  graph.state.sendMail = (to) => outcomes[emails.indexOf(to)] ?? 202;
  const { campaignId } = await launchCampaign({ opportunityIds: opportunities.map((o) => o.id), name: "Graph", period: "T", actor: "test" });
  return campaignId;
}

const params = (campaignId: string) => ({ params: Promise.resolve({ id: campaignId }) }) as never;
const campaignPage = async (campaignId: string) => renderToStaticMarkup(await CampaignDetailPage(params(campaignId)));
const receiptPage = async (campaignId: string) => renderToStaticMarkup(await SendingReceipt(params(campaignId)));

/** The value and colour classes of one StatTile, read from the markup. */
function tile(html: string, label: string) {
  const match = html.match(new RegExp(`${label}</div><div class="([^"]*)">(\\d+)</div>`));
  expect(match, `tile "${label}"`).not.toBeNull();
  return { classes: match![1], value: Number(match![2]) };
}

describe("campaign page", () => {
  it("counts an unknown Graph invitation under 'Send outcome unknown' — warning tone, apart from failures and sent", async () => {
    const campaignId = await launchContacts(3, [202, 400, unknownWithEcho]);
    const html = await campaignPage(campaignId);

    const unknown = tile(html, "Send outcome unknown");
    expect(unknown.value).toBe(1);
    expect(unknown.classes).toContain("text-warning");
    expect(unknown.classes).not.toContain("text-danger");
    const failures = tile(html, "Send failures");
    expect(failures.value).toBe(1);
    expect(failures.classes).toContain("text-danger");
    expect(tile(html, "Emails sent").value).toBe(1);
    expect(html).toMatch(/sent mailbox/i);
    expect(html).toContain("Delivery unresolved"); // the recipient row keeps its existing status
    for (const leak of LEAKS) expect(html, leak).not.toContain(leak);
  });

  it("shows zero unknown and a quiet failures tile when every invitation was accepted", async () => {
    const campaignId = await launchContacts(1);
    const html = await campaignPage(campaignId);

    expect(tile(html, "Send outcome unknown")).toMatchObject({ value: 0 });
    expect(tile(html, "Send outcome unknown").classes).not.toContain("text-warning");
    expect(tile(html, "Send failures")).toMatchObject({ value: 0 });
  });
});

describe("sending receipt", () => {
  it("reports an unknown Graph send as unknown — not delivered, not failed — with a label naming the sent mailbox", async () => {
    const campaignId = await launchContacts(1, [unknownWithEcho]);

    const html = await receiptPage(campaignId);

    expect(html).toContain("1 recipient with an unknown send outcome");
    expect(html).toContain("not delivered and not failed");
    expect(html).toMatch(/before resending/i);
    expect(html).toContain("Acceptance unconfirmed — check the sent mailbox");
    // Failed is not claimed, delivered is not claimed, and the chip is a warning.
    expect(html).not.toContain("could not be sent");
    expect(html).not.toContain("bg-danger-soft");
    expect(html).not.toContain("text-danger");
    expect(html).not.toMatch(/Delivered|View sent email/);
    expect(html).toContain("bg-warning-soft text-warning");
    expect(html).toContain("Microsoft returned HTTP 503");
    for (const leak of LEAKS) expect(html, leak).not.toContain(leak);
  });

  it("keeps failed and unknown apart in the header", async () => {
    const campaignId = await launchContacts(2, [400, unknownWithEcho]);
    const html = await receiptPage(campaignId);

    expect(html).toContain("1 recipient could not be sent");
    expect(html).toContain("1 recipient with an unknown send outcome");
    expect(html).toContain("bg-danger-soft text-danger");
    expect(html).toContain("bg-warning-soft text-warning");
  });

  it("says nothing about unknown sends when there are none", async () => {
    const campaignId = await launchContacts(1);
    const html = await receiptPage(campaignId);
    expect(html).not.toContain("unknown send outcome");
  });
});

describe("the campaign tile and the sending results use one rule for 'unknown'", () => {
  /** The number in the receipt header's unknown-send sentence, or 0 when the sentence is absent. */
  const receiptUnknown = (html: string) => Number(html.match(/(\d+) recipients? with an unknown send outcome/)?.[1] ?? 0);

  it("an interrupted send (ledger PENDING, recipient PENDING) shows a warning chip but is not an unknown invitation", async () => {
    const campaignId = await launchContacts(1);
    await prisma.emailMessage.updateMany({ where: { campaignId }, data: { status: "PENDING", error: null } });
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { sendStatus: "PENDING", sentAt: null } });

    const html = await receiptPage(campaignId);

    expect(receiptUnknown(html)).toBe(0);
    expect(html).toMatch(/bg-warning-soft text-warning">Acceptance unconfirmed — check the sent mailbox</);
    expect(html).not.toContain("bg-danger-soft");
    expect(tile(await campaignPage(campaignId), "Send outcome unknown").value).toBe(0);
  });

  it("a recipient UNCERTAIN with no email row is counted, with the warning tone", async () => {
    const campaignId = await launchContacts(1);
    await prisma.emailMessage.deleteMany({ where: { campaignId } });
    await prisma.checkInRecipient.updateMany({
      where: { campaignId },
      data: { sendStatus: "UNCERTAIN", sentAt: null, sendError: "Microsoft returned HTTP 503 and the outcome is unknown." },
    });

    const html = await receiptPage(campaignId);

    expect(receiptUnknown(html)).toBe(1);
    expect(html).toMatch(/bg-warning-soft text-warning">No email record</);
    expect(html).toMatch(/text-sm text-warning">Microsoft returned HTTP 503/);
    expect(html).not.toContain("text-danger");
    expect(tile(await campaignPage(campaignId), "Send outcome unknown").value).toBe(1);
  });

  it("a reminder-unknown recipient is not in the header count, and its note is a warning", async () => {
    const campaignId = await launchContacts(1);
    graph.state.sendMail = () => 503;
    expect(await sendReminders(campaignId, "test")).toBe(0);

    const html = await receiptPage(campaignId);

    expect(receiptUnknown(html)).toBe(0);
    expect(html).toMatch(/class="break-words text-sm text-warning">Reminder pending or unresolved/);
    expect(html).not.toContain("text-danger");
    expect(tile(await campaignPage(campaignId), "Send outcome unknown").value).toBe(0);
  });

  it("a definite failure is never shown in the warning tone", async () => {
    const campaignId = await launchContacts(1, [400]);
    // Even with a stale unconfirmed ledger row beside it, a recorded failure stays a failure.
    await prisma.emailMessage.updateMany({ where: { campaignId }, data: { status: "UNCERTAIN" } });

    const html = await receiptPage(campaignId);

    expect(html).toContain("bg-danger-soft text-danger");
    expect(html).not.toContain("bg-warning-soft");
  });

  it("agree on the same seeded campaign: sent, failed, unknown and an interrupted send", async () => {
    const campaignId = await launchContacts(4, [202, 400, unknownWithEcho, 202]);
    const interrupted = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId, sendStatus: "SENT" } });
    await prisma.checkInRecipient.update({ where: { id: interrupted.id }, data: { sendStatus: "PENDING", sentAt: null } });
    await prisma.emailMessage.updateMany({ where: { campaignId, contactId: interrupted.contactId }, data: { status: "PENDING" } });

    const summary = (await getCampaignSummary(campaignId))!;
    const tileHtml = await campaignPage(campaignId);
    const receiptHtml = await receiptPage(campaignId);

    expect(summary).toMatchObject({ emailsSent: 1, emailsFailed: 1, emailsUncertain: 1, unresolvedDeliveryCount: 2 });
    expect(tile(tileHtml, "Send outcome unknown").value).toBe(summary.emailsUncertain);
    expect(receiptUnknown(receiptHtml)).toBe(summary.emailsUncertain);
    expect(receiptHtml).toContain("1 recipient could not be sent");
  });
});
