import Link from "next/link";
import { notFound } from "next/navigation";
import {
  approveLegacyRoutingAction,
  approveWritebackAction,
  excludeShortfallAction,
  reconcileInvitationAction,
  reconcileUncertainAction,
  retrySyncAction,
  resumeLaunchAction,
  sendRemindersAction,
} from "../../actions";
import { ActionButton } from "@/components/admin/action-button";
import { ReconcileControls } from "@/components/admin/reconcile-controls";
import { RecipientTable } from "@/components/admin/recipient-table";
import { TestEmailPanel } from "@/components/admin/test-email-panel";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, StageChange, StatTile, SyncStatusBadge } from "@/components/ui/primitives";
import { formatAmount, formatCompactAmount, formatDate, formatDateTime } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import { getCampaignSummary, getLegacyRoutingPreview, legacyShownRoutes, listResponses, SHORTFALL_REASONS } from "@/server/services/campaign-service";
import { isReconcilableWrite, listAppliedAttestations } from "@/server/services/reconcile-service";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Kept after the UNCERTAIN controls are gone: this SYNCED status came from a person, not from Salesforce. */
function AttestedNote({ event }: { event?: { actor: string; createdAt: Date } }) {
  if (!event) return null;
  return (
    <p className="mt-2 text-[13px] text-muted">
      Recorded by hand: {event.actor} confirmed this change in Salesforce on {formatDateTime(event.createdAt)}.
      That did not refresh the cached Salesforce data in this app.
    </p>
  );
}

export default async function CampaignDetailPage({ params }: PageProps<"/admin/campaigns/[id]">) {
  const { id } = await params;
  const [summary, responses, attestations, legacyRouting] = await Promise.all([
    getCampaignSummary(id),
    listResponses(id),
    listAppliedAttestations(id),
    getLegacyRoutingPreview(id),
  ]);
  if (!summary) notFound();

  // The latest by-hand APPLIED attestation per response. Read from the audit
  // trail so the explanation survives a reload and the UNCERTAIN controls going.
  const attestationKey = (contactId: string | null, opportunityId: string | null) =>
    `${contactId}:${opportunityId}`;
  const attestedByHand = new Map(
    attestations.map((event) => [attestationKey(event.contactId, event.opportunityId), event]),
  );

  const failed = responses.filter((response) => response.syncStatus === "FAILED");

  // The demo control appears only when a demo address is configured on the
  // server, and only for a recipient whose invitation has actually gone out —
  // there is no check-in link to demonstrate before that.
  const demoAddress = env.demoTestEmail.trim();
  const testRecipient = demoAddress
    ? summary.recipients.find((recipient) => recipient.sentAt !== null)
    : undefined;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <ButtonLink href="/admin" variant="ghost" size="sm" className="-ml-3 mb-1">
            ← Dashboard
          </ButtonLink>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">{summary.name}</h1>
          <p className="mt-1 text-[15px] text-muted">
            {summary.period} · launched {formatDate(summary.startedAt ?? summary.createdAt)}
            {summary.completedAt ? ` · closed ${formatDate(summary.completedAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href={`/admin/campaigns/${summary.id}/receipt`} variant="secondary">View sending results</ButtonLink>
          {failed.length > 0 ? (
            <ActionButton
              action={retrySyncAction.bind(null, summary.id)}
              pendingLabel="Retrying…"
              variant="danger"
            >
              Retry {failed.length} failed {failed.length === 1 ? "sync" : "syncs"}
            </ActionButton>
          ) : null}
          {summary.reminderEligibleCount > 0 ? (
            <ActionButton
              action={sendRemindersAction.bind(null, summary.id)}
              pendingLabel="Sending…"
              confirm={`Send a reminder to the ${summary.reminderEligibleCount} contact${summary.reminderEligibleCount === 1 ? "" : "s"} who haven't finished? This issues a fresh link and invalidates the previous one.`}
            >
              Send {summary.reminderEligibleCount} reminder{summary.reminderEligibleCount === 1 ? "" : "s"}
            </ActionButton>
          ) : null}
        </div>
      </div>

      {summary.unreachedCount > 0 ? (
        <Card className="space-y-3 p-5">
          <p role="status">{summary.unreachedCount} approved opportunities have no invitation items. This campaign cannot close until the shortfall is reviewed.</p>
          <p>{summary.recoverableCount} can safely resume for contacts never provisioned. Remaining work needs review of routing, eligibility or an existing invitation; issued links are never expanded.</p>
          {summary.status === "IN_PROGRESS" && summary.recoverableCount > 0 ? <ActionButton action={resumeLaunchAction.bind(null, summary.id)} pendingLabel="Resuming…" confirm="Resume only approved opportunities for eligible contacts with no existing invitation?">Resume unsent invitations</ActionButton> : null}
          {summary.needsReview.length > 0 ? (
            <div className="space-y-2">
              <p className="font-semibold text-ink">Needs review</p>
              <ul className="space-y-2 text-[14px]">
                {summary.needsReview.map((row) => (
                  <li key={row.opportunityId} className="flex flex-wrap items-center justify-between gap-2">
                    <span>{row.customerName} · {row.opportunityName} — {SHORTFALL_REASONS[row.reason]}</span>
                    {summary.status === "IN_PROGRESS" ? (
                      <ActionButton
                        action={excludeShortfallAction.bind(null, summary.id, row.opportunityId, row.reason)}
                        pendingLabel="Excluding…"
                        size="sm"
                        confirm={`Exclude ${row.customerName} · ${row.opportunityName} from this campaign? Reason: ${SHORTFALL_REASONS[row.reason]}. Nothing is sent. This cannot be undone.`}
                      >Exclude from this campaign</ActionButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {legacyRouting && legacyRouting.length > 0 ? (
            <div className="space-y-2">
              <p>This campaign was launched before routing was recorded. Review where each unsent opportunity would go today, then approve to allow resume. Contacts already invited are never re-sent.</p>
              <ul className="list-disc pl-5 text-[14px]">
                {legacyRouting.map((row) => (
                  <li key={row.opportunityId}>
                    {row.customerName} · {row.opportunityName} → {row.contactName ?? "no eligible contact (stays in review)"}
                    {row.alreadyInvited ? " (already invited; will not be added to that invitation)" : ""}
                  </li>
                ))}
              </ul>
              {legacyRouting.some((row) => !row.contactId || row.alreadyInvited) ? <p>Opportunities already invited or without an eligible contact stay in the shortfall, and the campaign stays open until they are reviewed.</p> : null}
              <ActionButton
                action={approveLegacyRoutingAction.bind(null, summary.id, legacyShownRoutes(legacyRouting))}
                pendingLabel="Approving…"
                confirm="Record this routing as approved? Unsent opportunities go to the contacts shown; opportunities without an eligible contact stay in review."
              >Approve routing</ActionButton>
            </div>
          ) : null}
        </Card>
      ) : null}
      {summary.excluded.length > 0 ? (
        <Card className="space-y-2 p-5">
          <p className="font-semibold text-ink">Excluded from this campaign</p>
          <ul className="list-disc pl-5 text-[14px]">
            {summary.excluded.map((row) => (
              <li key={row.opportunityId}>
                {row.customerName} · {row.opportunityName} — {SHORTFALL_REASONS[row.reason]} · excluded by {row.actor} on {formatDateTime(row.at)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {summary.unresolvedDeliveryCount > 0 ? (
        <Card className="p-5"><p role="status">{summary.unresolvedDeliveryCount} invitation or reminder deliveries are pending or unresolved. Automatic replay is blocked. Reconcile provider records before any replacement. An interrupted reminder may have invalidated the previous link; uninterrupted link access cannot be guaranteed.</p></Card>
      ) : null}

      {attestations.length > 0 ? (
        <Card className="space-y-2 p-5">
          <p role="status" className="font-semibold text-ink">
            {attestations.length === 1 ? "1 response was" : `${attestations.length} responses were`} recorded as synced by hand.
          </p>
          <p>
            Recording that a change is in Salesforce marks the response synced. It does not refresh the cached
            Salesforce data in this app, so the stage and close date shown here may be out of date. Before you
            prepare another campaign, run <strong>Refresh from Salesforce</strong> on the{" "}
            <Link href="/admin" className="font-medium text-brand hover:underline">dashboard</Link>. That is a
            manual step: nothing in this app checks that it has been done.
          </p>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile
          label="Opportunities"
          value={summary.opportunityCount}
          hint={formatCompactAmount(summary.totalValue)}
        />
        <StatTile label="Contacts" value={summary.recipientCount} />
        <StatTile label="Organizations" value={summary.organizationCount} />
        <StatTile label="Completed" value={summary.completedCount} tone="success" />
        <StatTile
          label="Sync errors"
          value={summary.syncErrorCount}
          tone={summary.syncErrorCount > 0 ? "danger" : "default"}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Emails sent" value={summary.emailsSent} />
        <StatTile label="Opened" value={summary.openedCount} />
        <StatTile label="Started" value={summary.startedCount} tone="warning" />
        <StatTile
          label="Send failures"
          value={summary.emailsFailed}
          tone={summary.emailsFailed > 0 ? "danger" : "default"}
        />
        {/* Not classified as failed: acceptance and delivery are unconfirmed, so it is neither reported as sent nor replaced automatically. */}
        <StatTile
          label="Send outcome unknown"
          value={summary.emailsUncertain}
          tone={summary.emailsUncertain > 0 ? "warning" : "default"}
          hint={summary.emailsUncertain > 0 ? "Investigate in the sent mailbox or provider before sending a replacement." : undefined}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Recipients</h2>
        <RecipientTable
          recipients={summary.recipients}
          reconcileInvitation={(recipient) =>
            reconcileInvitationAction.bind(
              null,
              summary.id,
              recipient.recipientId,
              recipient.sendStatus,
              recipient.tokenHint,
            )
          }
        />
        {testRecipient ? (
          <TestEmailPanel
            recipientId={testRecipient.recipientId}
            contactName={testRecipient.contactName}
            organizationName={testRecipient.accountName}
            demoAddress={demoAddress}
          />
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">
          Submitted updates <span className="font-normal text-muted">({responses.length})</span>
        </h2>

        {responses.length === 0 ? (
          <EmptyState
            title="No responses yet"
            body="Updates appear here the moment a contact answers, before they finish their check-in."
          />
        ) : (
          <Card className="divide-y divide-line">
            {responses.map((response) => (
              <div key={response.id} className="px-5 py-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-ink">{response.customerName}</div>
                    <div className="text-[14px] text-body">
                      {response.projectName ?? response.opportunityName}
                    </div>
                    <div className="mt-1.5">
                      <StageChange
                        from={stageLabel(response.previousStatus)}
                        to={stageLabel(response.updatedStatus)}
                      />
                    </div>
                    <div className="mt-1.5 text-[12px] text-muted">
                      Updated by{" "}
                      <span className="font-medium text-body">
                        {response.recipient.contact.name}
                      </span>{" "}
                      at {response.recipient.contact.account.name} · internal IDS rep{" "}
                      <span className="font-medium text-body">{response.internalRepName}</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <SyncStatusBadge status={response.syncStatus} />
                    <div className="text-[12px] text-muted">
                      {formatDateTime(response.submittedAt)}
                    </div>
                    <div className="text-[12px] tabular-nums text-muted">
                      {formatAmount(response.amount)}
                    </div>
                  </div>
                </div>

                <p className="mt-2 text-sm text-muted">Close date: {response.previousCloseDate ? formatDate(response.previousCloseDate) : "Not set"} → {response.updatedCloseDate ? formatDate(response.updatedCloseDate) : "Unchanged"}</p>
                {response.recipient.completedAt && response.updatedStatus !== "CLOSED_LOST" && ["PENDING", "FAILED", "WITHHELD"].includes(response.syncStatus) && env.salesforce.writeEnabled ? (
                  <div className="mt-3"><ActionButton
                    action={approveWritebackAction.bind(null, summary.id, response.id, response.updatedAt.toISOString())}
                    confirm={`Approve this response and write its stage and close date to Salesforce?`}
                    pendingLabel="Applying…"
                  >Approve Salesforce update</ActionButton></div>
                ) : null}
                {isReconcilableWrite(response) ? (
                  <div className="mt-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3">
                    <p className="text-[13px] font-semibold text-warning">
                      This write may or may not have reached Salesforce.
                    </p>
                    <p className="mt-1 text-[13px] text-body">
                      The request left us but Salesforce never confirmed it, so we will not
                      guess and we will not retry on our own. Open the record, check the
                      stage and close date, then tell us what you found.
                    </p>
                    <ReconcileControls
                      action={reconcileUncertainAction.bind(
                        null,
                        summary.id,
                        response.id,
                        response.updatedAt.toISOString(),
                      )}
                    />
                  </div>
                ) : null}
                <AttestedNote event={response.syncStatus === "SYNCED" ? attestedByHand.get(attestationKey(response.recipient.contactId, response.opportunityId)) : undefined} />
                {response.updatedStatus === "CLOSED_LOST" ? <p className="mt-2 text-sm text-muted">Closed Lost write-back is deferred until its fields and choices are confirmed.</p> : null}
                {response.repComment ? (
                  <p className="mt-3 rounded-xl bg-canvas px-4 py-2.5 text-[14px] text-body">
                    “{response.repComment}”
                  </p>
                ) : null}

                {response.syncError ? (
                  <p className="mt-3 rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] text-danger">
                    {response.syncError}
                  </p>
                ) : null}

                <a
                  href={response.salesforceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2.5 inline-block text-[13px] font-medium text-brand hover:underline"
                >
                  Open in Salesforce ↗
                </a>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}
