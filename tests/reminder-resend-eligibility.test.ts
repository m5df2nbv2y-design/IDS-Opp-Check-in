import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resendInvitationAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { getCampaignSummary, REMINDER_REJECTED_NOTE, RESEND_INVITATION_MESSAGES, sendReminders } from "@/server/services/campaign-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** A reminder or re-send only goes to a contact whose opportunities are all still open, resolved and theirs. */

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
const resend = resendInvitationAction as (...args: unknown[]) => Promise<void | { error: string }>;

type Drift = "closed" | "moved" | "unresolved";

/** Launch, then change one item's opportunity for the first recipient (by id) as a catalog refresh would. */
async function launchedWithDrift(drift: Drift | null, sendStatus = "SENT") {
  const { campaignId } = await launchCampaignAndCollectTokens("Eligibility");
  const recipients = await prisma.checkInRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" }, include: { items: true } });
  expect(recipients.length).toBeGreaterThan(1);
  const target = await prisma.checkInRecipient.update({
    where: { id: recipients[0].id },
    data: { sendStatus, sentAt: sendStatus === "SENT" ? recipients[0].sentAt : null, sendError: sendStatus === "FAILED" ? "Provider rejected" : null },
  });
  const opportunityId = recipients[0].items[0].opportunityId;
  if (drift === "closed") await prisma.opportunity.update({ where: { id: opportunityId }, data: { isOpen: false } });
  if (drift === "moved") await prisma.opportunity.update({ where: { id: opportunityId }, data: { contactId: recipients[1].contactId } });
  if (drift === "unresolved") await prisma.opportunity.update({ where: { id: opportunityId }, data: { resolutionStatus: "UNRESOLVED", contactId: null } });
  return { campaignId, target, others: recipients.slice(1) };
}

const auditsFor = (contactId: string, type: string) => prisma.auditEvent.findMany({ where: { contactId, type } });
const rowOf = async (campaignId: string, recipientId: string) =>
  (await getCampaignSummary(campaignId))!.recipients.find((r) => r.recipientId === recipientId)!;
const render = async (campaignId: string) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
  session.current = ADMIN;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reminders", () => {
  it("all current: every SENT recipient is counted and reminded", async () => {
    const { campaignId, target, others } = await launchedWithDrift(null);
    const total = others.length + 1;
    expect((await getCampaignSummary(campaignId))!.reminderEligibleCount).toBe(total);
    expect((await rowOf(campaignId, target.id)).deliveryNote).toBeNull();
    expect(await sendReminders(campaignId, "admin")).toBe(total);
    expect(await auditsFor(target.contactId, AUDIT_EVENTS.REMINDER_SKIPPED)).toHaveLength(0);
  });

  it.each([
    ["closed", "closed since launch"],
    ["moved", "moved to another contact"],
    ["unresolved", "no longer resolved"],
  ] as const)("%s: held back, not counted, audited as skipped, the rest reminded", async (drift, why) => {
    const { campaignId, target, others } = await launchedWithDrift(drift);
    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.reminderEligibleCount).toBe(others.length);
    const note = summary.recipients.find((r) => r.recipientId === target.id)!.deliveryNote;
    expect(note).toContain(why);
    expect(note).toContain("Refresh from Salesforce");

    expect(await sendReminders(campaignId, "admin")).toBe(others.length);
    const after = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({ tokenHash: target.tokenHash, sendStatus: "SENT", reminderCount: 0 });
    expect(await auditsFor(target.contactId, AUDIT_EVENTS.REMINDER_STARTED)).toHaveLength(0);
    const skipped = await auditsFor(target.contactId, AUDIT_EVENTS.REMINDER_SKIPPED);
    expect(skipped).toHaveLength(1);
    expect(JSON.parse(skipped[0].detail!).reason).toContain(why);
    for (const other of others) expect(await auditsFor(other.contactId, AUDIT_EVENTS.REMINDER_SENT)).toHaveLength(1);
  });

  it("an answered item whose opportunity then closed does not hold the contact back", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Answered");
    const recipients = await prisma.checkInRecipient.findMany({ where: { campaignId }, include: { items: { orderBy: { position: "asc" } } } });
    const target = recipients.find((r) => r.items.length >= 2)!;
    expect(target).toBeDefined();
    const [answered] = target.items;
    await prisma.checkInOpportunity.update({ where: { id: answered.id }, data: { submittedAt: new Date(), updatedStatus: "Closed Won" } });
    await prisma.opportunity.update({ where: { id: answered.opportunityId }, data: { isOpen: false } });

    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.reminderEligibleCount).toBe(recipients.length);
    expect(summary.recipients.find((r) => r.recipientId === target.id)!.deliveryNote).toBeNull();
    expect(await sendReminders(campaignId, "admin")).toBe(recipients.length);
    expect(await auditsFor(target.contactId, AUDIT_EVENTS.REMINDER_SENT)).toHaveLength(1);
    expect(await auditsFor(target.contactId, AUDIT_EVENTS.REMINDER_SKIPPED)).toHaveLength(0);

    await prisma.checkInRecipient.update({ where: { id: target.id }, data: { sendStatus: "FAILED", sentAt: null, sendError: "Provider rejected" } });
    expect((await rowOf(campaignId, target.id)).canResendInvitation).toBe(true);
  });

  it("a rejected reminder then a closed opportunity: the row shows both notes and is not counted", async () => {
    const { campaignId, target } = await launchedWithDrift(null);
    await prisma.checkInRecipient.updateMany({ where: { campaignId, id: { not: target.id } }, data: { completedAt: new Date() } });
    vi.spyOn(getEmailService(), "send").mockResolvedValue({ id: "rejected", status: "FAILED", error: "Rejected" });
    expect(await sendReminders(campaignId, "admin")).toBe(0);
    vi.restoreAllMocks();
    const items = await prisma.checkInOpportunity.findMany({ where: { recipientId: target.id } });
    await prisma.opportunity.update({ where: { id: items[0].opportunityId }, data: { isOpen: false } });

    const summary = (await getCampaignSummary(campaignId))!;
    const note = summary.recipients.find((r) => r.recipientId === target.id)!.deliveryNote;
    expect(note).toContain(REMINDER_REJECTED_NOTE);
    expect(note).toContain("closed since launch");
    expect(summary.reminderEligibleCount).toBe(0);
  });

  it("an opportunity closed after the batch read its recipients is still not reminded", async () => {
    const { campaignId, target, others } = await launchedWithDrift(null);
    const items = await prisma.checkInOpportunity.findMany({ where: { recipientId: target.id } });
    const read = prisma.checkInRecipient.findMany.bind(prisma.checkInRecipient);
    // A catalog refresh lands between the batch's read and the per-recipient claim.
    vi.spyOn(prisma.checkInRecipient, "findMany").mockImplementationOnce((async (args: never) => {
      const rows = await read(args);
      await prisma.opportunity.update({ where: { id: items[0].opportunityId }, data: { isOpen: false } });
      return rows;
    }) as never);

    expect(await sendReminders(campaignId, "admin")).toBe(others.length);
    expect(await auditsFor(target.contactId, AUDIT_EVENTS.REMINDER_STARTED)).toHaveLength(0);
    expect(await auditsFor(target.contactId, AUDIT_EVENTS.REMINDER_SKIPPED)).toHaveLength(1);
    expect((await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: target.id } })).tokenHash).toBe(target.tokenHash);
  });

  it("the page's button count excludes the held-back contact and its row says why", async () => {
    const { campaignId, others } = await launchedWithDrift("closed");
    const html = await render(campaignId);
    expect(html).toContain(`Send ${others.length} reminder${others.length === 1 ? "" : "s"}`);
    expect(html).toContain("closed since launch");
  });
});

describe("re-send", () => {
  it("all current: a FAILED invitation still offers re-send", async () => {
    const { campaignId, target } = await launchedWithDrift(null, "FAILED");
    expect((await rowOf(campaignId, target.id)).canResendInvitation).toBe(true);
  });

  it.each(["closed", "moved", "unresolved"] as const)("%s: no button, and a posted re-send writes and sends nothing", async (drift) => {
    const { campaignId, target } = await launchedWithDrift(drift, "FAILED");
    const row = await rowOf(campaignId, target.id);
    expect(row.canResendInvitation).toBe(false);
    expect(row.deliveryNote).toContain("Refresh from Salesforce");
    expect((await render(campaignId)).match(/Re-send invitation/g) ?? []).toHaveLength(0);

    const invitesBefore = await prisma.emailMessage.count({ where: { contactId: target.contactId } });
    expect(await resend(campaignId, target.id, target.tokenHint)).toEqual({ error: RESEND_INVITATION_MESSAGES.OPPORTUNITIES_CHANGED });
    expect(await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: target.id } })).toEqual(target);
    expect(await prisma.emailMessage.count({ where: { contactId: target.contactId } })).toBe(invitesBefore);
    expect(await auditsFor(target.contactId, AUDIT_EVENTS.INVITE_RESEND_STARTED)).toHaveLength(0);
  });
});
