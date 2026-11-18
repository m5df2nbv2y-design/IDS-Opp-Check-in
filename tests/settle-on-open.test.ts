import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import CheckInPage from "@/app/checkin/[token]/page";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/tokens";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { resolveCheckInToken } from "@/server/services/response-service";
import { reconcileUnknownInvitation, settleInvitationOnOpen } from "@/server/services/reconcile-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/**
 * Opening the current check-in link proves the invitation arrived, so an
 * invitation whose send outcome is unknown settles itself as SENT on open.
 */

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
const MINUTE = 60 * 1000;

const settleAudits = () => prisma.auditEvent.findMany({ where: { type: AUDIT_EVENTS.INVITE_SETTLED_BY_OPEN } });

/** A launched campaign with one invitation left in `sendStatus`, its row `ageMs` old, plus that contact's link. */
async function anInvitation(sendStatus: string, ageMs = 60 * MINUTE, extra: Record<string, unknown> = {}) {
  const { campaignId, tokens } = await launchCampaignAndCollectTokens("Settle On Open");
  const target = await prisma.checkInRecipient.findFirstOrThrow({
    where: { campaignId },
    orderBy: { id: "asc" },
    include: { contact: true },
  });
  const recipient = await prisma.checkInRecipient.update({
    where: { id: target.id },
    data: {
      sendStatus,
      sentAt: null,
      sendError: "Invitation acceptance is unresolved.",
      createdAt: new Date(Date.now() - ageMs),
      ...extra,
    },
  });
  return { campaignId, recipient, contactName: target.contact.name, token: tokens.get(target.contact.name)! };
}
type Invitation = Awaited<ReturnType<typeof anInvitation>>;

const open = (token: string) => CheckInPage({ params: Promise.resolve({ token }) } as never);
const row = (ctx: Invitation) => prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.recipient.id } });

async function expectSettled(ctx: Invitation) {
  expect(await row(ctx)).toMatchObject({ sendStatus: "SENT", sendError: null, sentAt: ctx.recipient.createdAt });
  const events = await settleAudits();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actor: ctx.contactName,
    actorKind: "SYSTEM",
    campaignId: ctx.campaignId,
    contactId: ctx.recipient.contactId,
    fromStatus: ctx.recipient.sendStatus,
    toStatus: "SENT",
  });
  expect(JSON.parse(events[0].detail!)).toEqual({
    version: 1,
    recipientId: ctx.recipient.id,
    tokenHint: ctx.recipient.tokenHint,
    previousSendError: ctx.recipient.sendError,
  });
}

async function expectUnchanged(ctx: Invitation) {
  expect(await row(ctx)).toMatchObject({
    sendStatus: ctx.recipient.sendStatus,
    sendError: ctx.recipient.sendError,
    sentAt: ctx.recipient.sentAt,
  });
  expect(await settleAudits()).toHaveLength(0);
}

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
  session.current = ADMIN;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("opening the link settles an unknown invitation", () => {
  it("UNCERTAIN: recorded as SENT at the row's creation time, audited naming the contact", async () => {
    const ctx = await anInvitation("UNCERTAIN");
    await open(ctx.token);
    await expectSettled(ctx);
    expect((await row(ctx)).openedAt).not.toBeNull();
  });

  it("an interrupted PENDING (older than 15 minutes) settles the same way", async () => {
    const ctx = await anInvitation("PENDING", 16 * MINUTE);
    await open(ctx.token);
    await expectSettled(ctx);
  });

  it("settles on a later open, not only the first", async () => {
    const ctx = await anInvitation("UNCERTAIN", 60 * MINUTE, { openedAt: new Date(Date.now() - 5 * MINUTE) });
    await open(ctx.token);
    await expectSettled(ctx);
  });

  it("a completed recipient is settled; CHECKIN_OPENED is written once alongside it on a first open", async () => {
    const ctx = await anInvitation("UNCERTAIN", 60 * MINUTE, { completedAt: new Date(), openedAt: null });
    await open(ctx.token);
    await open(ctx.token);
    await expectSettled(ctx);
    expect(await prisma.auditEvent.count({
      where: { type: AUDIT_EVENTS.CHECKIN_OPENED, contactId: ctx.recipient.contactId },
    })).toBe(1);
  });

  it("a second open writes no second audit", async () => {
    const ctx = await anInvitation("UNCERTAIN");
    await open(ctx.token);
    await open(ctx.token);
    await expectSettled(ctx);
  });
});

describe("opening the link leaves these alone", () => {
  it("a PENDING row younger than 15 minutes may still be sending; the open is still recorded", async () => {
    const ctx = await anInvitation("PENDING", 15 * MINUTE - 5000);
    await open(ctx.token);
    await expectUnchanged(ctx);
    expect((await row(ctx)).openedAt).not.toBeNull();
  });

  it.each(["REMINDER_PENDING", "REMINDER_UNCERTAIN", "FAILED", "SENT"])("%s", async (status) => {
    const ctx = await anInvitation(status);
    await open(ctx.token);
    await expectUnchanged(ctx);
  });

  it("a revoked link", async () => {
    const ctx = await anInvitation("UNCERTAIN", 60 * MINUTE, { revokedAt: new Date() });
    await open(ctx.token);
    await expectUnchanged(ctx);
    await settleInvitationOnOpen(ctx.recipient.id, ctx.recipient.tokenHash);
    await expectUnchanged(ctx);
  });

  it("an expired link", async () => {
    const ctx = await anInvitation("UNCERTAIN", 60 * MINUTE, { expiresAt: new Date(Date.now() - MINUTE) });
    await open(ctx.token);
    await expectUnchanged(ctx);
    await settleInvitationOnOpen(ctx.recipient.id, ctx.recipient.tokenHash);
    await expectUnchanged(ctx);
  });
});

describe("races and failures", () => {
  it("an admin settling first wins; the open writes nothing and one audit exists", async () => {
    const ctx = await anInvitation("UNCERTAIN");
    const result = await reconcileUnknownInvitation({
      campaignId: ctx.campaignId,
      recipientId: ctx.recipient.id,
      shownStatus: "UNCERTAIN",
      shownTokenHint: ctx.recipient.tokenHint,
      observed: "SENT",
      actor: "josh@idsculpture.com",
    });
    expect(result.ok).toBe(true);
    await open(ctx.token);
    expect(await settleAudits()).toHaveLength(0);
    expect(await prisma.auditEvent.count({ where: { type: AUDIT_EVENTS.INVITE_RECONCILED_SENT } })).toBe(1);
  });

  it("an admin and an open at the same time: exactly one audit", async () => {
    const ctx = await anInvitation("UNCERTAIN");
    await Promise.all([
      settleInvitationOnOpen(ctx.recipient.id, ctx.recipient.tokenHash),
      reconcileUnknownInvitation({
        campaignId: ctx.campaignId,
        recipientId: ctx.recipient.id,
        shownStatus: "UNCERTAIN",
        shownTokenHint: ctx.recipient.tokenHint,
        observed: "SENT",
        actor: "josh@idsculpture.com",
      }),
    ]);
    const audits = await prisma.auditEvent.count({
      where: { type: { in: [AUDIT_EVENTS.INVITE_SETTLED_BY_OPEN, AUDIT_EVENTS.INVITE_RECONCILED_SENT] } },
    });
    expect(audits).toBe(1);
    expect((await row(ctx)).sendStatus).toBe("SENT");
  });

  it("an old link opened after a re-send rotated the token settles nothing", async () => {
    const ctx = await anInvitation("SENT");
    const resolved = await resolveCheckInToken(ctx.token);
    expect(resolved.ok).toBe(true);
    const rotated = await prisma.checkInRecipient.update({
      where: { id: ctx.recipient.id },
      data: { tokenHash: hashToken("a-fresh-link-token-after-resend"), tokenHint: "fresh1", sendStatus: "UNCERTAIN" },
    });

    await settleInvitationOnOpen(ctx.recipient.id, hashToken(ctx.token));

    expect(await row(ctx)).toEqual(rotated);
    expect(await settleAudits()).toHaveLength(0);
  });

  it("an admin settling between the open's read and its claim: the claim writes nothing", async () => {
    const ctx = await anInvitation("UNCERTAIN");
    const adminSentAt = new Date(Date.now() - 30 * MINUTE);
    const original = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: typeof prisma) => Promise<unknown>) =>
      original((tx) => {
        const client = tx as typeof prisma;
        const updateMany = client.checkInRecipient.updateMany.bind(client.checkInRecipient);
        const checkInRecipient = new Proxy(client.checkInRecipient, {
          get: (target, key, receiver) =>
            key === "updateMany"
              ? async (args: Parameters<typeof updateMany>[0]) => {
                  await prisma.checkInRecipient.update({
                    where: { id: ctx.recipient.id },
                    data: { sendStatus: "SENT", sendError: null, sentAt: adminSentAt },
                  });
                  return updateMany(args);
                }
              : Reflect.get(target, key, receiver),
        });
        return fn(new Proxy(client, { get: (t, k, r) => (k === "checkInRecipient" ? checkInRecipient : Reflect.get(t, k, r)) }));
      })) as never);

    await settleInvitationOnOpen(ctx.recipient.id, ctx.recipient.tokenHash);

    expect(await row(ctx)).toMatchObject({ sendStatus: "SENT", sendError: null, sentAt: adminSentAt });
    expect(await settleAudits()).toHaveLength(0);
  });

  it("a database error while settling is swallowed and the page still renders", async () => {
    const ctx = await anInvitation("UNCERTAIN");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database unavailable"));
    expect(isValidElement(await open(ctx.token))).toBe(true);
    expect((await row(ctx)).openedAt).not.toBeNull();
    await expectUnchanged(ctx);
  });
});

describe("the campaign page", () => {
  it("shows a settled row as sent with no reconcile control", async () => {
    const ctx = await anInvitation("UNCERTAIN");
    const render = async () =>
      renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: ctx.campaignId }) } as never));
    expect(await render()).toContain("It was not sent");

    await open(ctx.token);

    expect(await render()).not.toContain("It was not sent");
  });
});
