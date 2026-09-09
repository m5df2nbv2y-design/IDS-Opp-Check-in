import { notFound } from "next/navigation";
import { retrySyncAction, sendRemindersAction } from "../../actions";
import { ActionButton } from "@/components/admin/action-button";
import { RecipientTable } from "@/components/admin/recipient-table";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState, StageChange, StatTile, SyncStatusBadge } from "@/components/ui/primitives";
import { formatAmount, formatCompactAmount, formatDate, formatDateTime } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import { getCampaignSummary, listResponses } from "@/server/services/campaign-service";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({ params }: PageProps<"/admin/campaigns/[id]">) {
  const { id } = await params;
  const [summary, responses] = await Promise.all([getCampaignSummary(id), listResponses(id)]);
  if (!summary) notFound();

  const failed = responses.filter((response) => response.syncStatus === "FAILED");

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
          {failed.length > 0 ? (
            <ActionButton
              action={retrySyncAction.bind(null, summary.id)}
              pendingLabel="Retrying…"
              variant="danger"
            >
              Retry {failed.length} failed {failed.length === 1 ? "sync" : "syncs"}
            </ActionButton>
          ) : null}
          {summary.pendingCount > 0 ? (
            <ActionButton
              action={sendRemindersAction.bind(null, summary.id)}
              pendingLabel="Sending…"
              confirm={`Send a reminder to the ${summary.pendingCount} contact${summary.pendingCount === 1 ? "" : "s"} who haven't finished? This issues a fresh link and invalidates the previous one.`}
            >
              Send {summary.pendingCount} reminder{summary.pendingCount === 1 ? "" : "s"}
            </ActionButton>
          ) : null}
        </div>
      </div>

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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Emails sent" value={summary.emailsSent} />
        <StatTile label="Opened" value={summary.openedCount} />
        <StatTile label="Started" value={summary.startedCount} tone="warning" />
        <StatTile
          label="Send failures"
          value={summary.emailsFailed}
          tone={summary.emailsFailed > 0 ? "danger" : "default"}
        />
      </div>

      <section className="space-y-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Recipients</h2>
        <RecipientTable recipients={summary.recipients} />
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
