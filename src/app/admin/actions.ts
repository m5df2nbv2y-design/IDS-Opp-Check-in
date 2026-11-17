"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { approveLegacyRouting, CampaignChangedError, excludeShortfallOpportunity, resumeLaunch, sendReminders, type ShortfallReason } from "@/server/services/campaign-service";
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
import { syncCampaignResponses, retryFailedSyncs } from "@/server/services/sync-service";
import { sendDemoTestEmail, type TestEmailResult } from "@/server/services/test-email-service";
import { requireAdminActor } from "@/server/auth/require-admin";
import { saveCampaignEmail } from "@/server/services/campaign-email-service";
import { DraftEmailConflictError, requireEmailRevision } from "@/lib/check-in-copy";
import {
  reconcileUncertainWrite,
  reconcileUnknownInvitation,
  type InvitationObservedOutcome,
  type InvitationReconcileResult,
  type ObservedOutcome,
} from "@/server/services/reconcile-service";

export async function saveCampaignEmailAction(campaignId: string, revision: number, input: unknown) {
  const actor = await requireAdminActor();
  const saved = await saveCampaignEmail(campaignId, revision, input, actor);
  revalidatePath("/admin/outbox");
  revalidatePath("/admin/campaigns/review");
  return saved;
}

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
export async function sendDraftAction(campaignId: string, emailRevision: number) {
  const actor = await requireAdminActor();
  const revision = requireEmailRevision(emailRevision);
  const draft = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!draft || draft.status !== "DRAFT") return { error: "This draft changed. Reload before sending." };
  let result;
  try { result = await sendDraft(draft.id, actor, revision); }
  catch (e) {
    if (e instanceof DraftEmailConflictError || e instanceof CampaignChangedError) return { error: e.message };
    throw e;
  }
  revalidatePath("/admin");
  revalidatePath("/admin/outbox");
  if (result.sent > 0) redirect(`/admin/campaigns/${result.campaignId}/receipt`);
  return { error: "No selected opportunities can be sent. Return to selection and review the current recipients." };
}

export async function clearSelectionsAction() {
  const actor = await requireAdminActor();
  const draft = await getOrCreateDraft(actor);
  await clearSelections(draft.id);
  revalidatePath("/admin");
  revalidatePath("/admin/campaigns/review");
}

type ActionRefusal = { error: string };

/** Resume unsent invitations. A campaign that changed since the page loaded is a returned refusal, not the error page. */
export async function resumeLaunchAction(campaignId: string): Promise<void | ActionRefusal> {
  const actor = await requireAdminActor();
  try {
    await resumeLaunch(campaignId, actor);
  } catch (error) {
    if (!(error instanceof CampaignChangedError)) throw error;
    return { error: error.message };
  } finally {
    // Refresh either way: some invitations may have gone out before a refusal.
    revalidatePath(`/admin/campaigns/${campaignId}`);
    revalidatePath("/admin/outbox");
  }
}

/** Approve the routing shown for a campaign launched before routing records. Refusals are returned, not thrown. */
export async function approveLegacyRoutingAction(campaignId: string, shownRoutes: Record<string, string | null>): Promise<void | ActionRefusal> {
  const actor = await requireAdminActor();
  const result = await approveLegacyRouting(campaignId, shownRoutes, actor);
  // Revalidate on refusal too, so a stale preview and button leave the screen.
  revalidatePath(`/admin/campaigns/${campaignId}`);
  if (!result.ok) return { error: result.message };
}

/** Exclude one shortfall opportunity that cannot resume, with the reason shown. Refusals are returned, not thrown. */
export async function excludeShortfallAction(campaignId: string, opportunityId: string, shownReason: ShortfallReason): Promise<void | ActionRefusal> {
  const actor = await requireAdminActor();
  const result = await excludeShortfallOpportunity(campaignId, opportunityId, shownReason, actor);
  // Revalidate on refusal too, so a stale row and button leave the screen.
  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin");
  if (!result.ok) return { error: result.message };
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

/**
 * What the reconcile control is told. A refusal here is an expected outcome
 * (two administrators racing, a stale page), so it is returned rather than
 * thrown — a throw would replace the page with the generic error screen.
 * `message` is always one of the fixed strings below, never thrown or stored text.
 */
export type ReconcileActionResult =
  | { ok: true }
  | {
      ok: false;
      reason: "STALE" | "NOT_UNCERTAIN" | "NOT_FOUND" | "NOT_UNRESOLVED" | "STILL_SENDING" | "OPENED";
      message: string;
    };

const RECONCILE_REFUSALS = {
  STALE:
    "This response changed since the page was loaded. Reload, re-check Salesforce, and resolve it again.",
  NOT_UNCERTAIN:
    "This response is no longer awaiting reconciliation — someone may have resolved it already.",
  NOT_FOUND: "This response is no longer part of the campaign.",
} as const;

/**
 * Resolve a Salesforce write whose outcome we never learned.
 *
 * The administrator has looked in Salesforce and is telling us what they saw.
 * This is the only exit from UNCERTAIN, and it is per item on purpose — the
 * commissioning note forbids clearing these with a blanket retry, because each
 * is a separate question about a separate record.
 *
 * `revision` binds the `updatedAt` that was on screen, so a stale page cannot
 * resolve an item that has moved underneath it.
 */
export async function reconcileUncertainAction(
  campaignId: string,
  itemId: string,
  revision: string,
  observed: ObservedOutcome,
): Promise<ReconcileActionResult> {
  const actor = await requireAdminActor();
  const result = await reconcileUncertainWrite({
    campaignId,
    itemId,
    revision,
    observed,
    actor,
  });

  // Nothing was written, so there is nothing to revalidate. Authorization and
  // validation failures are not refusals: they still throw, above.
  if (!result.ok) {
    return { ok: false, reason: result.reason, message: RECONCILE_REFUSALS[result.reason] };
  }

  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin");
  return { ok: true };
}

type InvitationRefusal = Extract<InvitationReconcileResult, { ok: false }>["reason"];

/** Fixed refusal strings for the invitation reconcile control; never thrown or stored text. */
const INVITATION_RECONCILE_REFUSALS: Record<InvitationRefusal, string> = {
  STALE: "This invitation changed since the page was loaded. Reload and check again.",
  NOT_UNRESOLVED:
    "This invitation is no longer unresolved — someone may have recorded its outcome already.",
  STILL_SENDING: "This invitation may still be sending. Wait a few minutes and reload.",
  NOT_FOUND: "This invitation is no longer part of the campaign.",
  OPENED: "The recipient has opened this invitation, so it was delivered. Record it as sent.",
};

/**
 * Record what an administrator found in the sending mailbox for an invitation
 * whose send outcome is unknown. Per recipient, bound to the `sendStatus` and
 * `tokenHint` that were on screen. Sends nothing.
 */
export async function reconcileInvitationAction(
  campaignId: string,
  recipientId: string,
  shownStatus: string,
  shownTokenHint: string,
  observed: InvitationObservedOutcome,
): Promise<ReconcileActionResult> {
  const actor = await requireAdminActor();
  const result = await reconcileUnknownInvitation({
    campaignId,
    recipientId,
    shownStatus,
    shownTokenHint,
    observed,
    actor,
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason, message: INVITATION_RECONCILE_REFUSALS[result.reason] };
  }

  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin");
  return { ok: true };
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

/** Approve exactly the response revision displayed on the review page. */
export async function approveWritebackAction(campaignId: string, itemId: string, revision: string) {
  const actor = await requireAdminActor();
  await syncCampaignResponses({ campaignId, itemIds: [itemId] }, actor, { itemId, revision });
  revalidatePath(`/admin/campaigns/${campaignId}`);
  revalidatePath("/admin");
}
