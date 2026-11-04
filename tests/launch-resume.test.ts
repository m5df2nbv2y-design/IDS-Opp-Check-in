import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
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

  it("a drifted-then-sendable selection is sent by resume", async () => {
    const { campaignId, others } = await halfSentCampaign();
    // A contact with one opportunity, so excluding it leaves that contact with no recipient.
    const target = others.find((o) => others.filter((x) => x.contactId === o.contactId).length === 1)!;
    expect(target).toBeDefined();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    expect((await resumeLaunch(campaignId, "test")).opportunities).toBe(others.length - 1);
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: true } });
    await resumeLaunch(campaignId, "test");
    expect(
      await prisma.checkInOpportunity.count({ where: { opportunityId: target.id, recipient: { campaignId } } }),
    ).toBe(1);
  });
});
