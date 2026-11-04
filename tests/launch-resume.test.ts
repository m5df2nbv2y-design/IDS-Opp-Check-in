import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { getUnreachedOpportunityIds, launchCampaign, resumeLaunch } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

const FIRST = "Jane Doe";

/** A campaign launched for one contact, with every other contact selected but never reached. */
async function halfSentCampaign() {
  await refreshCatalogFromSalesforce("test");
  const all = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    select: { id: true, contactId: true, contact: { select: { name: true } } },
  });
  const mine = all.filter((o) => o.contact!.name === FIRST);
  const others = all.filter((o) => o.contact!.name !== FIRST);
  expect(mine.length).toBeGreaterThan(0);
  expect(others.length).toBeGreaterThan(0);
  const result = await launchCampaign({
    opportunityIds: mine.map((o) => o.id),
    name: "Resume",
    period: "Test",
    actor: "test",
  });
  await prisma.campaignSelection.createMany({
    data: others.map((o) => ({ campaignId: result.campaignId, opportunityId: o.id })),
  });
  // This fixture represents the approved routing checkpoint before an
  // interrupted launch; arbitrary selections appended later lack this evidence.
  await prisma.auditEvent.updateMany({ where: { campaignId: result.campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING }, data: {
    detail: JSON.stringify({ version: 1, routes: Object.fromEntries(all.map(o => [o.id, o.contactId])) }),
  } });
  return { campaignId: result.campaignId, mine, others, otherContacts: new Set(others.map((o) => o.contactId!)) };
}

const invites = (campaignId: string) =>
  prisma.emailMessage.findMany({ where: { campaignId, kind: "INVITE" } });

describe("resume a half-sent launch", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  it("resume emails only contacts that have no recipient row", async () => {
    const { campaignId, otherContacts } = await halfSentCampaign();
    const before = (await invites(campaignId)).length;
    const result = await resumeLaunch(campaignId, "test");
    expect(result.emailsSent).toBe(otherContacts.size);
    expect((await invites(campaignId)).length).toBe(before + otherContacts.size);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(otherContacts.size + 1);
  });

  it("resume never emails a contact that already has a recipient", async () => {
    const { campaignId } = await halfSentCampaign();
    await resumeLaunch(campaignId, "test");
    const jane = await prisma.externalContact.findFirstOrThrow({ where: { name: FIRST } });
    expect(await prisma.checkInRecipient.count({ where: { campaignId, contactId: jane.id } })).toBe(1);
    expect((await invites(campaignId)).filter((e) => e.toName === FIRST).length).toBe(1);
  });

  it("two simultaneous resumes send each missing contact once", async () => {
    const { campaignId, otherContacts } = await halfSentCampaign();
    await Promise.all([resumeLaunch(campaignId, "a"), resumeLaunch(campaignId, "b")]);
    expect((await invites(campaignId)).length).toBe(otherContacts.size + 1);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(otherContacts.size + 1);
  });

  it("an original launch skips a contact the resume already created instead of throwing", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    await prisma.checkInRecipient.create({
      data: {
        campaignId,
        contactId: target.contactId!,
        tokenHash: "resume-made",
        tokenHint: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const before = (await invites(campaignId)).length;
    const result = await launchCampaign({ opportunityIds: [target.id], campaignId, actor: "test" });
    expect(result.emailsSent).toBe(0);
    expect((await invites(campaignId)).length).toBe(before);
  });

  it("an old zero-item pending claim is preserved for reconciliation", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    const orphan = await prisma.checkInRecipient.create({
      data: {
        campaignId,
        contactId: target.contactId!,
        tokenHash: "orphan",
        tokenHint: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await resumeLaunch(campaignId, "test");
    const rows = await prisma.checkInRecipient.findMany({
      where: { campaignId, contactId: target.contactId! },
      include: { items: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orphan.id);
    expect(rows[0].items).toHaveLength(0);
    expect(rows[0].sendStatus).toBe("PENDING");
  });

  it("resume refuses a campaign that is not IN_PROGRESS", async () => {
    const { campaignId } = await halfSentCampaign();
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DRAFT" } });
    await expect(resumeLaunch(campaignId, "test")).rejects.toThrow(/IN_PROGRESS/);
  });

  it("a fresh zero-item pending recipient is left alone (it may be mid-launch)", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    const fresh = await prisma.checkInRecipient.create({
      data: {
        campaignId,
        contactId: target.contactId!,
        tokenHash: "fresh",
        tokenHint: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await resumeLaunch(campaignId, "test");
    expect(await prisma.checkInRecipient.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it("a drifted-then-sendable selection never expands an existing invitation", async () => {
    const { campaignId, mine } = await halfSentCampaign();
    expect(mine.length).toBeGreaterThan(1);
    const gap = mine[1];
    await prisma.checkInOpportunity.deleteMany({ where: { opportunityId: gap.id, recipient: { campaignId } } });
    await prisma.opportunity.update({ where: { id: gap.id }, data: { isOpen: false } });
    expect((await resumeLaunch(campaignId, "test")).unreachedAfter).toBe(1);
    const reached = () =>
      prisma.checkInOpportunity.count({ where: { opportunityId: gap.id, recipient: { campaignId } } });
    expect(await reached()).toBe(0);
    await prisma.opportunity.update({ where: { id: gap.id }, data: { isOpen: true } });
    const before = (await invites(campaignId)).length;
    const after = await resumeLaunch(campaignId, "test");
    expect(await reached()).toBe(0);
    expect((await invites(campaignId)).length).toBe(before);
    expect(after.unreachedAfter).toBe(1);
    expect(await getUnreachedOpportunityIds(campaignId)).toEqual([gap.id]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("IN_PROGRESS");
  });

  it.each([["completedAt"], ["revokedAt"]])(
    "a %s recipient gets nothing added and the shortfall is reported",
    async (field) => {
      const { campaignId, mine } = await halfSentCampaign();
      const gap = mine[1];
      await prisma.checkInOpportunity.deleteMany({ where: { opportunityId: gap.id, recipient: { campaignId } } });
      await prisma.checkInRecipient.updateMany({
        where: { campaignId, contact: { name: FIRST } },
        data: { [field]: new Date() },
      });
      const result = await resumeLaunch(campaignId, "test");
      expect(result.unreachedAfter).toBeGreaterThan(0);
      expect(
        await prisma.checkInOpportunity.count({ where: { opportunityId: gap.id, recipient: { campaignId } } }),
      ).toBe(0);
    },
  );

  it("routing changes to a new contact require review", async () => {
    const { campaignId, others, mine } = await halfSentCampaign();
    await prisma.opportunity.update({ where: { id: others[0].id }, data: { contactId: mine[0].contactId } });
    const result = await resumeLaunch(campaignId, "test");
    expect(result.unreachedAfter).toBeGreaterThan(0);
    expect(await prisma.checkInOpportunity.count({ where: { opportunityId: others[0].id, recipient: { campaignId } } })).toBe(0);
  });

  it("legacy routing without a checkpoint requires review", async () => {
    const { campaignId } = await halfSentCampaign();
    await prisma.auditEvent.deleteMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
    const before = (await invites(campaignId)).length;
    expect((await resumeLaunch(campaignId)).unreachedAfter).toBeGreaterThan(0);
    expect((await invites(campaignId)).length).toBe(before);
  });

  it("resume with nothing unreached returns a zero result and writes no audit row", async () => {
    const { campaignId } = await halfSentCampaign();
    await resumeLaunch(campaignId, "test");
    const audits = () => prisma.auditEvent.count({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_CREATED } });
    const before = await audits();
    const result = await resumeLaunch(campaignId, "test");
    expect(result).toMatchObject({ emailsSent: 0, recipients: 0, opportunities: 0, unreachedAfter: 0 });
    expect(await audits()).toBe(before);
  });

  it("a unique violation on another target is rethrown, not swallowed", async () => {
    const { campaignId } = await halfSentCampaign();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002", meta: { target: ["tokenHash"] } }),
    );
    await expect(resumeLaunch(campaignId, "test")).rejects.toThrow("dup");
  });

  const adapterConflict = (fields: string[]) =>
    Object.assign(new Error("dup"), { code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields } } } } });

  it("a unique violation reported only as constraint fields is a claim conflict when it is (campaignId, contactId)", async () => {
    const { campaignId, otherContacts } = await halfSentCampaign();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(adapterConflict(["campaignId", "contactId"]));
    await expect(resumeLaunch(campaignId, "test")).resolves.toBeDefined();
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(otherContacts.size);
  });

  it("a unique violation reported only as constraint fields is rethrown when it is another target", async () => {
    const { campaignId } = await halfSentCampaign();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(adapterConflict(["tokenHash"]));
    await expect(resumeLaunch(campaignId, "test")).rejects.toThrow("dup");
  });

  it("a drifted-then-sendable opportunity of a never-launched contact gets a fresh recipient and exactly one invite", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    await prisma.campaignSelection.deleteMany({ where: { campaignId, opportunityId: { not: target.id } } });
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await resumeLaunch(campaignId, "test");
    expect(await prisma.checkInRecipient.count({ where: { campaignId, contactId: target.contactId! } })).toBe(0);
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: true } });
    await resumeLaunch(campaignId, "test");
    expect(await prisma.checkInRecipient.count({ where: { campaignId, contactId: target.contactId! } })).toBe(1);
    const toTarget = async () => (await invites(campaignId)).filter((e) => e.toName === target.contact!.name);
    expect(await toTarget()).toHaveLength(1);
    await resumeLaunch(campaignId, "test");
    expect(await toTarget()).toHaveLength(1);
  });

  const status = async (campaignId: string) =>
    (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;

  it("resume closes a campaign whose recipients are all complete and every selection is reached", async () => {
    const { campaignId } = await halfSentCampaign();
    await resumeLaunch(campaignId, "test");
    expect(await status(campaignId)).toBe("IN_PROGRESS");
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { completedAt: new Date() } });
    await resumeLaunch(campaignId, "test");
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(after.status).toBe("COMPLETE");
    expect(after.completedAt).not.toBeNull();
  });

  it("resume keeps the campaign open while a persisted selection is still missing", async () => {
    const { campaignId, others } = await halfSentCampaign();
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { completedAt: new Date() } });
    await prisma.opportunity.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isOpen: false } });
    const result = await resumeLaunch(campaignId, "test");
    expect(result.unreachedAfter).toBeGreaterThan(0);
    expect(await status(campaignId)).toBe("IN_PROGRESS");
  });
});
