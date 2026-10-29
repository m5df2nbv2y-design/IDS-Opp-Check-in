import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getSalesforceService, SalesforceSyncError } from "@/server/integrations/salesforce";
import { resetDatabase, launchCampaignAndCollectTokens } from "./fixtures";
import { saveResponse, completeCheckIn } from "@/server/services/response-service";
import { syncCampaignResponses } from "@/server/services/sync-service";
const service = getSalesforceService();
const originalInfo = service.info;
const originalSwitch = env.salesforce.writeEnabled;
beforeEach(async () => { await resetDatabase(); });
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(service, "info", { value: originalInfo }); Object.defineProperty(env.salesforce, "writeEnabled", { value: originalSwitch }); });
async function submitted(finish = true) {
  await launchCampaignAndCollectTokens();
  const email = await prisma.emailMessage.findFirstOrThrow({ where: { kind: "INVITE" } });
  const token = email.linkUrl!.split("/checkin/")[1];
  const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId: email.campaignId!, contactId: email.contactId! }, include: { items: true } });
  for (const item of recipient.items) await saveResponse({ token, itemId: item.id, stage: item.previousStatus, closeDate: "2027-12-31" });
  Object.defineProperty(service, "info", { value: { ...originalInfo, simulated: false }, configurable: true });
  Object.defineProperty(env.salesforce, "writeEnabled", { value: true, configurable: true });
  if (finish) await completeCheckIn(token);
  return { token, item: await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: recipient.items[0].id } }), campaignId: recipient.campaignId };
}
it("withholds even with switch on, then applies an approved date-only update once", async () => {
  const patch = vi.spyOn(service, "applyUpdate").mockResolvedValue();
  const { item, campaignId } = await submitted();
  expect(patch).not.toHaveBeenCalled(); expect(item.syncStatus).toBe("WITHHELD");
  const approval = { itemId: item.id, revision: item.updatedAt.toISOString() };
  await Promise.all([syncCampaignResponses({ campaignId, itemIds: [item.id] }, "admin", approval), syncCampaignResponses({ campaignId, itemIds: [item.id] }, "admin", approval)]);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(patch.mock.calls[0][0].closeDate).toBe("2027-12-31");
  expect(await prisma.auditEvent.count({ where: { type: "WRITEBACK_APPROVED" } })).toBe(1);
});
it("does not write a stale approval or a record changed in Salesforce", async () => {
  const patch = vi.spyOn(service, "applyUpdate").mockResolvedValue();
  const { item, campaignId } = await submitted();
  await syncCampaignResponses({ campaignId, itemIds: [item.id] }, "admin", { itemId: item.id, revision: "old" });
  expect(patch).not.toHaveBeenCalled();
  vi.spyOn(service, "getOpportunity").mockResolvedValue(null);
  const current = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: item.id } });
  await syncCampaignResponses({ campaignId, itemIds: [item.id] }, "admin", { itemId: item.id, revision: current.updatedAt.toISOString() });
  expect(patch).not.toHaveBeenCalled();
  expect((await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: item.id } })).syncStatus).toBe("FAILED");
});
it("keeps an uncertain Salesforce write out of all retries", async () => {
  const patch = vi.spyOn(service, "applyUpdate").mockRejectedValue(new SalesforceSyncError("timeout", { code: "NETWORK" }));
  const { item, campaignId } = await submitted();
  await syncCampaignResponses({ campaignId, itemIds: [item.id] }, "admin", { itemId: item.id, revision: item.updatedAt.toISOString() });
  expect((await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: item.id } })).syncStatus).toBe("UNCERTAIN");
  await syncCampaignResponses({ campaignId }, "admin"); expect(patch).toHaveBeenCalledTimes(1);
});
it("completes only once under concurrent requests and rejects later saves", async () => {
  const { token, item } = await submitted(false);
  await Promise.all([completeCheckIn(token), completeCheckIn(token)]);
  const recipient = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: item.recipientId } });
  expect(await prisma.auditEvent.count({ where: { type: "CHECKIN_COMPLETED", contactId: recipient.contactId } })).toBe(1);
  expect(await saveResponse({ token, itemId: item.id, stage: "PROPOSAL" })).toEqual({ ok: false, reason: "ALREADY_COMPLETED" });
});
