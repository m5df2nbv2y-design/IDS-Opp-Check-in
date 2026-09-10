import { prisma } from "@/lib/db";
import { MockSalesforceService } from "@/server/integrations/salesforce/mock/mock-salesforce-service";
import { launchCampaign } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";

/** Empties every workflow table and reloads the mock Salesforce org. */
export async function resetDatabase() {
  await prisma.campaignSelection.deleteMany();
  await prisma.opportunitySignal.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.emailMessage.deleteMany();
  await prisma.checkInOpportunity.deleteMany();
  await prisma.checkInRecipient.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.externalContact.deleteMany();
  await prisma.account.deleteMany();
  await prisma.salesRep.deleteMany();
  await new MockSalesforceService().resetOrg();
}

/**
 * Runs a real campaign and recovers each contact's raw token from the email
 * that was "sent" — the only place a raw token exists, which is exactly the
 * property the security tests assert.
 */
export async function launchCampaignAndCollectTokens(name = "Test Campaign") {
  await refreshCatalogFromSalesforce("test");
  const result = await launchCampaign({ name, period: "Test", actor: "test" });

  const emails = await prisma.emailMessage.findMany({
    where: { campaignId: result.campaignId, kind: "INVITE" },
  });

  const tokens = new Map<string, string>();
  for (const email of emails) {
    const token = email.linkUrl?.split("/checkin/")[1];
    if (token) tokens.set(email.toName, token);
  }

  return { campaignId: result.campaignId, tokens, emails, result };
}

export async function itemsForContact(campaignId: string, contactName: string) {
  return prisma.checkInOpportunity.findMany({
    where: { recipient: { campaignId, contact: { name: contactName } } },
    orderBy: { position: "asc" },
  });
}
