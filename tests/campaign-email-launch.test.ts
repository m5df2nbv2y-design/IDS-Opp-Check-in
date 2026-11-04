import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { launchCampaign } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { getEmailService } from "@/server/integrations/email";
import { resetDatabase } from "./fixtures";

beforeEach(async () => { await resetDatabase(); await refreshCatalogFromSalesforce("test"); });
afterEach(() => vi.restoreAllMocks());
async function reviewedDraft() {
  const campaign = await prisma.campaign.create({ data: { name: "Example campaign", period: "Test", emailRevision: 7 } });
  const opportunity = await prisma.opportunity.findFirstOrThrow({ where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } }, include: { contact: true } });
  return { campaign, opportunity };
}
it("uses reviewed custom copy after claiming the same revision and freezing routing", async () => {
  const { campaign, opportunity } = await reviewedDraft();
  const send = vi.spyOn(getEmailService(), "send");
  await launchCampaign({ campaignId: campaign.id, opportunityIds: [opportunity.id], expectedEmailRevision: 7, emailCopy: { mode: "custom", subject: "Your project update", body: "Could you share an update?" } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: "Your project update", text: expect.stringContaining("Could you share an update?"), to: { name: opportunity.contact!.name, email: opportunity.contact!.email }, linkUrl: expect.stringContaining("https://checkin.test/checkin/") }));
  expect(await prisma.checkInRecipient.count({ where: { campaignId: campaign.id } })).toBe(1);
  expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("IN_PROGRESS");
  expect(await prisma.auditEvent.count({ where: { campaignId: campaign.id, type: "CAMPAIGN_ROUTING" } })).toBe(1);
});
it("a changed email revision or already-claimed draft cannot mint recipients or send", async () => {
  const { campaign, opportunity } = await reviewedDraft();
  const send = vi.spyOn(getEmailService(), "send");
  await prisma.campaign.update({ where: { id: campaign.id }, data: { emailRevision: 8 } });
  await expect(launchCampaign({ campaignId: campaign.id, opportunityIds: [opportunity.id], expectedEmailRevision: 7 })).rejects.toThrow("changed or was already sent");
  await prisma.campaign.update({ where: { id: campaign.id }, data: { status: "IN_PROGRESS" } });
  await expect(launchCampaign({ campaignId: campaign.id, opportunityIds: [opportunity.id], expectedEmailRevision: 8 })).rejects.toThrow("changed or was already sent");
  expect(await prisma.checkInRecipient.count()).toBe(0);
  expect(send).not.toHaveBeenCalled();
});
it("invalid custom headers fail before campaign mutation or recipient creation", async () => {
  const { campaign, opportunity } = await reviewedDraft();
  const send = vi.spyOn(getEmailService(), "send");
  await expect(launchCampaign({ campaignId: campaign.id, opportunityIds: [opportunity.id], expectedEmailRevision: 7, emailCopy: { mode: "custom", subject: "Injected\r\nBcc: forged@example.invalid", body: "Hello" } })).rejects.toThrow("single line");
  expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("DRAFT");
  expect(await prisma.checkInRecipient.count()).toBe(0);
  expect(send).not.toHaveBeenCalled();
});
