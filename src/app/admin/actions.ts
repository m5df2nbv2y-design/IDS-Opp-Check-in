"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { sendReminders } from "@/server/services/campaign-service";
import {
  clearSelections,
  getOrCreateDraft,
  sendDraft,
  setSelection,
} from "@/server/services/campaign-draft-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import {
  markSignalReviewed,
  refreshSmartsheetSignals,
  saveSignalDraftResponse,
} from "@/server/services/smartsheet-signal-service";
import { retryFailedSyncs } from "@/server/services/sync-service";

/**
 * Admin actions. Each is a thin wrapper — the workflow lives in
 * src/server/services so a scheduler or job runner can reuse it later.
 *
 * NOTE: when Entra ID SSO is added (see ../admin/layout.tsx), every export here
 * needs its own session assertion. A layout guard does not protect a POST.
 */

/**
 * Pull the latest picture from Salesforce and re-resolve recipients. Discovery
 * only — this never sends anything and never selects anything. Opportunities
 * become sendable only when an admin explicitly selects them.
 */
export async function refreshDiscoveryAction() {
  await refreshCatalogFromSalesforce("admin");
  revalidatePath("/admin");
}

/** Select or deselect specific opportunities in the draft. */
export async function setSelectionAction(opportunityIds: string[], selected: boolean) {
  const draft = await getOrCreateDraft("admin");
  await setSelection({ campaignId: draft.id, opportunityIds, selected, actor: "admin" });
  revalidatePath("/admin");
  revalidatePath("/admin/campaigns/review");
}

/**
 * Send to the selected recipients. Re-resolves every selection server-side
 * first — the client's selection is never trusted on its own — and excludes
 * anything that drifted. With EMAIL_PROVIDER=mock nothing leaves the building.
 * No Salesforce record is written here.
 */
export async function sendDraftAction() {
  const draft = await getOrCreateDraft("admin");
  const result = await sendDraft(draft.id, "admin");
  revalidatePath("/admin");
  revalidatePath("/admin/outbox");
  if (result.sent > 0) redirect(`/admin/campaigns/${result.campaignId}`);
}

export async function clearSelectionsAction() {
  const draft = await getOrCreateDraft("admin");
  await clearSelections(draft.id);
  revalidatePath("/admin");
  revalidatePath("/admin/campaigns/review");
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

/**
 * Pull the latest Smartsheet signals and re-run matching against the cached
 * opportunity catalog. Read-only against Smartsheet; writes only to our own
 * OpportunitySignal cache — never to Salesforce or back to Smartsheet.
 */
export async function refreshSmartsheetSignalsAction() {
  await refreshSmartsheetSignals("admin");
  revalidatePath("/admin");
}

export async function markSignalReviewedAction(signalId: string) {
  await markSignalReviewed(signalId, "admin");
  revalidatePath("/admin");
}

/** Saves a draft reply locally. Nothing is sent anywhere. */
export async function saveSignalDraftResponseAction(signalId: string, formData: FormData) {
  const draft = String(formData.get("draftResponse") ?? "");
  await saveSignalDraftResponse(signalId, draft, "admin");
  revalidatePath("/admin");
}
