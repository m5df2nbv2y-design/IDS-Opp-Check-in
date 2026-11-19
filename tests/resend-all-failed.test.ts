import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resendFailedAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { ActionButton } from "@/components/admin/action-button";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { ForbiddenError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { getCampaignSummary, resendBatchMessage } from "@/server/services/campaign-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** A campaign-level re-send of every FAILED invitation the page showed, one contact at a time. */

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
const call = resendFailedAction as (...args: unknown[]) => Promise<void | { error: string }>;

/** A launched campaign with its first `n` invitations FAILED; returns them as the page shows them. */
async function failedInvitations(n = 3) {
  const { campaignId } = await launchCampaignAndCollectTokens("Re-send all");
  const targets = await prisma.checkInRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" }, take: n });
  expect(targets).toHaveLength(n);
  await prisma.checkInRecipient.updateMany({ where: { id: { in: targets.map((t) => t.id) } }, data: { sendStatus: "FAILED", sentAt: null, sendError: "Provider rejected" } });
  const shown = (await getCampaignSummary(campaignId))!.recipients
    .filter((r) => r.canResendInvitation)
    .map((r) => ({ recipientId: r.recipientId, tokenHint: r.tokenHint }));
  return { campaignId, shown };
}

const statuses = async (ids: string[]) =>
  Promise.all(ids.map(async (id) => (await prisma.checkInRecipient.findUniqueOrThrow({ where: { id } })).sendStatus));
const batchAudits = (campaignId: string) => prisma.auditEvent.findMany({ where: { campaignId, type: AUDIT_EVENTS.INVITE_RESEND_BATCH } });
const perRowAudits = (campaignId: string) =>
  prisma.auditEvent.findMany({ where: { campaignId, actor: "josh@idsculpture.com", type: { not: AUDIT_EVENTS.INVITE_RESEND_BATCH } }, orderBy: { createdAt: "asc" } });

/** Make the nth (1-based) provider call return `status`; every other call goes through. */
function providerOn(nth: number, status: "FAILED" | "UNCERTAIN") {
  const service = getEmailService();
  const original = service.send.bind(service);
  let calls = 0;
  return vi.spyOn(service, "send").mockImplementation(async (message) => {
    calls += 1;
    return calls === nth ? { id: "", status, error: "Provider said no" } : original(message);
  });
}

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
  session.current = ADMIN;
  session.revalidated.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("re-send all failed", () => {
  it("all succeed: each contact is claimed, sent and audited on its own; one batch audit", async () => {
    const { campaignId, shown } = await failedInvitations(3);

    expect(await call(campaignId, shown)).toBeUndefined();

    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["SENT", "SENT", "SENT"]);
    const events = await perRowAudits(campaignId);
    for (const { recipientId } of shown) {
      const mine = events.filter((e) => JSON.parse(e.detail!).recipientId === recipientId).map((e) => e.type);
      expect(mine).toEqual([AUDIT_EVENTS.INVITE_RESEND_STARTED, AUDIT_EVENTS.INVITE_SENT]);
    }
    const batch = await batchAudits(campaignId);
    expect(batch).toHaveLength(1);
    expect(JSON.parse(batch[0].detail!)).toEqual({ version: 1, shown: 3, sent: 3, failed: 0, unknown: 0, skipped: 0, notTried: 0 });
    expect(batch[0]).toMatchObject({ actor: "josh@idsculpture.com", actorKind: "ADMIN" });
    expect(session.revalidated).toEqual([`/admin/campaigns/${campaignId}`, "/admin", "/admin/outbox"]);
  });

  it("some fail again: they stay FAILED and are not retried", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    const send = providerOn(2, "FAILED");

    expect(await call(campaignId, shown)).toEqual({ error: "2 of 3 re-sent; 1 failed again." });

    expect(send).toHaveBeenCalledTimes(3);
    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["SENT", "FAILED", "SENT"]);
    expect(JSON.parse((await batchAudits(campaignId))[0].detail!)).toMatchObject({ sent: 2, failed: 1, unknown: 0, skipped: 0, notTried: 0 });
  });

  it("a row re-sent by hand since the page loaded is skipped; the others go out", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    await prisma.checkInRecipient.update({ where: { id: shown[1].recipientId }, data: { tokenHint: "zzzzzz" } });

    expect(await call(campaignId, shown)).toEqual({ error: "2 of 3 re-sent; 1 changed since the page was loaded and was skipped." });

    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["SENT", "FAILED", "SENT"]);
    expect(JSON.parse((await batchAudits(campaignId))[0].detail!)).toMatchObject({ sent: 2, skipped: 1 });
  });

  it("a row held back since the page loaded is refused and counted as skipped", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    const item = await prisma.checkInOpportunity.findFirstOrThrow({ where: { recipientId: shown[0].recipientId } });
    await prisma.opportunity.update({ where: { id: item.opportunityId }, data: { isOpen: false } });

    expect(await call(campaignId, shown)).toEqual({ error: "2 of 3 re-sent; 1 changed since the page was loaded and was skipped." });

    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["FAILED", "SENT", "SENT"]);
  });

  it("nothing eligible: nothing is sent", async () => {
    const { campaignId, shown } = await failedInvitations(2);
    await prisma.checkInRecipient.updateMany({ where: { id: { in: shown.map((s) => s.recipientId) } }, data: { sendStatus: "SENT" } });
    const send = vi.spyOn(getEmailService(), "send");

    expect(await call(campaignId, shown)).toEqual({ error: "Nothing to re-send. Reload the page." });
    expect(await call(campaignId, [])).toEqual({ error: "Nothing to re-send. Reload the page." });

    expect(send).not.toHaveBeenCalled();
  });

  it.each([["UNCERTAIN"], ["an unrecorded outcome"]])("stops at the first unknown outcome (%s); the rest stay FAILED and untouched", async (label) => {
    const { campaignId, shown } = await failedInvitations(3);
    const third = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: shown[2].recipientId } });
    if (label === "UNCERTAIN") providerOn(2, "UNCERTAIN");
    else {
      // The 2nd send's outcome transaction fails (transactions: claim1, record1, claim2, record2).
      const original = prisma.$transaction.bind(prisma);
      let calls = 0;
      vi.spyOn(prisma, "$transaction").mockImplementation(((...args: Parameters<typeof original>) => {
        calls += 1;
        return calls === 4 ? Promise.reject(new Error("database went away")) : original(...args);
      }) as typeof original);
    }

    expect(await call(campaignId, shown)).toEqual({
      error: "Stopped after an unknown result: 1 of 3 re-sent; 1 not tried. Check the sending mailbox's Sent Items and reconcile that contact before re-sending the rest.",
    });

    const [first, second] = await statuses(shown.slice(0, 2).map((s) => s.recipientId));
    expect(first).toBe("SENT");
    expect(second).toBe(label === "UNCERTAIN" ? "UNCERTAIN" : "PENDING");
    expect(await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: third.id } })).toEqual(third);
    expect(JSON.parse((await batchAudits(campaignId))[0].detail!)).toMatchObject({ sent: 1, unknown: 1, notTried: 1 });
  });

  it("a throw on the 2nd row counts as unknown and stops the batch with a summary", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    const third = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: shown[2].recipientId } });
    // Transactions: claim1, record1, claim2 (rejects).
    const original = prisma.$transaction.bind(prisma);
    let calls = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation(((...args: Parameters<typeof original>) => {
      calls += 1;
      return calls === 3 ? Promise.reject(new Error("database went away")) : original(...args);
    }) as typeof original);

    expect(await call(campaignId, shown)).toEqual({
      error: "Stopped after an unknown result: 1 of 3 re-sent; 1 not tried. Check the sending mailbox's Sent Items and reconcile that contact before re-sending the rest.",
    });

    expect(await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: third.id } })).toEqual(third);
    const batch = await batchAudits(campaignId);
    expect(batch).toHaveLength(1);
    expect(JSON.parse(batch[0].detail!)).toEqual({ version: 1, shown: 3, sent: 1, failed: 0, unknown: 1, skipped: 0, notTried: 1 });
    expect(session.revalidated).toEqual([`/admin/campaigns/${campaignId}`, "/admin", "/admin/outbox"]);
  });

  it("names failed-again and not-tried rows when it stops after a failure", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    const service = getEmailService();
    vi.spyOn(service, "send")
      .mockImplementationOnce(async () => ({ id: "", status: "FAILED", error: "no" }))
      .mockImplementationOnce(async () => ({ id: "", status: "UNCERTAIN" }));

    expect(await call(campaignId, shown)).toEqual({
      error: "Stopped after an unknown result: 0 of 3 re-sent; 1 failed again; 1 not tried. Check the sending mailbox's Sent Items and reconcile that contact before re-sending the rest.",
    });
    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["FAILED", "UNCERTAIN", "FAILED"]);
  });

  it("sends one after another, never in parallel", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    const service = getEmailService();
    const original = service.send.bind(service);
    let inFlight = 0;
    let most = 0;
    vi.spyOn(service, "send").mockImplementation(async (message) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      try { return await original(message); } finally { inFlight -= 1; }
    });

    await call(campaignId, shown);

    expect(most).toBe(1);
  });

  it("stops starting new sends after 180 s; the rest are not tried and the admin is told to run it again", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const service = getEmailService();
    const original = service.send.bind(service);
    // Each send takes 100 s: the 2nd starts at 100 s (under budget), the 3rd would start at 200 s.
    const send = vi.spyOn(service, "send").mockImplementation(async (message) => { now += 100_000; return original(message); });

    expect(await call(campaignId, shown)).toEqual({ error: "2 of 3 re-sent; 1 not tried yet. Press Re-send all failed again to send the rest." });

    expect(send).toHaveBeenCalledTimes(2);
    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["SENT", "SENT", "FAILED"]);
    const [batch] = await batchAudits(campaignId);
    expect(batch.summary).toBe("Re-sent 2 of 3 failed invitations; stopped at the time limit");
    expect(JSON.parse(batch.detail!)).toMatchObject({ sent: 2, unknown: 0, notTried: 1 });
  });

  it("a send that finishes past the budget still counts; nothing after it starts", async () => {
    const { campaignId, shown } = await failedInvitations(3);
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const service = getEmailService();
    const original = service.send.bind(service);
    const send = vi.spyOn(service, "send").mockImplementation(async (message) => { now += 179_999; return original(message); });

    // The 2nd starts at 179.999 s, just inside the budget, and finishes; the 3rd would start at 359.998 s.
    expect(await call(campaignId, shown)).toEqual({ error: "2 of 3 re-sent; 1 not tried yet. Press Re-send all failed again to send the rest." });
    expect(send).toHaveBeenCalledTimes(2);
    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["SENT", "SENT", "FAILED"]);
  });

  it("the time-limit message keeps the failed-again and skipped counts", () => {
    expect(resendBatchMessage({ sent: 1, failed: 1, unknown: 0, skipped: 1, notTried: 2 })).toBe(
      "1 of 5 re-sent; 1 failed again; 1 changed since the page was loaded and was skipped; 2 not tried yet. Press Re-send all failed again to send the rest.",
    );
  });

  it("refuses a non-admin and sends nothing", async () => {
    const { campaignId, shown } = await failedInvitations(2);
    session.current = { user: { id: "u9", email: "reader@idsculpture.com", roles: ["Reader.Only"] } };
    const send = vi.spyOn(getEmailService(), "send");

    await expect(call(campaignId, shown)).rejects.toThrow(ForbiddenError);

    expect(send).not.toHaveBeenCalled();
    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["FAILED", "FAILED"]);
    expect(await batchAudits(campaignId)).toHaveLength(0);
  });

  it("throws for bad input before sending anything", async () => {
    const { campaignId, shown } = await failedInvitations(2);
    await expect(call(campaignId, [shown[0], { recipientId: shown[1].recipientId, tokenHint: 42 }])).rejects.toThrow("Invalid re-send input");
    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["FAILED", "FAILED"]);
  });
});

describe("the campaign page", () => {
  const render = async (campaignId: string) =>
    renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));

  /** The batch button the page renders, if any. */
  async function batchButton(campaignId: string) {
    const tree = await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never);
    const find = (node: ReactNode): Record<string, unknown> | null => {
      if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
      if (!isValidElement(node)) return null;
      const props = node.props as Record<string, unknown>;
      if (node.type === ActionButton && String(props.confirm ?? "").includes("failed invitation")) return props;
      return find(props.children as ReactNode);
    };
    return find(tree) as { action: () => Promise<unknown>; confirm: string } | null;
  }

  it("shows the count and a confirm that states the count and the fresh link", async () => {
    const { campaignId } = await failedInvitations(3);
    expect(await render(campaignId)).toContain("Re-send 3 failed invitations");
    const button = (await batchButton(campaignId))!;
    expect(button.confirm).toContain("3 failed invitations");
    expect(button.confirm).toContain("fresh link");
    expect(button.confirm).toContain("old link stops working");
  });

  it("shows no button without re-sendable rows", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Nothing failed");
    expect(await render(campaignId)).not.toContain("failed invitation");
    expect(await batchButton(campaignId)).toBeNull();
  });

  it("the bound action re-sends exactly the rows shown, then the button goes", async () => {
    const { campaignId, shown } = await failedInvitations(2);
    const button = (await batchButton(campaignId))!;

    expect(await button.action()).toBeUndefined();

    expect(await statuses(shown.map((s) => s.recipientId))).toEqual(["SENT", "SENT"]);
    expect(await batchButton(campaignId)).toBeNull();
  });
});
