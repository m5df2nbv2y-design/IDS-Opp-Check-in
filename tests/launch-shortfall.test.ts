import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  getCampaignSummary,
  getUnreachedOpportunityIds,
  launchCampaign,
} from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import {
  completeCheckIn,
  resolveCheckInToken,
  saveResponse,
} from "@/server/services/response-service";
import { resetDatabase } from "./fixtures";

const CONTACT = "Jane Doe";

/** Launches for one contact's opportunities only, so there is a single recipient. */
async function launchForOneContact() {
  await refreshCatalogFromSalesforce("test");
  const mine = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contact: { name: CONTACT } },
    select: { id: true },
  });
  const others = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null }, contact: { name: { not: CONTACT } } },
    select: { id: true },
  });
  expect(mine.length).toBeGreaterThan(0);
  expect(others.length).toBeGreaterThan(0);
  const result = await launchCampaign({
    opportunityIds: mine.map((o) => o.id),
    name: "Shortfall",
    period: "Test",
    actor: "test",
  });
  const email = await prisma.emailMessage.findFirstOrThrow({
    where: { campaignId: result.campaignId, kind: "INVITE" },
  });
  const token = email.linkUrl!.split("/checkin/")[1];
  return { campaignId: result.campaignId, token, others: others.map((o) => o.id) };
}

async function selectUnsent(campaignId: string, opportunityId: string) {
  await prisma.campaignSelection.create({ data: { campaignId, opportunityId } });
}

async function answerAndComplete(token: string) {
  const resolved = await resolveCheckInToken(token);
  if (!resolved.ok) throw new Error("token did not resolve");
  for (const item of resolved.session.items) {
    await saveResponse({ token, itemId: item.id, stage: "PROPOSAL", comment: null, closeDate: null, lossReason: null });
  }
  return completeCheckIn(token);
}

describe("launch shortfall", () => {
  beforeEach(resetDatabase);

  it("reports a selection with no check-in item as unreached", async () => {
    const { campaignId, others } = await launchForOneContact();
    expect(await getUnreachedOpportunityIds(campaignId)).toEqual([]);
    await selectUnsent(campaignId, others[0]);
    expect(await getUnreachedOpportunityIds(campaignId)).toEqual([others[0]]);
    expect((await getCampaignSummary(campaignId))!.unreachedCount).toBe(1);
  });

  it("a campaign with a shortfall stays IN_PROGRESS when its only recipient completes", async () => {
    const { campaignId, token, others } = await launchForOneContact();
    await selectUnsent(campaignId, others[0]);
    const before = (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;
    expect(await answerAndComplete(token)).toMatchObject({ ok: true });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe(before);
    expect(campaign.status).not.toBe("COMPLETE");
    expect(campaign.completedAt).toBeNull();
  });

  it("a fully reached campaign still completes", async () => {
    const { campaignId, token } = await launchForOneContact();
    expect(await answerAndComplete(token)).toMatchObject({ ok: true });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("COMPLETE");
  });

  it("an ineligible selection stays visible and blocks closure", async () => {
    const { campaignId, token, others } = await launchForOneContact();
    await selectUnsent(campaignId, others[0]);
    await prisma.opportunity.update({ where: { id: others[0] }, data: { isOpen: false } });
    expect(await getUnreachedOpportunityIds(campaignId)).toEqual([others[0]]);
    await answerAndComplete(token);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("IN_PROGRESS");
  });

  it("a revoked recipient's items count as reached", async () => {
    const { campaignId } = await launchForOneContact();
    const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });
    await prisma.checkInRecipient.update({ where: { id: recipient.id }, data: { revokedAt: new Date() } });
    expect(await getUnreachedOpportunityIds(campaignId)).toEqual([]);
  });
});
