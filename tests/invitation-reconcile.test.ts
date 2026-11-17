import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileInvitationAction, type ReconcileActionResult } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { getCampaignSummary, sendReminders } from "@/server/services/campaign-service";
import { INVITATION_NOT_SENT_NOTE, reconcileUnknownInvitation } from "@/server/services/reconcile-service";
import { RecipientTable } from "@/components/admin/recipient-table";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/**
 * The only exit for an invitation whose send outcome was never learned:
 * an admin's per-recipient, audited attestation of what the sending mailbox shows.
 */

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
const call = reconcileInvitationAction as (...args: unknown[]) => Promise<ReconcileActionResult>;
const MINUTE = 60 * 1000;

const REFUSALS = {
  STALE: "This invitation changed since the page was loaded. Reload and check again.",
  STILL_SENDING: "This invitation may still be sending. Wait a few minutes and reload.",
  NOT_UNRESOLVED: "This invitation is no longer unresolved — someone may have recorded its outcome already.",
  NOT_FOUND: "This invitation is no longer part of the campaign.",
  OPENED: "The recipient has opened this invitation, so it was delivered. Record it as sent.",
};

const reconcileAudits = () =>
  prisma.auditEvent.findMany({
    where: { type: { in: [AUDIT_EVENTS.INVITE_RECONCILED_SENT, AUDIT_EVENTS.INVITE_RECONCILED_NOT_SENT] } },
  });

/** A launched campaign whose invitation to one contact is left in `sendStatus`, its row `ageMs` old. */
async function anUnknownInvitation(sendStatus = "UNCERTAIN", ageMs = 60 * MINUTE) {
  const { campaignId } = await launchCampaignAndCollectTokens("Invitation Reconcile");
  const target = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId }, orderBy: { id: "asc" } });
  const recipient = await prisma.checkInRecipient.update({
    where: { id: target.id },
    data: { sendStatus, sentAt: null, sendError: "Invitation acceptance is unresolved.", createdAt: new Date(Date.now() - ageMs) },
  });
  return { campaignId, recipient };
}
type Unknown = Awaited<ReturnType<typeof anUnknownInvitation>>;

const attest = ({ campaignId, recipient }: Unknown, observed: string, overrides: Partial<{ status: string; hint: string; campaignId: string }> = {}) =>
  call(overrides.campaignId ?? campaignId, recipient.id, overrides.status ?? recipient.sendStatus, overrides.hint ?? recipient.tokenHint, observed);

async function expectUntouched({ recipient }: Unknown) {
  expect(await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).toEqual(recipient);
  expect(await reconcileAudits()).toHaveLength(0);
  expect(session.revalidated).toEqual([]);
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

describe.each([
  ["UNCERTAIN", "UNCERTAIN", 60 * MINUTE],
  ["an interrupted PENDING", "PENDING", 16 * MINUTE],
])("settling %s", (_label, status, age) => {
  it("'It was sent' marks it SENT at the row's creation time, audited as a human assertion", async () => {
    const ctx = await anUnknownInvitation(status, age);
    const before = await getCampaignSummary(ctx.campaignId);

    expect(await attest(ctx, "SENT")).toEqual({ ok: true });

    const row = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.recipient.id } });
    expect(row).toMatchObject({ sendStatus: "SENT", sendError: null, sentAt: ctx.recipient.createdAt });
    const [event] = await reconcileAudits();
    expect(event).toMatchObject({
      type: AUDIT_EVENTS.INVITE_RECONCILED_SENT,
      actor: "josh@idsculpture.com",
      actorKind: "ADMIN",
      campaignId: ctx.campaignId,
      contactId: ctx.recipient.contactId,
      fromStatus: status,
      toStatus: "SENT",
    });
    expect(JSON.parse(event.detail!)).toEqual({
      recipientId: ctx.recipient.id,
      tokenHint: ctx.recipient.tokenHint,
      previousSendError: ctx.recipient.sendError,
      sentAtInferredFrom: "recipient.createdAt",
    });
    expect(session.revalidated).toEqual([`/admin/campaigns/${ctx.campaignId}`, "/admin"]);

    const after = (await getCampaignSummary(ctx.campaignId))!;
    expect(after.unresolvedDeliveryCount).toBe(before!.unresolvedDeliveryCount - 1);
    if (status === "UNCERTAIN") expect(after.emailsUncertain).toBe(before!.emailsUncertain - 1);
    expect(after.reminderEligibleCount).toBe(before!.reminderEligibleCount + 1);
  });

  it("'It was not sent' marks it FAILED with the fixed note, and revokes nothing", async () => {
    const ctx = await anUnknownInvitation(status, age);

    expect(await attest(ctx, "NOT_SENT")).toEqual({ ok: true });

    const row = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.recipient.id } });
    expect(row).toMatchObject({ sendStatus: "FAILED", sendError: INVITATION_NOT_SENT_NOTE, sentAt: null, revokedAt: null, tokenHash: ctx.recipient.tokenHash });
    const events = await reconcileAudits();
    expect(events.map((e) => e.type)).toEqual([AUDIT_EVENTS.INVITE_RECONCILED_NOT_SENT]);
  });
});

describe("refusals write nothing", () => {
  it("a PENDING row 15 minutes old or younger may still be sending", async () => {
    const ctx = await anUnknownInvitation("PENDING", 15 * MINUTE - 5000);
    expect(await attest(ctx, "SENT")).toMatchObject({ ok: false, reason: "STILL_SENDING", message: REFUSALS.STILL_SENDING });
    await expectUntouched(ctx);
  });

  it("a PENDING row exactly 15 minutes old may still be sending", async () => {
    const ctx = await anUnknownInvitation("PENDING");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(ctx.recipient.createdAt.getTime() + 15 * MINUTE);
      expect(await attest(ctx, "SENT")).toMatchObject({ ok: false, reason: "STILL_SENDING", message: REFUSALS.STILL_SENDING });
    } finally {
      vi.useRealTimers();
    }
    await expectUntouched(ctx);
  });

  it.each(["openedAt", "completedAt"])("'It was not sent' once %s is set: opening proves delivery", async (field) => {
    const base = await anUnknownInvitation();
    const recipient = await prisma.checkInRecipient.update({ where: { id: base.recipient.id }, data: { [field]: new Date() } });
    const ctx = { ...base, recipient };
    expect(await attest(ctx, "NOT_SENT")).toMatchObject({ ok: false, reason: "OPENED", message: REFUSALS.OPENED });
    await expectUntouched(ctx);
  });

  it.each([
    ["status", { status: "PENDING" }],
    ["token", { hint: "zzzz" }],
  ])("a stale page (%s changed)", async (_label, overrides) => {
    const ctx = await anUnknownInvitation();
    expect(await attest(ctx, "SENT", overrides)).toMatchObject({ ok: false, reason: "STALE", message: REFUSALS.STALE });
    await expectUntouched(ctx);
  });

  it.each(["SENT", "FAILED", "REMINDER_PENDING", "REMINDER_UNCERTAIN"])("an invitation already %s", async (status) => {
    const ctx = await anUnknownInvitation(status);
    expect(await attest(ctx, "SENT")).toMatchObject({ ok: false, reason: "NOT_UNRESOLVED", message: REFUSALS.NOT_UNRESOLVED });
    await expectUntouched(ctx);
  });

  it("a recipient outside the campaign", async () => {
    const ctx = await anUnknownInvitation();
    expect(await attest(ctx, "SENT", { campaignId: "another-campaign" })).toMatchObject({ ok: false, reason: "NOT_FOUND", message: REFUSALS.NOT_FOUND });
    await expectUntouched(ctx);
  });

  it.each([
    ["no session", null, UnauthorizedError],
    ["a non-admin", { user: { id: "u9", email: "reader@idsculpture.com", roles: ["Reader.Only"] } }, ForbiddenError],
  ])("throws for %s", async (_label, current, expected) => {
    const ctx = await anUnknownInvitation();
    session.current = current;
    await expect(attest(ctx, "SENT")).rejects.toThrow(expected);
    await expectUntouched(ctx);
  });

  it("throws for a bad outcome value", async () => {
    const ctx = await anUnknownInvitation();
    await expect(attest(ctx, "APPLIED")).rejects.toThrow("Choose a valid reconciliation outcome.");
    await expectUntouched(ctx);
  });
});

describe("side effects", () => {
  it.each(["SENT", "NOT_SENT"])("%s sends no email and leaves the EmailMessage ledger alone", async (observed) => {
    const ctx = await anUnknownInvitation();
    const send = vi.spyOn(getEmailService(), "send");
    const ledger = await prisma.emailMessage.findMany({ orderBy: { id: "asc" } });

    expect(await attest(ctx, observed)).toEqual({ ok: true });

    expect(send).not.toHaveBeenCalled();
    expect(await prisma.emailMessage.findMany({ orderBy: { id: "asc" } })).toEqual(ledger);
  });

  it("after 'It was sent', the next reminder run includes that contact", async () => {
    const ctx = await anUnknownInvitation();
    await sendReminders(ctx.campaignId);
    expect((await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.recipient.id } })).reminderCount).toBe(0);

    expect(await attest(ctx, "SENT")).toEqual({ ok: true });
    await sendReminders(ctx.campaignId);

    expect((await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.recipient.id } })).reminderCount).toBe(1);
  });

  it("two concurrent attestations: exactly one wins", async () => {
    const ctx = await anUnknownInvitation();
    const input = {
      campaignId: ctx.campaignId,
      recipientId: ctx.recipient.id,
      shownStatus: ctx.recipient.sendStatus,
      shownTokenHint: ctx.recipient.tokenHint,
    };

    const results = await Promise.all([
      reconcileUnknownInvitation({ ...input, observed: "SENT", actor: "a" }),
      reconcileUnknownInvitation({ ...input, observed: "NOT_SENT", actor: "b" }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await reconcileAudits()).toHaveLength(1);
  });
});

describe("the campaign page", () => {
  const render = async (campaignId: string) =>
    renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));
  const controlCount = (html: string) => (html.match(/It was not sent/g) ?? []).length;

  it.each([
    ["UNCERTAIN", 60 * MINUTE],
    ["PENDING", 16 * MINUTE],
  ])("shows the control for %s (desktop and mobile)", async (status, age) => {
    const ctx = await anUnknownInvitation(status, age);
    const html = await render(ctx.campaignId);
    expect(html).toContain("It was sent");
    expect(controlCount(html)).toBe(2);
  });

  it.each([
    ["SENT", 60 * MINUTE],
    ["FAILED", 60 * MINUTE],
    ["PENDING", 15 * MINUTE - 5000],
    ["REMINDER_PENDING", 60 * MINUTE],
    ["REMINDER_UNCERTAIN", 60 * MINUTE],
  ])("shows no control for %s", async (status, age) => {
    const ctx = await anUnknownInvitation(status, age);
    expect(controlCount(await render(ctx.campaignId))).toBe(0);
  });

  it("the action the page binds settles the row it was rendered for", async () => {
    const ctx = await anUnknownInvitation();
    const tree = await CampaignDetailPage({ params: Promise.resolve({ id: ctx.campaignId }) } as never);
    const find = (node: ReactNode): { recipients: { recipientId: string }[]; reconcileInvitation: (r: unknown) => (o: string) => Promise<ReconcileActionResult> } | null => {
      if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
      if (!isValidElement(node)) return null;
      const props = node.props as Record<string, unknown>;
      if (node.type === RecipientTable) return props as never;
      return find(props.children as ReactNode);
    };
    const table = find(tree)!;
    const shown = table.recipients.find((r) => r.recipientId === ctx.recipient.id)!;

    expect(await table.reconcileInvitation(shown)("SENT")).toEqual({ ok: true });
    expect((await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.recipient.id } })).sendStatus).toBe("SENT");
  });

  it("drops the control after 'It was sent'", async () => {
    const ctx = await anUnknownInvitation();
    expect(await attest(ctx, "SENT")).toEqual({ ok: true });
    expect(controlCount(await render(ctx.campaignId))).toBe(0);
  });
});
