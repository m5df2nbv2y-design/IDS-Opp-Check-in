import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { ActionButton } from "@/components/admin/action-button";
import { RecipientTable } from "@/components/admin/recipient-table";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { CLOSE_OUT_MESSAGES, closeOutContact, getCampaignSummary, sendReminders } from "@/server/services/campaign-service";
import { resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** A contact who never finished, or whose invitation never arrived, can be closed out so the campaign can close. */

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};

/** Launched; the target contact is SENT and has not been reminded yet. */
async function launched() {
  const { campaignId, tokens } = await launchCampaignAndCollectTokens("Close out no response");
  const recipients = await prisma.checkInRecipient.findMany({ where: { campaignId }, include: { contact: true, items: true } });
  const target = recipients.find((r) => r.items.length >= 2)!;
  expect(target.sendStatus).toBe("SENT");
  expect(target.reminderCount).toBe(0);
  return { campaignId, target, token: tokens.get(target.contact.name)! };
}
type Ctx = Awaited<ReturnType<typeof launched>>;

const setTarget = (ctx: Ctx, data: { sendStatus?: string; reminderCount?: number; sentAt?: Date | null }) =>
  prisma.checkInRecipient.update({ where: { id: ctx.target.id }, data });
const rowOf = async (ctx: Ctx) => (await getCampaignSummary(ctx.campaignId))!.recipients.find((r) => r.recipientId === ctx.target.id)!;
const service = (ctx: Ctx, hint: string, reason: string) =>
  closeOutContact({ campaignId: ctx.campaignId, recipientId: ctx.target.id, shownTokenHint: hint, shownNote: reason, actor: "josh" });
const closeOuts = (campaignId: string) => prisma.auditEvent.findMany({ where: { campaignId, type: AUDIT_EVENTS.RECIPIENT_CLOSED_OUT } });
const status = async (campaignId: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;
async function expectUntouched(ctx: Ctx) {
  expect((await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.target.id } })).revokedAt).toBeNull();
  expect(await closeOuts(ctx.campaignId)).toHaveLength(0);
}

const render = async (campaignId: string) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));
const count = (html: string, label: string) => (html.match(new RegExp(label, "g")) ?? []).length;
/** Buttons with `label` in the desktop table and in the mobile list, counted separately. */
async function buttonsByLayout(campaignId: string, label: string) {
  const html = await render(campaignId);
  const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
  const list = html.slice(html.indexOf("md:hidden"), html.indexOf("</ul>", html.indexOf("md:hidden")));
  return { desktop: count(table, label), mobile: count(list, label) };
}

type Table = { recipients: { recipientId: string }[]; closeOutContact: (r: unknown) => () => Promise<void | { error: string }> };
/** The first element in `node` matching `test`, expanding plain function components except the one sought. */
function findElement(node: ReactNode, test: (type: unknown, props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) return node.map((n) => findElement(n, test)).find(Boolean) ?? null;
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (test(node.type, props)) return props;
  if (typeof node.type === "function" && node.type !== ActionButton) return findElement((node.type as (p: unknown) => ReactNode)(props), test);
  return findElement(props.children as ReactNode, test);
}
const pageTable = async (campaignId: string) =>
  findElement(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never), (t) => t === RecipientTable) as unknown as Table;

/** The close-out action the page binds for one rendered row. */
async function boundCloseOut(campaignId: string, recipientId: string) {
  const table = await pageTable(campaignId);
  return table.closeOutContact(table.recipients.find((r) => r.recipientId === recipientId)!);
}

/** The confirm text of the close-out button rendered for one row. */
async function closeOutConfirm(campaignId: string, recipientId: string) {
  const table = await pageTable(campaignId);
  // Render only the target row so the first close-out button is theirs.
  const only = { ...table, recipients: table.recipients.filter((r) => r.recipientId === recipientId) };
  return findElement(RecipientTable(only as never), (t, p) => t === ActionButton && p.children === "Close out this contact")?.confirm as string | undefined;
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

describe("close out a contact who never responded or could not be reached", () => {
  it("no response after a reminder: the last outstanding contact is closed out and the campaign completes", async () => {
    const ctx = await launched();
    await setTarget(ctx, { reminderCount: 1 });
    await prisma.checkInRecipient.updateMany({ where: { campaignId: ctx.campaignId, id: { not: ctx.target.id } }, data: { completedAt: new Date() } });
    const row = await rowOf(ctx);
    expect(row).toMatchObject({ canCloseOut: true, closeOutReason: "No response", heldBackNote: null });
    expect(await buttonsByLayout(ctx.campaignId, "Close out this contact")).toEqual({ desktop: 1, mobile: 1 });

    expect(await (await boundCloseOut(ctx.campaignId, ctx.target.id))()).toBeUndefined();
    expect(await resolveCheckInToken(ctx.token)).toEqual({ ok: false, reason: "REVOKED" });
    const [audit] = await closeOuts(ctx.campaignId);
    expect(JSON.parse(audit.detail!)).toEqual({ version: 1, recipientId: ctx.target.id, tokenHint: row.tokenHint, reason: "No response" });
    expect(await status(ctx.campaignId)).toBe("COMPLETE");
    expect((await rowOf(ctx)).deliveryNote).toBe("Link revoked — No response");
    expect(await prisma.emailMessage.count({ where: { contactId: ctx.target.contactId, kind: { not: "INVITE" } } })).toBe(0);
  });

  it("not yet reminded: no control, and a posted close-out writes nothing", async () => {
    const ctx = await launched();
    const row = await rowOf(ctx);
    expect(row).toMatchObject({ canCloseOut: false, closeOutReason: null });
    expect(await buttonsByLayout(ctx.campaignId, "Close out this contact")).toEqual({ desktop: 0, mobile: 0 });
    expect(await service(ctx, row.tokenHint, "No response")).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.NOT_HELD_BACK });
    await expectUntouched(ctx);
  });

  it("invitation not delivered: both re-send and close-out, one per layout, and close-out works", async () => {
    const ctx = await launched();
    await setTarget(ctx, { sendStatus: "FAILED", sentAt: null });
    const row = await rowOf(ctx);
    expect(row).toMatchObject({ canCloseOut: true, canResendInvitation: true, closeOutReason: "Invitation not delivered" });
    expect(await buttonsByLayout(ctx.campaignId, "Close out this contact")).toEqual({ desktop: 1, mobile: 1 });
    expect(await buttonsByLayout(ctx.campaignId, "Re-send invitation")).toEqual({ desktop: 1, mobile: 1 });
    expect(await service(ctx, row.tokenHint, "Invitation not delivered")).toEqual({ ok: true });
    expect((await rowOf(ctx)).deliveryNote).toBe("Link revoked — Invitation not delivered");
  });

  it("held back: the held-back note takes priority over No response", async () => {
    const ctx = await launched();
    await setTarget(ctx, { reminderCount: 1 });
    const item = await prisma.checkInOpportunity.findFirstOrThrow({ where: { recipientId: ctx.target.id } });
    await prisma.opportunity.update({ where: { id: item.opportunityId }, data: { isOpen: false } });
    const row = await rowOf(ctx);
    expect(row.heldBackNote).toContain("closed since launch");
    expect(row.closeOutReason).toBe(row.heldBackNote);
  });

  it.each(["PENDING", "UNCERTAIN", "REMINDER_PENDING", "REMINDER_UNCERTAIN"])("%s: no control, refused", async (sendStatus) => {
    const ctx = await launched();
    await setTarget(ctx, { sendStatus, reminderCount: 1 });
    const row = await rowOf(ctx);
    expect(row).toMatchObject({ canCloseOut: false, closeOutReason: null });
    expect(await service(ctx, row.tokenHint, "No response")).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.NOT_HELD_BACK });
    await expectUntouched(ctx);
  });

  it("reason changed since render: reminded since, or became held back, writes nothing", async () => {
    const ctx = await launched();
    await setTarget(ctx, { sendStatus: "FAILED", sentAt: null });
    const failedRow = await rowOf(ctx);
    // Shown "Invitation not delivered", but the row is now SENT and reminded.
    await setTarget(ctx, { sendStatus: "SENT", sentAt: new Date(), reminderCount: 1 });
    expect(await service(ctx, failedRow.tokenHint, failedRow.closeOutReason!)).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.CHANGED });
    // Shown "No response", then an opportunity closed.
    const item = await prisma.checkInOpportunity.findFirstOrThrow({ where: { recipientId: ctx.target.id } });
    await prisma.opportunity.update({ where: { id: item.opportunityId }, data: { isOpen: false } });
    expect(await service(ctx, failedRow.tokenHint, "No response")).toEqual({ ok: false, message: CLOSE_OUT_MESSAGES.CHANGED });
    await expectUntouched(ctx);
  });

  it("rejected first reminder: \"Reminder not delivered\", and can be closed out", async () => {
    const ctx = await launched();
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "rejected", status: "FAILED", error: "Rejected" });
    expect(await sendReminders(ctx.campaignId, "admin")).toBe(0);
    vi.restoreAllMocks();
    const stored = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: ctx.target.id } });
    expect(stored).toMatchObject({ sendStatus: "SENT", reminderCount: 0 });
    const row = await rowOf(ctx);
    expect(row).toMatchObject({ canCloseOut: true, closeOutReason: "Reminder not delivered" });
    expect(await service(ctx, row.tokenHint, "Reminder not delivered")).toEqual({ ok: true });
    expect((await rowOf(ctx)).deliveryNote).toBe("Link revoked — Reminder not delivered");
  });

  it("reminded and partly answered: \"Not finished\", closed out, answers unchanged", async () => {
    const ctx = await launched();
    await setTarget(ctx, { reminderCount: 1 });
    const [item] = await prisma.checkInOpportunity.findMany({ where: { recipientId: ctx.target.id }, orderBy: { position: "asc" } });
    expect(await saveResponse({ token: ctx.token, itemId: item.id, stage: item.previousStatus, closeDate: "2027-12-31" })).toMatchObject({ ok: true });
    const before = await prisma.checkInOpportunity.findMany({ where: { recipientId: ctx.target.id }, orderBy: { id: "asc" } });
    const row = await rowOf(ctx);
    expect(row).toMatchObject({ canCloseOut: true, closeOutReason: "Not finished" });
    expect(await service(ctx, row.tokenHint, "Not finished")).toEqual({ ok: true });
    expect(await prisma.checkInOpportunity.findMany({ where: { recipientId: ctx.target.id }, orderBy: { id: "asc" } })).toEqual(before);
  });

  it("the close-out confirm names the reason", async () => {
    const ctx = await launched();
    await setTarget(ctx, { reminderCount: 1 });
    expect(await closeOutConfirm(ctx.campaignId, ctx.target.id)).toContain("Reason: No response.");
    await setTarget(ctx, { sendStatus: "FAILED", sentAt: null });
    expect(await closeOutConfirm(ctx.campaignId, ctx.target.id)).toContain("Reason: Invitation not delivered.");
  });
});
