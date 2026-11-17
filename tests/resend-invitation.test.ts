import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resendInvitationAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { closeCampaignIfDone, getCampaignSummary, RESEND_INVITATION_MESSAGES, resendInvitation } from "@/server/services/campaign-service";
import { completeCheckIn, resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { RecipientTable } from "@/components/admin/recipient-table";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** A FAILED invitation's only way forward: an admin's audited, per-contact re-send with a fresh link. */

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
const call = resendInvitationAction as (...args: unknown[]) => Promise<void | { error: string }>;

/** A launched campaign whose invitation to one contact is FAILED (or `sendStatus`), with its raw launch token. */
async function aFailedInvitation(sendStatus = "FAILED") {
  const { campaignId, tokens } = await launchCampaignAndCollectTokens("Re-send");
  const target = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId }, orderBy: { id: "asc" }, include: { contact: true } });
  const recipient = await prisma.checkInRecipient.update({
    where: { id: target.id },
    data: { sendStatus, sentAt: sendStatus === "SENT" ? target.sentAt : null, sendError: sendStatus === "FAILED" ? "Provider rejected" : null },
  });
  return { campaignId, recipient, oldToken: tokens.get(target.contact.name)! };
}
type Failed = Awaited<ReturnType<typeof aFailedInvitation>>;

const resend = (ctx: Failed, hint = ctx.recipient.tokenHint) => call(ctx.campaignId, ctx.recipient.id, hint);
const row = (ctx: Failed) => prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.recipient.id } });
const invites = (ctx: Failed) => prisma.emailMessage.findMany({ where: { contactId: ctx.recipient.contactId, kind: "INVITE" }, orderBy: { createdAt: "asc" } });
const newToken = async (ctx: Failed) => (await invites(ctx)).at(-1)!.linkUrl!.split("/checkin/")[1];
const audits = (ctx: Failed) => prisma.auditEvent.findMany({ where: { contactId: ctx.recipient.contactId, actor: "josh@idsculpture.com" }, orderBy: { createdAt: "asc" } });

/** Make the next provider call return `result` (or throw). */
function provider(result: { status: "FAILED" | "UNCERTAIN"; error?: string } | "throw") {
  return vi.spyOn(getEmailService(), "send").mockImplementationOnce(async () => {
    if (result === "throw") throw new Error("socket hang up https://x/checkin/SECRETTOKEN");
    return { id: "", ...result };
  });
}

async function expectUntouched(ctx: Failed) {
  expect(await row(ctx)).toEqual(ctx.recipient);
  expect((await audits(ctx)).length).toBe(0);
  expect((await invites(ctx)).length).toBe(1);
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

describe("re-send accepted", () => {
  it("sends the campaign's copy with a fresh link, marks it SENT and audits it", async () => {
    const ctx = await aFailedInvitation();
    await prisma.campaign.update({ where: { id: ctx.campaignId }, data: { emailSubject: "Our own subject", emailBody: "Our own body" } });

    expect(await resend(ctx)).toBeUndefined();

    const after = await row(ctx);
    expect(after).toMatchObject({ sendStatus: "SENT", sendError: null });
    expect(after.sentAt).not.toBeNull();
    expect(after.tokenHint).not.toBe(ctx.recipient.tokenHint);
    expect(after.tokenHash).not.toBe(ctx.recipient.tokenHash);
    const sent = (await invites(ctx)).at(-1)!;
    expect(sent.subject).toBe("Our own subject");
    expect(sent.text).toContain("Our own body");
    expect((await audits(ctx)).map((e) => e.type)).toEqual([AUDIT_EVENTS.INVITE_RESEND_STARTED, AUDIT_EVENTS.INVITE_SENT]);
    expect(session.revalidated).toEqual([`/admin/campaigns/${ctx.campaignId}`, "/admin", "/admin/outbox"]);

    const summary = (await getCampaignSummary(ctx.campaignId))!;
    expect(summary.recipients.find((r) => r.recipientId === ctx.recipient.id)).toMatchObject({ status: "SENT", canResendInvitation: false });
  });

  it("the old link stops working and the new one opens the same items", async () => {
    const ctx = await aFailedInvitation();
    const before = await resolveCheckInToken(ctx.oldToken);
    expect(before.ok).toBe(true);

    await resend(ctx);

    expect(await resolveCheckInToken(ctx.oldToken)).toEqual({ ok: false, reason: "NOT_FOUND" });
    const fresh = await resolveCheckInToken(await newToken(ctx));
    expect(fresh.ok && fresh.session.items.map((i) => i.id)).toEqual(before.ok && before.session.items.map((i) => i.id));
  });

  it("once the re-sent recipient completes, the campaign can close", async () => {
    const ctx = await aFailedInvitation();
    // Everyone else has already finished.
    await prisma.checkInRecipient.updateMany({ where: { campaignId: ctx.campaignId, id: { not: ctx.recipient.id } }, data: { completedAt: new Date() } });
    await closeCampaignIfDone(ctx.campaignId);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: ctx.campaignId } })).status).toBe("IN_PROGRESS");

    await resend(ctx);
    const token = await newToken(ctx);
    const items = await prisma.checkInOpportunity.findMany({ where: { recipientId: ctx.recipient.id } });
    for (const item of items) await saveResponse({ token, itemId: item.id, stage: item.previousStatus, closeDate: "2027-12-31" });
    expect(await completeCheckIn(token)).toMatchObject({ ok: true });

    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: ctx.campaignId } })).status).toBe("COMPLETE");
  });

  it("is eligible for reminders afterwards", async () => {
    const ctx = await aFailedInvitation();
    const before = (await getCampaignSummary(ctx.campaignId))!.reminderEligibleCount;
    await resend(ctx);
    expect((await getCampaignSummary(ctx.campaignId))!.reminderEligibleCount).toBe(before + 1);
  });
});

describe("re-send not accepted", () => {
  it("a provider rejection leaves it FAILED with the new link and a sanitized error; it can be re-sent again", async () => {
    const ctx = await aFailedInvitation();
    provider({ status: "FAILED", error: "Rejected https://x/checkin/SECRETTOKEN" });

    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.FAILED });

    const after = await row(ctx);
    expect(after.sendStatus).toBe("FAILED");
    expect(after.tokenHint).not.toBe(ctx.recipient.tokenHint);
    expect(after.sendError).not.toContain("SECRETTOKEN");
    expect((await audits(ctx)).map((e) => e.type)).toEqual([AUDIT_EVENTS.INVITE_RESEND_STARTED, AUDIT_EVENTS.INVITE_FAILED]);
    expect(JSON.stringify(await audits(ctx))).not.toContain("SECRETTOKEN");
    const summary = (await getCampaignSummary(ctx.campaignId))!;
    expect(summary.recipients.find((r) => r.recipientId === ctx.recipient.id)!.canResendInvitation).toBe(true);

    expect(await call(ctx.campaignId, ctx.recipient.id, after.tokenHint)).toBeUndefined();
    expect((await row(ctx)).sendStatus).toBe("SENT");
  });

  it.each([
    ["UNCERTAIN", { status: "UNCERTAIN" as const }],
    ["a throw", "throw" as const],
  ])("%s from the provider records UNCERTAIN and offers reconcile, not re-send", async (_label, result) => {
    const ctx = await aFailedInvitation();
    provider(result);

    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.UNKNOWN });

    expect((await row(ctx)).sendStatus).toBe("UNCERTAIN");
    expect((await audits(ctx)).map((e) => e.type)).toEqual([AUDIT_EVENTS.INVITE_RESEND_STARTED, AUDIT_EVENTS.INVITE_UNCERTAIN]);
    expect(JSON.stringify(await audits(ctx))).not.toContain("SECRETTOKEN");
    const shown = (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.recipient.id)!;
    expect(shown).toMatchObject({ canResendInvitation: false, canReconcileInvitation: true });
  });

  it("a failure to record the outcome leaves the row PENDING, with a best-effort audit", async () => {
    const ctx = await aFailedInvitation();
    const original = prisma.$transaction.bind(prisma);
    let calls = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation(((...args: Parameters<typeof original>) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("database went away"));
      return original(...args);
    }) as typeof original);

    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.UNKNOWN });

    const after = await row(ctx);
    expect(after.sendStatus).toBe("PENDING");
    expect((await audits(ctx)).map((e) => e.type)).toEqual([AUDIT_EVENTS.INVITE_RESEND_STARTED, AUDIT_EVENTS.INVITE_UNCERTAIN]);
    // A re-send in flight is not immediately settleable: the attempt started now.
    const shown = (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.recipient.id)!;
    expect(shown).toMatchObject({ canResendInvitation: false, canReconcileInvitation: false });
  });
});

describe("a claim that changed during the send", () => {
  it("leaves the row as the other actor set it and audits the outcome as unrecorded", async () => {
    const ctx = await aFailedInvitation();
    const original = getEmailService().send.bind(getEmailService());
    vi.spyOn(getEmailService(), "send").mockImplementationOnce(async (message) => {
      // Another actor settles this recipient while the re-send is in flight.
      await prisma.checkInRecipient.update({ where: { id: ctx.recipient.id }, data: { sendStatus: "UNCERTAIN", sendError: "other actor" } });
      return original(message);
    });

    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.UNKNOWN });

    expect(await row(ctx)).toMatchObject({ sendStatus: "UNCERTAIN", sendError: "other actor", sentAt: null });
    const events = await audits(ctx);
    expect(events.map((e) => e.type)).toEqual([AUDIT_EVENTS.INVITE_RESEND_STARTED, AUDIT_EVENTS.INVITE_UNCERTAIN]);
    expect(JSON.parse(events[1].detail!)).toMatchObject({ outcome: "SENT", recorded: false });
  });
});

describe("refusals change nothing and send nothing", () => {
  it("a stale page (link changed since render)", async () => {
    const ctx = await aFailedInvitation();
    const send = vi.spyOn(getEmailService(), "send");
    expect(await resend(ctx, "zzzzzz")).toEqual({ error: "This invitation changed since the page was loaded. Reload and check again." });
    expect(send).not.toHaveBeenCalled();
    await expectUntouched(ctx);
  });

  it.each(["SENT", "PENDING", "UNCERTAIN", "REMINDER_PENDING", "REMINDER_UNCERTAIN"])("an invitation that is %s", async (status) => {
    const ctx = await aFailedInvitation(status);
    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.NOT_ELIGIBLE });
    await expectUntouched(ctx);
  });

  it.each([
    ["completed", { completedAt: new Date() }],
    ["revoked", { revokedAt: new Date() }],
  ])("a %s recipient", async (_label, data) => {
    const base = await aFailedInvitation();
    const ctx = { ...base, recipient: await prisma.checkInRecipient.update({ where: { id: base.recipient.id }, data }) };
    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.NOT_ELIGIBLE });
    await expectUntouched(ctx);
  });

  it("a recipient with no items", async () => {
    const ctx = await aFailedInvitation();
    await prisma.checkInOpportunity.deleteMany({ where: { recipientId: ctx.recipient.id } });
    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.NOT_ELIGIBLE });
    await expectUntouched(ctx);
  });

  it("a campaign that is not IN_PROGRESS", async () => {
    const ctx = await aFailedInvitation();
    await prisma.campaign.update({ where: { id: ctx.campaignId }, data: { status: "COMPLETE" } });
    expect(await resend(ctx)).toEqual({ error: RESEND_INVITATION_MESSAGES.NOT_ELIGIBLE });
    await expectUntouched(ctx);
  });

  it("a recipient outside the campaign", async () => {
    const ctx = await aFailedInvitation();
    expect(await call("another-campaign", ctx.recipient.id, ctx.recipient.tokenHint)).toEqual({ error: RESEND_INVITATION_MESSAGES.NOT_ELIGIBLE });
    await expectUntouched(ctx);
  });

  it.each([
    ["no session", null, UnauthorizedError],
    ["a non-admin", { user: { id: "u9", email: "reader@idsculpture.com", roles: ["Reader.Only"] } }, ForbiddenError],
  ])("throws for %s", async (_label, current, expected) => {
    const ctx = await aFailedInvitation();
    session.current = current;
    await expect(resend(ctx)).rejects.toThrow(expected);
    await expectUntouched(ctx);
    expect(session.revalidated).toEqual([]);
  });

  it("throws for bad input", async () => {
    const ctx = await aFailedInvitation();
    await expect(call(ctx.campaignId, ctx.recipient.id, 42)).rejects.toThrow("Invalid re-send input");
    await expectUntouched(ctx);
  });

  it("two concurrent clicks send exactly one email", async () => {
    const ctx = await aFailedInvitation();
    const input = { campaignId: ctx.campaignId, recipientId: ctx.recipient.id, shownTokenHint: ctx.recipient.tokenHint };
    const results = await Promise.all([resendInvitation({ ...input, actor: "a" }), resendInvitation({ ...input, actor: "b" })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await invites(ctx)).length).toBe(2);
  });
});

describe("the campaign page", () => {
  const render = async (campaignId: string) =>
    renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));
  const buttons = (html: string) => (html.match(/Re-send invitation/g) ?? []).length;

  it("shows the button for a FAILED invitation (desktop and mobile)", async () => {
    const ctx = await aFailedInvitation();
    expect(buttons(await render(ctx.campaignId))).toBe(2);
  });

  it.each(["SENT", "PENDING", "UNCERTAIN", "REMINDER_PENDING", "REMINDER_UNCERTAIN"])("shows no button for %s", async (status) => {
    const ctx = await aFailedInvitation(status);
    expect(buttons(await render(ctx.campaignId))).toBe(0);
  });

  it("the action the page binds re-sends the row it was rendered for", async () => {
    const ctx = await aFailedInvitation();
    const tree = await CampaignDetailPage({ params: Promise.resolve({ id: ctx.campaignId }) } as never);
    const find = (node: ReactNode): { recipients: { recipientId: string }[]; resendInvitation: (r: unknown) => () => Promise<unknown> } | null => {
      if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
      if (!isValidElement(node)) return null;
      const props = node.props as Record<string, unknown>;
      if (node.type === RecipientTable) return props as never;
      return find(props.children as ReactNode);
    };
    const table = find(tree)!;
    const shown = table.recipients.find((r) => r.recipientId === ctx.recipient.id)!;

    expect(await table.resendInvitation(shown)()).toBeUndefined();
    expect((await row(ctx)).sendStatus).toBe("SENT");
    expect(buttons(await render(ctx.campaignId))).toBe(0);
  });
});
