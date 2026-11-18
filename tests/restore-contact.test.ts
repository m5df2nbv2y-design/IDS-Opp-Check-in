import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreContactAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { ActionButton } from "@/components/admin/action-button";
import { RecipientTable } from "@/components/admin/recipient-table";
import { prisma } from "@/lib/db";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS, listAuditEvents } from "@/server/services/audit-service";
import { closeCampaignIfDone, closeOutContact, getCampaignSummary, RESTORE_MESSAGES, restoreContact } from "@/server/services/campaign-service";
import { resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** An admin can undo a close-out: the contact's existing link opens again and a COMPLETE campaign reopens. */

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
const LABEL = "Restore this contact";
const call = restoreContactAction as (...args: unknown[]) => Promise<void | { error: string }>;

/** Launched; the contact with the most items answered one item, one item's opportunity closed, and they were closed out. */
async function closedOut() {
  const { campaignId, tokens } = await launchCampaignAndCollectTokens("Restore");
  const recipients = await prisma.checkInRecipient.findMany({ where: { campaignId }, include: { contact: true, items: { orderBy: { position: "asc" } } } });
  const target = recipients.find((r) => r.items.length >= 2)!;
  const token = tokens.get(target.contact.name)!;
  const [answered, drifted] = target.items;
  expect(await saveResponse({ token, itemId: answered.id, stage: answered.previousStatus, closeDate: "2027-12-31" })).toMatchObject({ ok: true });
  await prisma.opportunity.update({ where: { id: drifted.opportunityId }, data: { isOpen: false } });
  const before = (await rowOf(campaignId, target.id))!;
  expect(await closeOutContact({ campaignId, recipientId: target.id, shownTokenHint: before.tokenHint, shownNote: before.closeOutReason!, actor: "josh@idsculpture.com" })).toEqual({ ok: true });
  const row = (await rowOf(campaignId, target.id))!;
  return { campaignId, token, target, before, row, beforeDb: await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: target.id } }) };
}
type Ctx = Awaited<ReturnType<typeof closedOut>>;

const rowOf = async (campaignId: string, recipientId: string) => (await getCampaignSummary(campaignId))!.recipients.find((r) => r.recipientId === recipientId);
const restores = (campaignId: string) => prisma.auditEvent.findMany({ where: { campaignId, type: AUDIT_EVENTS.RECIPIENT_RESTORED } });
const recipientRow = (ctx: Ctx) => prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.target.id } });
const campaignOf = (campaignId: string) => prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
const service = (ctx: Ctx, hint = ctx.row.tokenHint) =>
  restoreContact({ campaignId: ctx.campaignId, recipientId: ctx.target.id, shownTokenHint: hint, actor: "josh@idsculpture.com" });
/** Only the other contacts are left: mark them finished so the campaign completes. */
const completeOthers = (ctx: Ctx) =>
  prisma.checkInRecipient.updateMany({ where: { campaignId: ctx.campaignId, id: { not: ctx.target.id } }, data: { completedAt: new Date() } });

async function expectUntouched(ctx: Ctx) {
  expect((await recipientRow(ctx)).revokedAt).toBeInstanceOf(Date);
  expect(await restores(ctx.campaignId)).toHaveLength(0);
}

const render = async (campaignId: string) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));
const count = (html: string) => (html.match(new RegExp(LABEL, "g")) ?? []).length;
async function buttonsByLayout(campaignId: string) {
  const html = await render(campaignId);
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const list = html.slice(html.indexOf("md:hidden"), html.indexOf("</ul>", html.indexOf("md:hidden")));
  return { desktop: count(table), mobile: count(list) };
}

/** The table props the page renders: the bound restore action and whether the campaign is complete. */
async function tableProps(campaignId: string) {
  const tree = await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never);
  type Table = { recipients: { recipientId: string }[]; campaignComplete?: boolean; restoreContact: (r: unknown) => () => Promise<void | { error: string }> };
  const find = (node: ReactNode): Table | null => {
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (!isValidElement(node)) return null;
    const props = node.props as Record<string, unknown>;
    if (node.type === RecipientTable) return props as never;
    return find(props.children as ReactNode);
  };
  return find(tree)!;
}

/** The confirm text of the button labelled `label` on one rendered row (expands plain function components). */
async function confirmOf(campaignId: string, recipientId: string, label: string) {
  const find = (node: ReactNode): Record<string, unknown> | null => {
    if (Array.isArray(node)) return node.map(find).find(Boolean) ?? null;
    if (!isValidElement(node)) return null;
    const props = node.props as Record<string, unknown>;
    if (node.type === ActionButton && props.children === label) return props;
    if (typeof node.type === "function" && node.type !== ActionButton) return find((node.type as (p: unknown) => ReactNode)(props));
    return find(props.children as ReactNode);
  };
  const table = await tableProps(campaignId);
  return find(RecipientTable({ ...table, recipients: table.recipients.filter((r) => r.recipientId === recipientId) } as never))?.confirm as string | undefined;
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

describe("restore a closed-out contact", () => {
  it("open campaign: the bound button clears revokedAt, audits it, and the row returns to its prior state", async () => {
    const ctx = await closedOut();
    expect(ctx.row).toMatchObject({ status: "REVOKED", canRestore: true, canCloseOut: false });
    const confirm = await confirmOf(ctx.campaignId, ctx.target.id, LABEL);
    expect(confirm).toContain(`Restore ${ctx.target.contact.name}?`);
    expect(confirm).toContain("holds the campaign open again");
    expect(confirm).not.toContain("reopens");
    expect(await buttonsByLayout(ctx.campaignId)).toEqual({ desktop: 1, mobile: 1 });
    const emailsBefore = await prisma.emailMessage.count();

    const table = await tableProps(ctx.campaignId);
    expect(await table.restoreContact(table.recipients.find((r) => r.recipientId === ctx.target.id))()).toBeUndefined();
    expect(session.revalidated).toEqual([`/admin/campaigns/${ctx.campaignId}`, "/admin"]);

    const after = await recipientRow(ctx);
    expect(after).toEqual({ ...ctx.beforeDb, revokedAt: null });
    expect(await prisma.emailMessage.count()).toBe(emailsBefore);

    const [audit] = await restores(ctx.campaignId);
    expect(audit).toMatchObject({ actor: "josh@idsculpture.com", actorKind: "ADMIN", contactId: ctx.target.contactId });
    expect(audit.summary).not.toContain("reopened");
    expect(JSON.parse(audit.detail!)).toEqual({ version: 1, recipientId: ctx.target.id, tokenHint: ctx.row.tokenHint });

    const row = (await rowOf(ctx.campaignId, ctx.target.id))!;
    expect(row).toMatchObject({ status: ctx.before.status, canRestore: false, canCloseOut: true, closeOutReason: ctx.before.closeOutReason, reminderCount: ctx.before.reminderCount, sendStatus: ctx.before.sendStatus });
    expect(row.deliveryNote).not.toContain("Link revoked");
    expect(await buttonsByLayout(ctx.campaignId)).toEqual({ desktop: 0, mobile: 0 });
    expect((await campaignOf(ctx.campaignId)).status).toBe("IN_PROGRESS");
  });

  it("the same link opens again after restore", async () => {
    const ctx = await closedOut();
    expect(await resolveCheckInToken(ctx.token)).toEqual({ ok: false, reason: "REVOKED" });
    expect(await service(ctx)).toEqual({ ok: true });
    expect(await resolveCheckInToken(ctx.token)).toMatchObject({ ok: true });
  });

  it("an expired link stays expired after restore", async () => {
    const ctx = await closedOut();
    await prisma.checkInRecipient.update({ where: { id: ctx.target.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await service(ctx)).toEqual({ ok: true });
    expect(await resolveCheckInToken(ctx.token)).toMatchObject({ ok: false });
  });

  it("COMPLETE campaign: restoring reopens it in the same transaction, and the page shows In Progress", async () => {
    const ctx = await closedOut();
    await completeOthers(ctx);
    // Closing out the last blocker completed it; a later close-out does the same.
    await closeCampaignIfDone(ctx.campaignId);
    expect(await campaignOf(ctx.campaignId)).toMatchObject({ status: "COMPLETE", completedAt: expect.any(Date) });
    const completedBefore = (await campaignOf(ctx.campaignId)).completedAt!;
    expect((await tableProps(ctx.campaignId)).campaignComplete).toBe(true);
    expect(await confirmOf(ctx.campaignId, ctx.target.id, LABEL)).toMatch(new RegExp(`^Restore ${ctx.target.contact.name}\\?.*The campaign reopens`));
    expect(await buttonsByLayout(ctx.campaignId)).toEqual({ desktop: 1, mobile: 1 });

    expect(await service(ctx)).toEqual({ ok: true });
    expect(await campaignOf(ctx.campaignId)).toMatchObject({ status: "IN_PROGRESS", completedAt: null });
    const [audit] = await restores(ctx.campaignId);
    expect(audit.summary).toContain(`the campaign reopened (it had completed at ${completedBefore.toISOString()})`);
    const html = await render(ctx.campaignId);
    expect(html).toContain("In Progress");
    expect(html).not.toContain("Link revoked");
  });

  it("the audit trail shows both the close-out and the restore, with the admin", async () => {
    const ctx = await closedOut();
    expect(await service(ctx)).toEqual({ ok: true });
    const events = (await listAuditEvents({ campaignId: ctx.campaignId })).filter((e) => e.contactId === ctx.target.contactId);
    const types = events.map((e) => e.type);
    expect(types).toContain(AUDIT_EVENTS.RECIPIENT_CLOSED_OUT);
    expect(types).toContain(AUDIT_EVENTS.RECIPIENT_RESTORED);
    for (const e of events.filter((e) => e.type === AUDIT_EVENTS.RECIPIENT_CLOSED_OUT || e.type === AUDIT_EVENTS.RECIPIENT_RESTORED)) {
      expect(e.actor).toBe("josh@idsculpture.com");
    }
  });

  it("a restored contact can be closed out again, and the row shows the latest reason", async () => {
    const ctx = await closedOut();
    expect(await service(ctx)).toEqual({ ok: true });
    // Now a different reason applies: the drifted opportunity came back and the contact was reminded with no answer.
    await prisma.opportunity.update({ where: { id: ctx.target.items[1].opportunityId }, data: { isOpen: true } });
    await prisma.checkInOpportunity.updateMany({ where: { recipientId: ctx.target.id }, data: { submittedAt: null } });
    await prisma.checkInRecipient.update({ where: { id: ctx.target.id }, data: { reminderCount: 1 } });
    const row = (await rowOf(ctx.campaignId, ctx.target.id))!;
    expect(row.closeOutReason).toBe("No response");
    expect(row.closeOutReason).not.toBe(ctx.before.closeOutReason);
    // Same millisecond as the first close-out would make the order ambiguous.
    await new Promise((r) => setTimeout(r, 5));
    expect(await closeOutContact({ campaignId: ctx.campaignId, recipientId: ctx.target.id, shownTokenHint: row.tokenHint, shownNote: row.closeOutReason!, actor: "josh" })).toEqual({ ok: true });
    expect(await prisma.auditEvent.count({ where: { campaignId: ctx.campaignId, type: AUDIT_EVENTS.RECIPIENT_CLOSED_OUT } })).toBe(2);
    expect((await rowOf(ctx.campaignId, ctx.target.id))!.deliveryNote).toBe("Link revoked — No response");
  });

  it("the latest close-out by createdAt wins, whatever order the audit rows were inserted in", async () => {
    const ctx = await closedOut();
    await prisma.auditEvent.deleteMany({ where: { campaignId: ctx.campaignId, type: AUDIT_EVENTS.RECIPIENT_CLOSED_OUT } });
    const closeOut = (reason: string, createdAt: Date) => prisma.auditEvent.create({ data: {
      type: AUDIT_EVENTS.RECIPIENT_CLOSED_OUT, summary: "x", actor: "josh", actorKind: "ADMIN", campaignId: ctx.campaignId, contactId: ctx.target.contactId, createdAt,
      detail: JSON.stringify({ version: 1, recipientId: ctx.target.id, tokenHint: ctx.row.tokenHint, reason }),
    } });
    // Newer row inserted first, so insertion order disagrees with createdAt.
    await closeOut("Newer reason", new Date("2026-02-01T00:00:00Z"));
    await closeOut("Older reason", new Date("2026-01-01T00:00:00Z"));
    expect((await rowOf(ctx.campaignId, ctx.target.id))!.deliveryNote).toBe("Link revoked — Newer reason");
  });

  it("already restored / double click: nothing written", async () => {
    const ctx = await closedOut();
    expect(await service(ctx)).toEqual({ ok: true });
    expect(await service(ctx)).toEqual({ ok: false, message: RESTORE_MESSAGES.ALREADY_RESTORED });
    expect(await restores(ctx.campaignId)).toHaveLength(1);
  });

  it("two concurrent restores write exactly one audit row", async () => {
    const ctx = await closedOut();
    const results = await Promise.all([service(ctx), service(ctx)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await restores(ctx.campaignId)).toHaveLength(1);
  });

  it("never closed out: refused, nothing written", async () => {
    const ctx = await closedOut();
    const other = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId: ctx.campaignId, id: { not: ctx.target.id } } });
    expect(await restoreContact({ campaignId: ctx.campaignId, recipientId: other.id, shownTokenHint: other.tokenHint, actor: "josh" })).toEqual({ ok: false, message: RESTORE_MESSAGES.ALREADY_RESTORED });
    expect(await restores(ctx.campaignId)).toHaveLength(0);
  });

  it("stale page: a different tokenHint writes nothing", async () => {
    const ctx = await closedOut();
    expect(await service(ctx, "other-hint")).toEqual({ ok: false, message: RESTORE_MESSAGES.CHANGED });
    await expectUntouched(ctx);
  });

  it.each(["DRAFT", "CANCELLED"])("a %s campaign: no control, refused", async (state) => {
    const ctx = await closedOut();
    await prisma.campaign.update({ where: { id: ctx.campaignId }, data: { status: state } });
    expect((await rowOf(ctx.campaignId, ctx.target.id))!.canRestore).toBe(false);
    expect(await service(ctx)).toEqual({ ok: false, message: RESTORE_MESSAGES.NOT_OPEN });
    await expectUntouched(ctx);
  });

  it("the action with a stale hint returns the CHANGED refusal and still revalidates", async () => {
    const ctx = await closedOut();
    expect(await call(ctx.campaignId, ctx.target.id, "other-hint")).toEqual({ error: RESTORE_MESSAGES.CHANGED });
    expect(session.revalidated).toEqual([`/admin/campaigns/${ctx.campaignId}`, "/admin"]);
    await expectUntouched(ctx);
  });

  it.each([
    ["no session", null, UnauthorizedError],
    ["a non-admin", { user: { id: "u9", email: "reader@idsculpture.com", roles: ["Reader.Only"] } }, ForbiddenError],
  ])("throws for %s", async (_label, current, expected) => {
    const ctx = await closedOut();
    session.current = current;
    await expect(call(ctx.campaignId, ctx.target.id, ctx.row.tokenHint)).rejects.toThrow(expected);
    await expectUntouched(ctx);
    expect(session.revalidated).toEqual([]);
  });

  it("throws for bad input", async () => {
    const ctx = await closedOut();
    await expect(call(ctx.campaignId, ctx.target.id, 42)).rejects.toThrow("Invalid restore input");
    await expectUntouched(ctx);
  });

  it("close-out's confirm says the contact can be restored", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Restore wording");
    const target = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });
    await prisma.checkInRecipient.update({ where: { id: target.id }, data: { reminderCount: 1 } });
    const confirm = await confirmOf(campaignId, target.id, "Close out this contact");
    expect(confirm).toContain("An admin can restore this contact later.");
    expect(confirm).not.toContain("This cannot be undone.");
  });
});
