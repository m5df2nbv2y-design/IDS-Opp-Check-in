"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { launchCampaign, sendReminders } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { retryFailedSyncs } from "@/server/services/sync-service";

/**
 * Admin actions. Each is a thin wrapper — the workflow lives in
 * src/server/services so a scheduler or job runner can reuse it later.
 *
 * NOTE: when Entra ID SSO is added (see ../admin/layout.tsx), every export here
 * needs its own session assertion. A layout guard does not protect a POST.
 */

/**
 * Step one of "SEND CHECK-IN TO ALL": pull the latest picture from Salesforce
 * and resolve recipients, then show the confirmation screen. Nothing is sent.
 */
export async function prepareCampaignAction() {
  await refreshCatalogFromSalesforce("admin");
  revalidatePath("/admin");
  redirect("/admin/campaigns/new");
}

/** Step two: create the campaign, generate tokens, and send the emails. */
export async function launchCampaignAction() {
  const result = await launchCampaign({ actor: "admin" });
  revalidatePath("/admin");
  redirect(`/admin/campaigns/${result.campaignId}`);
}

export async function sendRemindersAction(campaignId: string) {
  await sendReminders(campaignId, "admin");
  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin/outbox");
}

export async function retrySyncAction(campaignId: string) {
  await retryFailedSyncs(campaignId, "admin");
  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin");
}

export async function refreshCatalogAction() {
  await refreshCatalogFromSalesforce("admin");
  revalidatePath("/admin/organizations");
  revalidatePath("/admin");
}

/**
 * Demo affordance: clears the simulated validation rule on a mock Salesforce
 * record so a failed sync can be retried successfully. Mock provider only.
 */
export async function clearMockValidationBlockAction(externalId: string) {
  await prisma.mockSalesforceOpportunity.update({
    where: { externalId },
    data: { syncBlocked: false },
  });
  revalidatePath("/admin/salesforce");
}
