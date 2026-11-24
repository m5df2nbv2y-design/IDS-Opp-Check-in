import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getCampaignAnalytics, getCampaignResults } from "@/server/services/analytics-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/**
 * What check-ins achieved, across every sent campaign (Josh, 2026-11-24).
 *
 * Closed Won only happens when IDS receives an order, so it is never a
 * campaign result. These totals count only what contacts told us.
 */

type Answer = { updatedStatus?: string; updatedCloseDate?: Date; syncStatus?: string; submittedAt?: Date };

async function answer(itemId: string, data: Answer) {
  await prisma.checkInOpportunity.update({
    where: { id: itemId },
    data: { submittedAt: data.submittedAt ?? new Date(), ...data },
  });
}

describe("getCampaignResults", () => {
  beforeEach(resetDatabase);

  it("is all zeros before any campaign is sent", async () => {
    const results = await getCampaignResults();
    expect(results.campaignCount).toBe(0);
    expect(results.emailed.count).toBe(0);
    expect(results.responded.count).toBe(0);
  });

  it("sorts each answer into what it achieved", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens();
    const items = await prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId } },
      orderBy: { amount: "desc" },
    });
    expect(items.length).toBeGreaterThanOrEqual(6);
    const [forward, back, lost, dated, same, unanswered] = items;

    // Give each a known starting stage so "forward" and "back" are unambiguous.
    for (const item of items) {
      await prisma.checkInOpportunity.update({
        where: { id: item.id },
        data: { previousStatus: "PROPOSAL", previousCloseDate: new Date("2027-01-15T00:00:00Z") },
      });
    }

    await answer(forward.id, { updatedStatus: "NEGOTIATION", syncStatus: "SYNCED" });
    await answer(back.id, { updatedStatus: "QUALIFICATION", syncStatus: "WITHHELD" });
    await answer(lost.id, { updatedStatus: "CLOSED_LOST", syncStatus: "SYNCED" });
    await answer(dated.id, { updatedStatus: "PROPOSAL", updatedCloseDate: new Date("2027-03-01T00:00:00Z"), syncStatus: "SYNCED" });
    await answer(same.id, { updatedStatus: "PROPOSAL", updatedCloseDate: new Date("2027-01-15T00:00:00Z"), syncStatus: "SKIPPED" });

    const results = await getCampaignResults();
    const sum = (...rows: { amount: number }[]) => rows.reduce((t, r) => t + r.amount, 0);

    expect(results.campaignCount).toBe(1);
    expect(results.emailed).toEqual({ count: items.length, value: sum(...items) });
    expect(results.responded).toEqual({ count: 5, value: sum(forward, back, lost, dated, same) });
    expect(results.movedForward).toEqual({ count: 1, value: forward.amount });
    expect(results.movedBack).toEqual({ count: 1, value: back.amount });
    expect(results.closedOut).toEqual({ count: 1, value: lost.amount });
    expect(results.closeDateUpdated).toEqual({ count: 1, value: dated.amount });
    expect(results.confirmedNoChange).toEqual({ count: 1, value: same.amount });
    expect(results.writtenToSalesforce).toBe(3);
    expect(unanswered.submittedAt).toBeNull();
  });

  it("counts an opportunity once, by its latest answer, when two campaigns reached it", async () => {
    const first = await launchCampaignAndCollectTokens("First");
    const item = await prisma.checkInOpportunity.findFirstOrThrow({ where: { recipient: { campaignId: first.campaignId } } });
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { previousStatus: "PROPOSAL" } });
    await answer(item.id, { updatedStatus: "NEGOTIATION", submittedAt: new Date("2026-12-01T00:00:00Z") });

    // A later campaign reaching the same opportunity, answered "still the same".
    const second = await prisma.campaign.create({ data: { name: "Second", period: "Test", status: "COMPLETE" } });
    const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { id: item.recipientId } });
    const again = await prisma.checkInRecipient.create({
      data: { campaignId: second.id, contactId: recipient.contactId, tokenHash: "second-campaign-hash", tokenHint: "test", expiresAt: new Date("2027-12-31T00:00:00Z"), sentAt: new Date(), sendStatus: "SENT" },
    });
    await prisma.checkInOpportunity.create({
      data: {
        opportunityId: item.opportunityId, customerName: item.customerName, opportunityName: item.opportunityName,
        amount: item.amount, salesforceUrl: item.salesforceUrl, accountName: item.accountName,
        internalRepName: item.internalRepName, recipientId: again.id, previousStatus: "NEGOTIATION", updatedStatus: "NEGOTIATION", submittedAt: new Date("2027-01-10T00:00:00Z") },
    });

    const results = await getCampaignResults();
    expect(results.campaignCount).toBe(2);
    expect(results.responded.count).toBe(1);
    expect(results.movedForward.count).toBe(0);
    expect(results.confirmedNoChange.count).toBe(1);
  });

  it("leaves out drafts and invitations that were never sent", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens();
    const before = await getCampaignResults();
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { sentAt: null } });
    const after = await getCampaignResults();
    expect(before.emailed.count).toBeGreaterThan(0);
    expect(after.emailed.count).toBe(0);
  });
});

describe("the latest-campaign figures keep Closed Lost apart (Josh, 2026-11-24)", () => {
  beforeEach(resetDatabase);

  it("does not count a closed-out project as a stage movement or as confirmed", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens();
    const [moved, lost, same] = await prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId } },
      orderBy: { amount: "desc" },
    });
    for (const item of [moved, lost, same]) {
      await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { previousStatus: "PROPOSAL" } });
    }
    await answer(moved.id, { updatedStatus: "NEGOTIATION" });
    await answer(lost.id, { updatedStatus: "CLOSED_LOST" });
    await answer(same.id, { updatedStatus: "PROPOSAL" });

    const analytics = (await getCampaignAnalytics(campaignId))!;
    expect(analytics.stageMovedCount).toBe(1);
    expect(analytics.stageMovedValue).toBe(moved.amount);
    expect(analytics.closedOutCount).toBe(1);
    expect(analytics.closedOutValue).toBe(lost.amount);
    expect(analytics.confirmedNoChangeCount).toBe(1);
    expect(analytics.confirmedNoChangeValue).toBe(same.amount);
  });
});
