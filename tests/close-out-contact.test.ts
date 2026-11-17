import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOutContactAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { RecipientTable } from "@/components/admin/recipient-table";
import { prisma } from "@/lib/db";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { CLOSE_OUT_MESSAGES, closeOutContact, getCampaignSummary, listResponses } from "@/server/services/campaign-service";
import { resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** A held-back contact who never finishes: an admin's audited close-out revokes their link so the campaign can close. */

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
const LABEL = "Close out this contact";
const call = closeOutContactAction as (...args: unknown[]) => Promise<void | { error: string }>;

/** Launched; the contact with the most items has one answered item and one unanswered item whose opportunity closed. */
async function heldBack() {
  const { campaignId, tokens } = await launchCampaignAndCollectTokens("Close out");
  const recipients = await prisma.checkInRecipient.findMany({ where: { campaignId }, include: { contact: true, items: { orderBy: { position: "asc" } } } });
  const target = recipients.find((r) => r.items.length >= 2)!;
  expect(target).toBeDefined();
  const token = tokens.get(target.contact.name)!;
  const [answered, drifted] = target.items;
  expect(await saveResponse({ token, itemId: answered.id, stage: answered.previousStatus, closeDate: "2027-12-31" })).toMatchObject({ ok: true });
  await prisma.opportunity.update({ where: { id: drifted.opportunityId }, data: { isOpen: false } });
  const row = (await getCampaignSummary(campaignId))!.recipients.find((r) => r.recipientId === target.id)!;
  return { campaignId, token, target, answeredId: answered.id, others: recipients.filter((r) => r.id !== target.id), row };
}
type Ctx = Awaited<ReturnType<typeof heldBack>>;

const closeOuts = (campaignId: string) => prisma.auditEvent.findMany({ where: { campaignId, type: AUDIT_EVENTS.RECIPIENT_CLOSED_OUT } });
const recipientRow = (ctx: Ctx) => prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.target.id } });
const status = async (campaignId: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;
const render = async (campaignId: string) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));
const service = (ctx: Ctx, hint = ctx.row.tokenHint, note = ctx.row.heldBackNote!) =>
  closeOutContact({ campaignId: ctx.campaignId, recipientId: ctx.target.id, shownTokenHint: hint, shownNote: note, actor: "josh" });

async function expectUntouched(ctx: Ctx) {
  expect((await recipientRow(ctx)).revokedAt).toBeNull();
  expect(await closeOuts(ctx.campaignId)).toHaveLength(0);
}

const count = (html: string) => (html.match(new RegExp(LABEL, "g")) ?? []).length;
const buttons = async (campaignId: string) => count(await render(campaignId));
/** Close-out buttons in the desktop table and in the mobile list, counted separately. */
async function buttonsByLayout(campaignId: string) {
  const html = await render(campaignId);
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const list = html.slice(html.indexOf("md:hidden"), html.indexOf("</ul>", html.indexOf("md:hidden")));
  return { desktop: count(table), mobile: count(list) };
}

/** The close-out action the page binds for one rendered row. */
async function boundCloseOut(campaignId: string, recipientId: string) {
  const tree = await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never);
  type Table = { recipients: { recipientId: string }[]; closeOutContact: (r: unknown) => () => Promise<void | { error: string }> };
  const find = (node: ReactNode): Table | null => {
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (!isValidElement(node)) return null;
    const props = node.props as Record<string, unknown>;
    if (node.type === RecipientTable) return props as never;
    return find(props.children as ReactNode);
  };
  const table = find(tree)!;
  return table.closeOutContact(table.recipients.find((r) => r.recipientId === recipientId)!);
}

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
  session.current = ADMIN;
  session.revalidated = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("close out a held-back contact", () => {
  it("the page's bound button revokes the link, audits it, and the row shows Link revoked with the reason", async () => {
    const ctx = await heldBack();
    expect(ctx.row.canCloseOut).toBe(true);
    expect(ctx.row.heldBackNote).toContain("closed since launch");
    expect(await buttonsByLayout(ctx.campaignId)).toEqual({ desktop: 1, mobile: 1 });

    expect(await (await boundCloseOut(ctx.campaignId, ctx.target.id))()).toBeUndefined();
    expect((await recipientRow(ctx)).revokedAt).toBeInstanceOf(Date);
    expect(await resolveCheckInToken(ctx.token)).toEqual({ ok: false, reason: "REVOKED" });
    expect(await saveResponse({ token: ctx.token, itemId: ctx.target.items[1].id, stage: ctx.target.items[1].previousStatus })).toMatchObject({ ok: false });

    const [audit] = await closeOuts(ctx.campaignId);
    expect(audit).toMatchObject({ actor: "josh@idsculpture.com", actorKind: "ADMIN", contactId: ctx.target.contactId });
    expect(JSON.parse(audit.detail!)).toEqual({ version: 1, recipientId: ctx.target.id, tokenHint: ctx.row.tokenHint, reason: ctx.row.heldBackNote });
    expect(session.revalidated).toEqual([`/admin/campaigns/${ctx.campaignId}`, "/admin"]);
    // No email sent.
    expect(await prisma.emailMessage.count({ where: { contactId: ctx.target.contactId, kind: { not: "INVITE" } } })).toBe(0);

    const row = (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.target.id)!;
    expect(row).toMatchObject({ status: "REVOKED", canCloseOut: false, canResendInvitation: false, canReconcileInvitation: false });
    expect(row.deliveryNote).toBe(`Link revoked — ${ctx.row.heldBackNote}`);
    const html = await render(ctx.campaignId);
    expect(html).toContain("Link revoked");
    expect(await buttons(ctx.campaignId)).toBe(0);
  });

  it("last blocker: closing out the only outstanding contact completes the campaign", async () => {
    const ctx = await heldBack();
    await prisma.checkInRecipient.updateMany({ where: { campaignId: ctx.campaignId, id: { not: ctx.target.id } }, data: { completedAt: new Date() } });
    expect(await status(ctx.campaignId)).toBe("IN_PROGRESS");
    expect(await service(ctx)).toEqual({ ok: true });
    expect(await status(ctx.campaignId)).toBe("COMPLETE");
  });

  it("others still outstanding: the campaign stays IN_PROGRESS", async () => {
    const ctx = await heldBack();
    expect(await service(ctx)).toEqual({ ok: true });
    expect(await status(ctx.campaignId)).toBe("IN_PROGRESS");
  });

  it("answers already submitted are kept, unchanged, in the review list", async () => {
    const ctx = await heldBack();
    const before = await prisma.checkInOpportunity.findMany({ where: { recipientId: ctx.target.id }, orderBy: { id: "asc" } });
    expect(await service(ctx)).toEqual({ ok: true });
    expect(await prisma.checkInOpportunity.findMany({ where: { recipientId: ctx.target.id }, orderBy: { id: "asc" } })).toEqual(before);
    expect((await listResponses(ctx.campaignId)).map((r) => r.id)).toContain(ctx.answeredId);

  });

  it("not held back: no control, and a posted close-out writes nothing", async () => {
    const ctx = await heldBack();
    // A catalog refresh brings the opportunity back.
    await prisma.opportunity.update({ where: { id: ctx.target.items[1].opportunityId }, data: { isOpen: true } });
    const row = (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.target.id)!;
    expect(row.canCloseOut).toBe(false);
    expect(await buttons(ctx.campaignId)).toBe(0);
    expect(await service(ctx)).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.NOT_HELD_BACK });
    await expectUntouched(ctx);
  });

  it("stale page: a changed link or held-back note writes nothing", async () => {
    const ctx = await heldBack();
    expect(await service(ctx, "other-hint")).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.CHANGED });
    expect(await service(ctx, ctx.row.tokenHint, "A different note")).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.CHANGED });
    await expectUntouched(ctx);
  });

  it("already revoked: a second close-out writes nothing", async () => {
    const ctx = await heldBack();
    expect(await service(ctx)).toEqual({ ok: true });
    expect(await service(ctx)).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.FINISHED });
    expect(await closeOuts(ctx.campaignId)).toHaveLength(1);
  });

  it("completed contact: refused with nothing written", async () => {
    const ctx = await heldBack();
    await prisma.checkInRecipient.update({ where: { id: ctx.target.id }, data: { completedAt: new Date() } });
    expect(await service(ctx)).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.FINISHED });
    await expectUntouched(ctx);
  });

  it("two concurrent close-outs write exactly one audit row", async () => {
    const ctx = await heldBack();
    const results = await Promise.all([service(ctx), service(ctx)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await closeOuts(ctx.campaignId)).toHaveLength(1);
  });

  it("a campaign that is not IN_PROGRESS: no control, refused", async () => {
    const ctx = await heldBack();
    await prisma.campaign.update({ where: { id: ctx.campaignId }, data: { status: "COMPLETE" } });
    expect(await buttons(ctx.campaignId)).toBe(0);
    expect(await service(ctx)).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.NOT_IN_PROGRESS });
    await expectUntouched(ctx);
  });

  it.each([
    ["no session", null, UnauthorizedError],
    ["a non-admin", { user: { id: "u9", email: "reader@idsculpture.com", roles: ["Reader.Only"] } }, ForbiddenError],
  ])("throws for %s", async (_label, current, expected) => {
    const ctx = await heldBack();
    session.current = current;
    await expect(call(ctx.campaignId, ctx.target.id, ctx.row.tokenHint, ctx.row.heldBackNote)).rejects.toThrow(expected);
    await expectUntouched(ctx);
    expect(session.revalidated).toEqual([]);
  });

  it("throws for bad input", async () => {
    const ctx = await heldBack();
    await expect(call(ctx.campaignId, ctx.target.id, ctx.row.tokenHint, 42)).rejects.toThrow("Invalid close-out input");
    await expectUntouched(ctx);
  });

  it("a held-back FAILED invitation offers close-out, not re-send, and can be closed out", async () => {
    const ctx = await heldBack();
    await prisma.checkInRecipient.update({ where: { id: ctx.target.id }, data: { sendStatus: "FAILED", sentAt: null, sendError: "Provider rejected" } });
    const row = (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.target.id)!;
    expect(row).toMatchObject({ canCloseOut: true, canResendInvitation: false });
    const html = await render(ctx.campaignId);
    expect(html).not.toContain("Re-send invitation");
    expect(await buttonsByLayout(ctx.campaignId)).toEqual({ desktop: 1, mobile: 1 });
    expect(await service(ctx)).toEqual({ ok: true });
    expect((await recipientRow(ctx)).revokedAt).toBeInstanceOf(Date);
  });

  it("a closed-out contact with a failed sync shows SYNC_ERROR, not REVOKED", async () => {
    const ctx = await heldBack();
    expect(await service(ctx)).toEqual({ ok: true });
    await prisma.checkInOpportunity.update({ where: { id: ctx.answeredId }, data: { syncStatus: "FAILED" } });
    const row = (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.target.id)!;
    expect(row.status).toBe("SYNC_ERROR");
    expect(row.deliveryNote).toContain("Link revoked");
  });

  it("the action with a stale note returns the CHANGED refusal and still revalidates", async () => {
    const ctx = await heldBack();
    expect(await call(ctx.campaignId, ctx.target.id, ctx.row.tokenHint, "A different note")).toEqual({ error: CLOSE_OUT_MESSAGES.CHANGED });
    expect(session.revalidated).toEqual([`/admin/campaigns/${ctx.campaignId}`, "/admin"]);
    await expectUntouched(ctx);
  });

  it("an unreadable close-out audit row does not break the summary", async () => {
    const ctx = await heldBack();
    expect(await service(ctx)).toEqual({ ok: true });
    await prisma.auditEvent.updateMany({ where: { campaignId: ctx.campaignId, type: AUDIT_EVENTS.RECIPIENT_CLOSED_OUT }, data: { detail: "not json" } });
    const row = (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.target.id)!;
    expect(row.deliveryNote).toBe("Link revoked");
  });
});
