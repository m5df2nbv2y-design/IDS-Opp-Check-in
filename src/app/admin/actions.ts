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
import { sendDemoTestEmail, type TestEmailResult } from "@/server/services/test-email-service";
import { requireAdminActor } from "@/server/auth/require-admin";

/**
 * Admin actions. Each is a thin wrapper — the workflow lives in
 * src/server/services so a scheduler or job runner can reuse it later.
 *
 * EVERY export here begins with `await requireAdminActor()`. Server actions are
 * individually addressable HTTP endpoints: the /admin layout guard renders
 * pages, it does not protect a POST. An unauthenticated request to any of these
 * throws UnauthorizedError before touching data.
 *
 * requireAdminActor() also returns the signed-in identity, so the audit trail
 * attributes each change to a real person rather than a generic "admin".
 */

/**
 * Pull the latest picture from Salesforce and re-resolve recipients. Discovery
 * only — this never sends anything and never selects anything. Opportunities
 * become sendable only when an admin explicitly selects them.
 */
export async function refreshDiscoveryAction() {
  const actor = await requireAdminActor();
  await refreshCatalogFromSalesforce(actor);
  revalidatePath("/admin");
}

/** Select or deselect specific opportunities in the draft. */
export async function setSelectionAction(opportunityIds: string[], selected: boolean) {
  const actor = await requireAdminActor();
  const draft = await getOrCreateDraft(actor);
  await setSelection({ campaignId: draft.id, opportunityIds, selected, actor });
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
  const actor = await requireAdminActor();
  const draft = await getOrCreateDraft(actor);
  const result = await sendDraft(draft.id, actor);
  revalidatePath("/admin");
  revalidatePath("/admin/outbox");
  if (result.sent > 0) redirect(`/admin/campaigns/${result.campaignId}`);
}

export async function clearSelectionsAction() {
  const actor = await requireAdminActor();
  const draft = await getOrCreateDraft(actor);
  await clearSelections(draft.id);
  revalidatePath("/admin");
  revalidatePath("/admin/campaigns/review");
}

export async function sendRemindersAction(campaignId: string) {
  const actor = await requireAdminActor();
  await sendReminders(campaignId, actor);
  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin/outbox");
}

/**
 * Send ONE real demo email to the server-configured DEMO_TEST_EMAIL address.
 *
 * Takes a recipient RECORD ID, never an address: the destination is decided
 * entirely on the server, so no browser input can redirect this send. The
 * configured email provider is untouched and stays mock for every other path.
 */
export async function sendTestEmailAction(recipientId: string): Promise<TestEmailResult> {
  const actor = await requireAdminActor();
  const result = await sendDemoTestEmail(recipientId, actor);
  revalidatePath("/admin/outbox");
  revalidatePath("/admin/audit");
  return result;
}

export async function retrySyncAction(campaignId: string) {
  const actor = await requireAdminActor();
  await retryFailedSyncs(campaignId, actor);
  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin");
}

export async function refreshCatalogAction() {
  const actor = await requireAdminActor();
  await refreshCatalogFromSalesforce(actor);
  revalidatePath("/admin/organizations");
  revalidatePath("/admin");
}

/**
 * Demo affordance: clears the simulated validation rule on a mock Salesforce
 * record so a failed sync can be retried successfully. Mock provider only.
 */
export async function clearMockValidationBlockAction(externalId: string) {
  await requireAdminActor();
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
  const actor = await requireAdminActor();
  await refreshSmartsheetSignals(actor);
  revalidatePath("/admin");
}

export async function markSignalReviewedAction(signalId: string) {
  const actor = await requireAdminActor();
  await markSignalReviewed(signalId, actor);
  revalidatePath("/admin");
}

/** Saves a draft reply locally. Nothing is sent anywhere. */
export async function saveSignalDraftResponseAction(signalId: string, formData: FormData) {
  const actor = await requireAdminActor();
  const draft = String(formData.get("draftResponse") ?? "");
  await saveSignalDraftResponse(signalId, draft, actor);
  revalidatePath("/admin");
}
