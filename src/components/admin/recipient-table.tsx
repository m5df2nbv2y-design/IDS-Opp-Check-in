import { AccountTypeBadge, Card, RecipientStatusBadge, Tick } from "@/components/ui/primitives";
import { accountTypeLabel } from "@/lib/account-types";
import { formatDateTime, pluralize } from "@/lib/format";
import type { ReconcileActionResult } from "@/app/admin/actions";
import { ReconcileControls, type ReconcileChoice } from "@/components/admin/reconcile-controls";
import type { RecipientProgress } from "@/server/services/campaign-service";
import type { InvitationObservedOutcome } from "@/server/services/reconcile-service";

type InvitationAction = (observed: InvitationObservedOutcome) => Promise<ReconcileActionResult>;

// Defined here, not in the client module: a server component cannot read a client module's plain exports.
const INVITATION_CHOICES: ReconcileChoice<InvitationObservedOutcome>[] = [
  {
    outcome: "SENT",
    label: "It was sent",
    confirm:
      "Confirm this invitation IS in the sending mailbox's Sent Items? It will be marked sent and included in reminders. Nothing is sent now.",
  },
  {
    outcome: "NOT_SENT",
    label: "It was not sent",
    confirm:
      "Confirm this invitation is NOT in the sending mailbox? It will be marked failed. Nothing is re-sent and the link is not revoked.",
  },
];

const INVITATION_FAILED_MESSAGE =
  "Could not record this. Reload the page, re-check the sending mailbox, and try again.";

/** Shown only for an invitation whose outcome is unknown (UNCERTAIN, or an interrupted PENDING). */
function InvitationReconcile({
  recipient,
  action,
}: {
  recipient: RecipientProgress;
  action?: (recipient: RecipientProgress) => InvitationAction;
}) {
  if (!action || !recipient.canReconcileInvitation) return null;
  return (
    <div className="mt-2">
      <p className="text-xs text-body">
        Check the sending mailbox&apos;s Sent Items, then record what you found.
      </p>
      <ReconcileControls
        action={action(recipient)}
        choices={INVITATION_CHOICES}
        failedMessage={INVITATION_FAILED_MESSAGE}
      />
    </div>
  );
}

/**
 * The campaign's core table: one row per EXTERNAL CONTACT, not per IDS rep.
 * The internal reps behind each row are shown as supporting context only.
 */
export function RecipientTable({
  recipients,
  reconcileInvitation,
}: {
  recipients: RecipientProgress[];
  /** Binds the invitation reconcile action to one recipient's shown state. */
  reconcileInvitation?: (recipient: RecipientProgress) => InvitationAction;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-[0.1em] text-muted">
              <th className="px-5 py-3 font-semibold">Contact</th>
              <th className="px-5 py-3 font-semibold">Organization</th>
              <th className="px-5 py-3 text-right font-semibold">Opportunities</th>
              <th className="px-5 py-3 text-center font-semibold">Sent</th>
              <th className="px-5 py-3 text-center font-semibold">Opened</th>
              <th className="px-5 py-3 text-center font-semibold">Completed</th>
              <th className="px-5 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {recipients.map((recipient) => (
              <tr key={recipient.recipientId} className="border-b border-line last:border-0">
                <td className="px-5 py-4">
                  <div className="font-semibold text-ink">{recipient.contactName}</div>
                  <div className="text-[13px] text-muted">{recipient.contactEmail}</div>
                </td>
                <td className="px-5 py-4">
                  <div className="text-[14px] text-body">{recipient.accountName}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <AccountTypeBadge label={accountTypeLabel(recipient.accountType)} />
                    {recipient.internalRepNames.length > 1 ? (
                      <span className="text-[11px] text-muted">
                        {recipient.internalRepNames.length} IDS reps
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="px-5 py-4 text-right tabular-nums text-body">
                  {recipient.opportunityCount}
                  {recipient.submittedCount > 0 &&
                  recipient.submittedCount < recipient.opportunityCount ? (
                    <span className="text-muted"> · {recipient.submittedCount} done</span>
                  ) : null}
                </td>
                <td className="px-5 py-4 text-center">
                  <Tick on={recipient.sentAt !== null} />
                </td>
                <td className="px-5 py-4 text-center">
                  <Tick on={recipient.openedAt !== null} />
                </td>
                <td className="px-5 py-4 text-center">
                  <Tick on={recipient.completedAt !== null} />
                </td>
                <td className="px-5 py-4">
                  <RecipientStatusBadge status={recipient.status} />
                  {recipient.deliveryNote ? <p className="mt-1 text-xs text-warning">{recipient.deliveryNote}</p> : null}
                  <InvitationReconcile recipient={recipient} action={reconcileInvitation} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-line md:hidden">
        {recipients.map((recipient) => (
          <li key={recipient.recipientId} className="px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold text-ink">{recipient.contactName}</div>
                <div className="text-[13px] text-body">{recipient.accountName}</div>
                <div className="mt-1 text-[13px] text-muted">
                  {recipient.opportunityCount}{" "}
                  {pluralize(recipient.opportunityCount, "opportunity", "opportunities")}
                  {recipient.internalRepNames.length > 1
                    ? ` · ${recipient.internalRepNames.length} IDS reps`
                    : ""}
                </div>
              </div>
              <RecipientStatusBadge status={recipient.status} />
                  {recipient.deliveryNote ? <p className="mt-1 text-xs text-warning">{recipient.deliveryNote}</p> : null}
            </div>
            <div className="mt-2 text-[12px] text-muted">{lastActivity(recipient)}</div>
            <InvitationReconcile recipient={recipient} action={reconcileInvitation} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function lastActivity(recipient: RecipientProgress): string {
  if (recipient.completedAt) return `Completed ${formatDateTime(recipient.completedAt)}`;
  if (recipient.openedAt) return `Opened ${formatDateTime(recipient.openedAt)}`;
  if (recipient.sentAt) return `Sent ${formatDateTime(recipient.sentAt)}`;
  return "Not sent";
}
