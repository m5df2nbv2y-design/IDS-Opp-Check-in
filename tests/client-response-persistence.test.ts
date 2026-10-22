import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { saveResponse, resolveCheckInToken } from "@/server/services/response-service";
import { itemsForContact, launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

describe("revised client response persistence", () => {
  let token: string;
  let itemId: string;
  beforeAll(async () => {
    await resetDatabase();
    const campaign = await launchCampaignAndCollectTokens("Response v2");
    token = campaign.tokens.get("Marcus Webb")!;
    const item = (await itemsForContact(campaign.campaignId, "Marcus Webb"))[0];
    itemId = item.id;
    await prisma.opportunity.update({ where: { id: item.opportunityId }, data: { salesforceCreatedAt: new Date("2026-03-18T12:00:00Z") } });
  });
  it("returns Salesforce creation date rather than local import timestamp", async () => {
    const resolved = await resolveCheckInToken(token);
    expect(resolved.ok && resolved.session.items[0].createdDate).toBe("2026-03-18");
  });
  it("requires a valid date for an open v2 answer", async () => {
    for (const closeDate of [null, "2026-02-30"]) {
      expect(await saveResponse({ token, itemId, stage: "PROPOSAL", flowVersion: 2, closeDate })).toEqual({ ok: false, reason: "INVALID_CLOSE_DATE" });
    }
  });
  it("rejects an invented loss reason without recording an answer", async () => {
    expect(await saveResponse({ token, itemId, stage: "CLOSED_LOST", flowVersion: 2, lossReason: "invented" })).toEqual({ ok: false, reason: "INVALID_LOSS_REASON" });
    expect((await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemId } })).submittedAt).toBeNull();
  });
  it("persists a selected reason and clears the open close date on Closed Lost", async () => {
    expect((await saveResponse({ token, itemId, stage: "SPECIFIED", flowVersion: 2, closeDate: "2027-05-01" })).ok).toBe(true);
    expect((await saveResponse({ token, itemId, stage: "CLOSED_LOST", flowVersion: 2, lossReason: "DEMO_CANCELLED" })).ok).toBe(true);
    const item = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.lossReason).toBe("DEMO_CANCELLED");
    expect(item.updatedCloseDate).toBeNull();
  });
  it("clears the loss reason when revised back to open", async () => {
    expect((await saveResponse({ token, itemId, stage: "NEGOTIATION", flowVersion: 2, closeDate: "2027-06-01" })).ok).toBe(true);
    const item = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.lossReason).toBeNull();
    expect(item.updatedStatus).toBe("NEGOTIATION");
    expect(item.updatedCloseDate?.toISOString()).toBe("2027-06-01T00:00:00.000Z");
  });
});
