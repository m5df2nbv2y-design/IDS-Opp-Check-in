import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { launchCampaign, resumeLaunch } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import * as snapshots from "@/server/services/snapshot-service";
import { resetDatabase } from "./fixtures";
beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());
async function selected() {
  await refreshCatalogFromSalesforce("test");
  return prisma.opportunity.findMany({ where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } } });
}
it("a crash during item snapshots rolls back the recipient and can safely resume", async () => {
  const opportunities = await selected();
  vi.spyOn(snapshots, "recordSnapshot").mockRejectedValueOnce(new Error("interrupted provisioning"));
  await expect(launchCampaign({ opportunityIds: opportunities.map(o => o.id) })).rejects.toThrow("interrupted provisioning");
  const campaign = await prisma.campaign.findFirstOrThrow();
  expect(await prisma.checkInRecipient.count()).toBe(0);
  expect(await prisma.checkInOpportunity.count()).toBe(0);
  vi.restoreAllMocks();
  const result = await resumeLaunch(campaign.id);
  expect(result.unreachedAfter).toBe(0);
  expect(result.emailsSent).toBe(new Set(opportunities.map(o => o.contactId)).size);
});
it("overlapping launch and recovery cannot observe a partial recipient or send twice", async () => {
  const opportunities = await selected();
  const original = snapshots.recordSnapshot;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(snapshots, "recordSnapshot").mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args); });
  const launching = launchCampaign({ opportunityIds: opportunities.map(o => o.id) });
  await ready;
  const campaign = await prisma.campaign.findFirstOrThrow();
  expect(await prisma.checkInRecipient.count()).toBe(0);
  const recovering = resumeLaunch(campaign.id);
  release();
  await Promise.all([launching, recovering]);
  const rows = await prisma.checkInRecipient.findMany({ include: { items: true } });
  expect(rows).toHaveLength(new Set(opportunities.map(o => o.contactId)).size);
  expect(await prisma.emailMessage.count({ where: { kind: "INVITE" } })).toBe(rows.length);
  for (const row of rows) expect(new Set(row.items.map(i => i.opportunityId))).toEqual(new Set(opportunities.filter(o => o.contactId === row.contactId).map(o => o.id)));
});
