import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { launchCampaign, resumeLaunch } from "@/server/services/campaign-service";
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

  it("a zero-item pending recipient is removed and re-provisioned", async () => {
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
    expect(rows[0].id).not.toBe(orphan.id);
    expect(rows[0].items.length).toBeGreaterThan(0);
    expect(rows[0].sendStatus).toBe("SENT");
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

  it("a drifted-then-sendable selection is sent by resume, with no second email to a contact who has a recipient", async () => {
    const { campaignId, mine } = await halfSentCampaign();
    expect(mine.length).toBeGreaterThan(1);
    const gap = mine[1];
    await prisma.checkInOpportunity.deleteMany({ where: { opportunityId: gap.id, recipient: { campaignId } } });
    await prisma.opportunity.update({ where: { id: gap.id }, data: { isOpen: false } });
    expect((await resumeLaunch(campaignId, "test")).unreachedAfter).toBeGreaterThanOrEqual(0);
    const reached = () =>
      prisma.checkInOpportunity.count({ where: { opportunityId: gap.id, recipient: { campaignId } } });
    expect(await reached()).toBe(0);
    await prisma.opportunity.update({ where: { id: gap.id }, data: { isOpen: true } });
    const before = (await invites(campaignId)).length;
    await resumeLaunch(campaignId, "test");
    expect(await reached()).toBe(1);
    expect((await invites(campaignId)).length).toBe(before);
    const items = await prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId, contact: { name: FIRST } } },
      orderBy: { position: "asc" },
    });
    expect(new Set(items.map((i) => i.position)).size).toBe(items.length);
    const added = items.find((i) => i.opportunityId === gap.id)!;
    expect(added.position).toBe(Math.max(...items.map((i) => i.position)));
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

  it("a rival resume that creates a contact just before ours is skipped without a second email", async () => {
    const { campaignId, otherContacts } = await halfSentCampaign();
    const original = prisma.checkInRecipient.create.bind(prisma.checkInRecipient);
    let rivalRan = false;
    vi.spyOn(prisma.checkInRecipient, "create").mockImplementation((async (args: Parameters<typeof original>[0]) => {
      if (!rivalRan) {
        rivalRan = true;
        await resumeLaunch(campaignId, "rival"); // runs to completion before our first create lands
      }
      return original(args);
    }) as unknown as typeof prisma.checkInRecipient.create);
    const result = await resumeLaunch(campaignId, "ours");
    expect(rivalRan).toBe(true);
    expect(result.emailsSent).toBe(0);
    expect((await invites(campaignId)).length).toBe(otherContacts.size + 1);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(otherContacts.size + 1);
  });

  it("items a rival added to the same recipient between our read and our write are tolerated", async () => {
    const { campaignId, mine } = await halfSentCampaign();
    const gap = mine[1];
    const gone = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { opportunityId: gap.id, recipient: { campaignId } },
    });
    await prisma.checkInOpportunity.delete({ where: { id: gone.id } });
    const { id: _id, ...row } = gone;
    const original = prisma.checkInOpportunity.createMany.bind(prisma.checkInOpportunity);
    let rivalRan = false;
    vi.spyOn(prisma.checkInOpportunity, "createMany").mockImplementation((async (args: unknown) => {
      const forGap = (args as { data: { recipientId: string }[] }).data.some((d) => d.recipientId === row.recipientId);
      if (!rivalRan && forGap) {
        rivalRan = true;
        await prisma.checkInOpportunity.create({ data: row });
      }
      return original(args as never);
    }) as unknown as typeof prisma.checkInOpportunity.createMany);
    await expect(resumeLaunch(campaignId, "ours")).resolves.toBeDefined();
    expect(rivalRan).toBe(true);
    expect(
      await prisma.checkInOpportunity.count({ where: { opportunityId: gap.id, recipient: { campaignId } } }),
    ).toBe(1);
  });

  it("a unique violation on another target is rethrown, not swallowed", async () => {
    const { campaignId } = await halfSentCampaign();
    vi.spyOn(prisma.checkInRecipient, "create").mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002", meta: { target: ["tokenHash"] } }),
    );
    await expect(resumeLaunch(campaignId, "test")).rejects.toThrow("dup");
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
});
