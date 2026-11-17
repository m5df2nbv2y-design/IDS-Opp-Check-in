import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { getCampaignSummary, getRecoverableOpportunityIds, getUnreachedOpportunityIds } from "@/server/services/campaign-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

describe("campaign page queries (PR #13 finding 9)", () => {
  it("computes unreached selections once and still reports the same recoverable work", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens();
    // Make real shortfall: one contact never provisioned, so its selections are unreached and recoverable.
    const dropped = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });
    await prisma.checkInRecipient.delete({ where: { id: dropped.id } });
    const unreached = await getUnreachedOpportunityIds(campaignId);
    const recoverable = await getRecoverableOpportunityIds(campaignId);
    expect(unreached.length).toBeGreaterThan(0);
    expect(recoverable.length).toBeGreaterThan(0);
    expect(await getRecoverableOpportunityIds(campaignId, unreached)).toEqual(recoverable);

    // The reached-items scan belongs to getUnreachedOpportunityIds; it now runs once per page.
    const reachedScans = vi.spyOn(prisma.checkInOpportunity, "findMany");
    const summary = await getCampaignSummary(campaignId);
    expect(reachedScans).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ unreachedCount: unreached.length, recoverableCount: recoverable.length });
  });
});
