import { prisma } from "@/lib/db";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";

/**
 * Resolving a Salesforce write whose outcome we never learned.
 *
 * When a PATCH has already left the process and the org answers with a 5xx, or
 * the connection dies, the item is marked UNCERTAIN. That is the honest state:
 * the write may have landed or may not, and we cannot tell from here.
 *
 * UNCERTAIN is deliberately excluded from the claim set that `retryFailedSyncs`
 * and the approval path operate on — `{ PENDING, FAILED, WITHHELD }` — so no
 * automatic or bulk operation can touch it. That is correct, and it is exactly
 * why this module has to exist: until now there was no action at all. The
 * dashboard told an administrator to "Verify in Salesforce" and then offered
 * them nothing to do about what they found.
 *
 * So this is the ONLY way out of UNCERTAIN, and it is deliberately narrow:
 *
 *   - **Per item.** No bulk resolve. The commissioning note is explicit that
 *     these must not be cleared with a blanket retry, because each one is a
 *     separate question about a separate record.
 *   - **Attested.** The administrator states which outcome they observed. We
 *     do not guess, and we do not re-read the org to decide: a re-read could
 *     race another change and would make this a second write path.
 *   - **Audited as a human assertion.** SYNC_RECONCILED_* are distinct from
 *     SYNC_SUCCEEDED and SYNC_FAILED on purpose. Those record what the API
 *     said; these record what a person said. Collapsing them would let an
 *     attestation masquerade as an observed provider result.
 *   - **Revision bound.** The caller passes the `updatedAt` it displayed, so a
 *     stale page cannot resolve an item that has moved on underneath it.
 */

export type ObservedOutcome =
  /** The administrator can see the change in Salesforce. */
  | "APPLIED"
  /** The administrator can see the change did NOT reach Salesforce. */
  | "NOT_APPLIED";

export type ReconcileResult =
  | { ok: true; outcome: ObservedOutcome; nextStatus: "SYNCED" | "FAILED" }
  | {
      ok: false;
      reason:
        /** No such item in this campaign. */
        | "NOT_FOUND"
        /** The item is not UNCERTAIN, so there is nothing to reconcile. */
        | "NOT_UNCERTAIN"
        /** Someone or something changed the item since the page was rendered. */
        | "STALE";
    };

export async function reconcileUncertainWrite(input: {
  campaignId: string;
  itemId: string;
  /** The `updatedAt` ISO string the administrator was looking at. */
  revision: string;
  observed: ObservedOutcome;
  actor: string;
  /** Optional free-text note, e.g. which Salesforce field was checked. */
  note?: string | null;
}): Promise<ReconcileResult> {
  const item = await prisma.checkInOpportunity.findFirst({
    where: { id: input.itemId, recipient: { campaignId: input.campaignId } },
    select: {
      id: true,
      updatedAt: true,
      syncStatus: true,
      opportunityId: true,
      opportunityName: true,
      customerName: true,
      updatedStatus: true,
      recipient: { select: { contactId: true } },
    },
  });

  if (!item) return { ok: false, reason: "NOT_FOUND" };
  if (item.syncStatus !== "UNCERTAIN") return { ok: false, reason: "NOT_UNCERTAIN" };
  if (item.updatedAt.toISOString() !== input.revision) return { ok: false, reason: "STALE" };

  /**
   * APPLIED  → SYNCED. Terminal, and correctly so: the write is done, and
   *            nothing should attempt it again.
   * NOT_APPLIED → FAILED, which puts the item back in the claim set so an
   *            administrator can approve a fresh attempt through the normal
   *            path. It does NOT re-attempt the write here — reconciling what
   *            happened and deciding to try again are separate decisions, and
   *            merging them would make one click do both.
   */
  const nextStatus = input.observed === "APPLIED" ? "SYNCED" : "FAILED";

  // Conditional on the revision AND on still being UNCERTAIN, so two
  // administrators resolving the same item concurrently cannot both win.
  const claimed = await prisma.checkInOpportunity.updateMany({
    where: { id: item.id, updatedAt: item.updatedAt, syncStatus: "UNCERTAIN" },
    data: {
      syncStatus: nextStatus,
      syncError:
        input.observed === "APPLIED"
          ? null
          : "Reconciled by hand: the write did not reach Salesforce. Approve again to retry.",
      ...(input.observed === "APPLIED" ? { syncedAt: new Date() } : {}),
    },
  });

  if (claimed.count === 0) return { ok: false, reason: "STALE" };

  const applied = input.observed === "APPLIED";
  await recordAudit({
    type: applied
      ? AUDIT_EVENTS.SYNC_RECONCILED_APPLIED
      : AUDIT_EVENTS.SYNC_RECONCILED_NOT_APPLIED,
    summary:
      `${input.actor} reconciled an uncertain Salesforce write for ` +
      `${item.opportunityName} at ${item.customerName}: reported as ` +
      `${applied ? "APPLIED in Salesforce" : "NOT applied"}` +
      (input.note ? ` — ${input.note}` : ""),
    actor: input.actor,
    actorKind: "ADMIN",
    campaignId: input.campaignId,
    contactId: item.recipient.contactId,
    opportunityId: item.opportunityId,
  });

  return { ok: true, outcome: input.observed, nextStatus };
}

/**
 * Everything currently awaiting a human decision.
 *
 * Exposed so the state cannot hide: an UNCERTAIN item that nobody looks at is
 * a CRM record whose true value is unknown, and the longer it sits the harder
 * it is to reconcile against a record that keeps changing.
 */
export async function listUncertainWrites(campaignId?: string) {
  return prisma.checkInOpportunity.findMany({
    where: { syncStatus: "UNCERTAIN", ...(campaignId ? { recipient: { campaignId } } : {}) },
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      updatedAt: true,
      syncError: true,
      opportunityName: true,
      customerName: true,
      updatedStatus: true,
      recipient: { select: { campaignId: true, contactId: true } },
    },
  });
}
