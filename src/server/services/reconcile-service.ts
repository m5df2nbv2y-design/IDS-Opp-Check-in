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

const MAX_NOTE_LENGTH = 500;

/**
 * The state change and its audit record commit in ONE transaction, or neither
 * does: a failed audit write rolls the item back to UNCERTAIN, so an attestation
 * can never leave a changed, unaudited state. Never calls Salesforce or email.
 */
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
  // The server action is an HTTP-addressable endpoint, so the types above do
  // not constrain what a client posts. Check at runtime, before any query: an
  // `undefined` id would otherwise silently drop out of a Prisma `where`.
  if (input.observed !== "APPLIED" && input.observed !== "NOT_APPLIED") {
    throw new Error("Choose a valid reconciliation outcome.");
  }
  for (const value of [input.campaignId, input.itemId, input.revision]) {
    if (typeof value !== "string" || value === "") {
      throw new Error("This response could not be identified. Reload the page and try again.");
    }
  }
  if (input.note != null && (typeof input.note !== "string" || input.note.length > MAX_NOTE_LENGTH)) {
    throw new Error(`The note must be ${MAX_NOTE_LENGTH} characters or fewer.`);
  }

  return prisma.$transaction(async (tx): Promise<ReconcileResult> => {
    const item = await tx.checkInOpportunity.findFirst({
      where: { id: input.itemId, recipient: { campaignId: input.campaignId } },
      select: {
        id: true,
        updatedAt: true,
        syncStatus: true,
        opportunityId: true,
        opportunityName: true,
        customerName: true,
        previousStatus: true,
        updatedStatus: true,
        recipient: { select: { contactId: true } },
        opportunity: { select: { accountId: true, internalRepId: true } },
      },
    });

    if (!item) return { ok: false, reason: "NOT_FOUND" };
    if (!isReconcilableWrite(item)) return { ok: false, reason: "NOT_UNCERTAIN" };
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

    // Conditional on the revision AND on the state shown (UNCERTAIN or stuck SYNCING), so two
    // administrators resolving the same item concurrently cannot both win.
    const claimed = await tx.checkInOpportunity.updateMany({
      where: { id: item.id, updatedAt: item.updatedAt, syncStatus: item.syncStatus },
      data: {
        syncStatus: nextStatus,
        syncError:
          input.observed === "APPLIED"
            ? null
            : "Reconciled by hand: the write did not reach Salesforce. Approve again to retry.",
        syncedAt: input.observed === "APPLIED" ? new Date() : null,
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
      accountId: item.opportunity.accountId,
      repId: item.opportunity.internalRepId,
      opportunityId: item.opportunityId,
      fromStatus: item.previousStatus,
      toStatus: item.updatedStatus,
    }, tx);

    return { ok: true, outcome: input.observed, nextStatus };
  });
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

/**
 * The by-hand APPLIED attestations recorded for a campaign, oldest first.
 *
 * Read-only, and it reads the audit trail on purpose: an APPLIED item is SYNCED
 * either way, so SYNC_RECONCILED_APPLIED is the only existing record that the
 * status came from a person rather than from a Salesforce response. The caller
 * uses it to keep saying so after the UNCERTAIN controls have gone.
 */
export async function listAppliedAttestations(campaignId: string) {
  return prisma.auditEvent.findMany({
    where: { campaignId, type: AUDIT_EVENTS.SYNC_RECONCILED_APPLIED },
    orderBy: { createdAt: "asc" },
    select: { contactId: true, opportunityId: true, actor: true, createdAt: true },
  });
}

// ---------------------------------------------------------------------------
// Invitations whose send outcome is unknown
// ---------------------------------------------------------------------------

/** A PENDING invitation younger than this may still be sending, so it cannot be settled yet. */
export const INTERRUPTED_INVITATION_AGE_MS = 15 * 60 * 1000;

/**
 * Whether an administrator may settle this Salesforce write by hand: UNCERTAIN,
 * or SYNCING for longer than any request can run (Salesforce calls time out in
 * seconds), which means the run died after claiming it and nothing will finish it.
 */
export function isReconcilableWrite(item: { syncStatus: string; updatedAt: Date }, now = new Date()): boolean {
  return item.syncStatus === "UNCERTAIN" ||
    (item.syncStatus === "SYNCING" && now.getTime() - item.updatedAt.getTime() > INTERRUPTED_INVITATION_AGE_MS);
}

/**
 * Whether an administrator may settle this invitation by hand: its provider
 * outcome is UNCERTAIN, or it is PENDING and old enough that the send was
 * interrupted rather than still in flight. Reminder states are not covered.
 */
export function isSettleableInvitation(
  recipient: { sendStatus: string; createdAt: Date },
  now = new Date(),
): boolean {
  if (recipient.sendStatus === "UNCERTAIN") return true;
  return (
    recipient.sendStatus === "PENDING" &&
    now.getTime() - recipient.createdAt.getTime() > INTERRUPTED_INVITATION_AGE_MS
  );
}

/** What the administrator found in the sending mailbox. */
export type InvitationObservedOutcome = "SENT" | "NOT_SENT";

export type InvitationReconcileResult =
  | { ok: true; outcome: InvitationObservedOutcome; nextStatus: "SENT" | "FAILED" }
  | {
      ok: false;
      reason:
        /** No such recipient in this campaign. */
        | "NOT_FOUND"
        /** Not UNCERTAIN and not an interrupted PENDING: nothing to settle. */
        | "NOT_UNRESOLVED"
        /** PENDING, but young enough that the send may still be in flight. */
        | "STILL_SENDING"
        /** Status or token changed since the page was rendered. */
        | "STALE"
        /** "Not sent" refused: the recipient opened the link, so it was delivered. */
        | "OPENED";
    };

export const INVITATION_NOT_SENT_NOTE =
  "Reconciled by hand: the invitation was not found in the sending mailbox.";

/**
 * Settle an invitation whose send outcome is unknown, from an administrator's
 * attestation. Same shape as `reconcileUncertainWrite`: runtime input checks,
 * one transaction, a conditional update on the shown `sendStatus` + `tokenHint`,
 * and a distinct audit event. Never sends email, calls a provider, or touches
 * the `EmailMessage` ledger. "Not sent" marks FAILED only; nothing is re-sent
 * and the link is not revoked.
 */
export async function reconcileUnknownInvitation(input: {
  campaignId: string;
  recipientId: string;
  shownStatus: string;
  shownTokenHint: string;
  observed: InvitationObservedOutcome;
  actor: string;
}): Promise<InvitationReconcileResult> {
  if (input.observed !== "SENT" && input.observed !== "NOT_SENT") {
    throw new Error("Choose a valid reconciliation outcome.");
  }
  for (const value of [input.campaignId, input.recipientId, input.shownStatus, input.shownTokenHint]) {
    if (typeof value !== "string" || value === "") {
      throw new Error("This invitation could not be identified. Reload the page and try again.");
    }
  }

  return prisma.$transaction(async (tx): Promise<InvitationReconcileResult> => {
    const recipient = await tx.checkInRecipient.findFirst({
      where: { id: input.recipientId, campaignId: input.campaignId },
      select: {
        id: true,
        sendStatus: true,
        tokenHint: true,
        createdAt: true,
        openedAt: true,
        completedAt: true,
        sendError: true,
        contactId: true,
        contact: { select: { name: true, accountId: true } },
      },
    });

    if (!recipient) return { ok: false, reason: "NOT_FOUND" };
    if (recipient.sendStatus !== "UNCERTAIN" && recipient.sendStatus !== "PENDING") {
      return { ok: false, reason: "NOT_UNRESOLVED" };
    }
    if (!isSettleableInvitation(recipient)) return { ok: false, reason: "STILL_SENDING" };
    if (recipient.sendStatus !== input.shownStatus || recipient.tokenHint !== input.shownTokenHint) {
      return { ok: false, reason: "STALE" };
    }

    const sent = input.observed === "SENT";
    // Opening the link proves delivery, so "not sent" would contradict it.
    if (!sent && (recipient.openedAt || recipient.completedAt)) return { ok: false, reason: "OPENED" };
    // Conditional on the shown state, so two administrators cannot both win.
    const claimed = await tx.checkInRecipient.updateMany({
      where: {
        id: recipient.id,
        campaignId: input.campaignId,
        sendStatus: input.shownStatus,
        tokenHint: input.shownTokenHint,
        ...(sent ? {} : { openedAt: null, completedAt: null }),
      },
      data: sent
        ? { sendStatus: "SENT", sendError: null, sentAt: recipient.createdAt }
        : { sendStatus: "FAILED", sendError: INVITATION_NOT_SENT_NOTE },
    });
    if (claimed.count === 0) return { ok: false, reason: "STALE" };

    await recordAudit({
      type: sent ? AUDIT_EVENTS.INVITE_RECONCILED_SENT : AUDIT_EVENTS.INVITE_RECONCILED_NOT_SENT,
      summary:
        `${input.actor} reconciled an unknown invitation to ${recipient.contact.name}: ` +
        `reported as ${sent ? "sent (found in the sending mailbox)" : "NOT sent"}`,
      actor: input.actor,
      actorKind: "ADMIN",
      campaignId: input.campaignId,
      contactId: recipient.contactId,
      accountId: recipient.contact.accountId,
      fromStatus: recipient.sendStatus,
      toStatus: sent ? "SENT" : "FAILED",
      detail: JSON.stringify({
        recipientId: recipient.id,
        tokenHint: input.shownTokenHint,
        previousSendError: recipient.sendError,
        ...(sent ? { sentAtInferredFrom: "recipient.createdAt" } : {}),
      }),
    }, tx);

    return { ok: true, outcome: input.observed, nextStatus: sent ? "SENT" : "FAILED" };
  });
}
