import {
  Card,
  EmptyState,
  StageChange,
  StatTile,
  SyncStatusBadge,
  ValueTile,
} from "@/components/ui/primitives";
import { formatAmount, formatCompactAmount, formatDateTime, formatShortDate } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import {
  getCampaignAnalytics,
  getOutcomeTotals,
  getSnapshotEvidence,
} from "@/server/services/analytics-service";
import { listCampaigns } from "@/server/services/campaign-service";

export const dynamic = "force-dynamic";

/**
 * The measurement story: what we chose to do, what happened afterwards, and the
 * observation history that makes both durable.
 *
 * Deliberately reports intervention and outcome as separate facts. A movement
 * seen after an intervention is described as "changed after contact" — never as
 * caused by it. Attribution is a methodology to be defined, not a claim to make
 * on a dashboard.
 */
export default async function AnalyticsPage() {
  const campaigns = await listCampaigns();
  const sent = campaigns.filter((campaign) => campaign.status !== "DRAFT");
  const [analytics, evidence, outcomes] = await Promise.all([
    sent[0] ? getCampaignAnalytics(sent[0].id) : Promise.resolve(null),
    getSnapshotEvidence(),
    getOutcomeTotals(),
  ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">Measurement</h1>
          <p className="mt-1 max-w-3xl text-[15px] text-muted">
            What we chose to do, what happened afterwards, and the observation history that
            keeps both answerable. Intervention and outcome are recorded as separate facts —
            a change seen after contact is reported as exactly that, not as caused by it.
          </p>
        </div>
        {/* Both exports render the same server-side snapshot; nothing is
            calculated in the browser. Plain links so the browser handles the
            download itself. */}
        <div className="flex shrink-0 flex-wrap gap-2">
          <a
            href="/api/admin/reports/executive-brief"
            className="inline-flex items-center rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-brand-dark"
          >
            Export Executive Brief
          </a>
          <a
            href="/api/admin/reports/pipeline-workbook"
            className="inline-flex items-center rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-body transition hover:bg-canvas"
          >
            Export Excel
          </a>
        </div>
      </div>

      {analytics ? (
        <>
          <section className="space-y-3">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-muted">
              Intervention · {analytics.campaignName}
            </h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <ValueTile
                label="Pipeline selected"
                value={
                  analytics.selectedValue === null
                    ? "—"
                    : formatCompactAmount(analytics.selectedValue)
                }
                count={analytics.selectedCount}
                hint={analytics.selectedCount === null ? "not recorded for this campaign" : undefined}
              />
              <ValueTile
                label="Pipeline contacted"
                value={formatCompactAmount(analytics.contactedValue)}
                count={analytics.contactedCount}
              />
              <ValueTile
                label="Pipeline with responses"
                value={formatCompactAmount(analytics.respondedValue)}
                count={analytics.respondedCount}
                tone={analytics.respondedCount > 0 ? "success" : "default"}
              />
              <StatTile
                label="Recipients"
                value={analytics.recipientCount}
                hint={`${analytics.openedCount} of ${analytics.recipientCount} opened their link`}
              />
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-muted">
              Outcome observed after contact
            </h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <ValueTile
                label="Pipeline that moved stage"
                value={formatCompactAmount(analytics.stageMovedValue)}
                count={analytics.stageMovedCount}
                tone={analytics.stageMovedCount > 0 ? "success" : "default"}
              />
              <ValueTile
                label="Pipeline with new close date"
                value={formatCompactAmount(analytics.closeDateMovedValue)}
                count={analytics.closeDateMovedCount}
              />
              <ValueTile
                label="Confirmed, no change"
                value={formatCompactAmount(analytics.confirmedNoChangeValue)}
                count={analytics.confirmedNoChangeCount}
              />
              <StatTile
                label="Held from Salesforce"
                value={analytics.withheldCount}
                tone={analytics.withheldCount > 0 ? "warning" : "default"}
                hint="write-back disabled"
              />
            </div>
            <p className="text-[13px] text-muted">
              Exact figures — pipeline that moved stage{" "}
              <strong className="font-semibold text-ink">
                {formatAmount(analytics.stageMovedValue)}
              </strong>
              , pipeline with a revised close date{" "}
              <strong className="font-semibold text-ink">
                {formatAmount(analytics.closeDateMovedValue)}
              </strong>
              . These are movements observed after an intervention, in the order they
              happened — attribution methodology is not yet defined, so no share of this
              value is claimed as caused by the check-in.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-[17px] font-semibold tracking-tight text-ink">
              What the customers told us{" "}
              <span className="font-normal text-muted">({analytics.movements.length})</span>
            </h2>
            {analytics.movements.length === 0 ? (
              <EmptyState
                title="No responses yet"
                body="Responses appear here as soon as a contact completes their check-in."
              />
            ) : (
              <Card className="divide-y divide-line">
                {analytics.movements.map((movement, index) => (
                  <div key={`${movement.opportunityName}-${index}`} className="px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-ink">{movement.opportunityName}</div>
                        <div className="text-[13px] text-muted">
                          {movement.accountName} · answered by {movement.contactName} · IDS rep{" "}
                          {movement.ownerName}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                          <StageChange
                            from={stageLabel(movement.fromStage)}
                            to={stageLabel(movement.toStage)}
                          />
                          {movement.toCloseDate &&
                          movement.toCloseDate.getTime() !== movement.fromCloseDate?.getTime() ? (
                            <span className="text-[13px] text-body">
                              <span className="text-muted line-through decoration-line-strong">
                                {formatShortDate(movement.fromCloseDate)}
                              </span>
                              <span className="mx-1.5 text-muted">→</span>
                              <span className="font-semibold text-ink">
                                {formatShortDate(movement.toCloseDate)}
                              </span>
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <SyncStatusBadge status={movement.syncStatus} />
                        <span className="text-[13px] tabular-nums text-muted">
                          {formatAmount(movement.amount)}
                        </span>
                        <span className="text-[12px] text-muted">
                          {formatDateTime(movement.respondedAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </Card>
            )}
          </section>
        </>
      ) : (
        <EmptyState
          title="No campaign has been sent yet"
          body="Select opportunities on the dashboard and send a check-in — the measurement story appears here."
        />
      )}

      <section className="space-y-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em] text-muted">
          Realised outcomes · all opportunities
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ValueTile
            label="Won"
            value={formatCompactAmount(outcomes.wonValue)}
            count={outcomes.wonCount}
            tone={outcomes.wonCount > 0 ? "success" : "default"}
          />
          <ValueTile
            label="Lost"
            value={formatCompactAmount(outcomes.lostValue)}
            count={outcomes.lostCount}
            tone={outcomes.lostCount > 0 ? "danger" : "default"}
          />
          <ValueTile
            label="Still open"
            value={formatCompactAmount(outcomes.openValue)}
            count={outcomes.openCount}
          />
        </div>
        <p className="max-w-3xl text-[13px] text-muted">
          Won and lost values are the amount recorded when the opportunity closed, captured
          before Salesforce moved on. Shown for the whole book of business, not as a result
          of any campaign.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">
          Observation history{" "}
          <span className="font-normal text-muted">({evidence.totalObservations} recorded)</span>
        </h2>
        <p className="max-w-3xl text-[13px] text-muted">
          Salesforce overwrites its own values on every change. These observations are ours
          and are append-only, so pipeline over time stays answerable even after the source
          record moves on.
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <Card className="px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
              Open pipeline by stage
            </div>
            <ul className="mt-2 space-y-1.5">
              {evidence.pipelineByStage.map((row) => (
                <li key={row.stage} className="flex items-baseline justify-between gap-3 text-[14px]">
                  <span className="text-body">{stageLabel(row.stage)}</span>
                  <span className="text-muted">
                    <span className="tabular-nums">{row.count}</span> ·{" "}
                    <span className="font-medium tabular-nums text-ink">
                      {formatCompactAmount(row.value)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
              Observations by source
            </div>
            <ul className="mt-2 space-y-1.5">
              {evidence.bySource.map((row) => (
                <li key={row.source} className="flex items-baseline justify-between gap-3 text-[14px]">
                  <span className="text-body">{row.source.replaceAll("_", " ").toLowerCase()}</span>
                  <span className="font-medium tabular-nums text-ink">{row.count}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        {evidence.sampleTimeline ? (
          <Card className="px-5 py-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
              Example timeline — {evidence.sampleTimeline.opportunityName}
            </div>
            <ul className="mt-2.5 space-y-2">
              {evidence.sampleTimeline.rows.map((row, index) => (
                <li key={index} className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                  <span className="w-40 shrink-0 tabular-nums text-muted">
                    {formatDateTime(row.observedAt)}
                  </span>
                  <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px] font-medium text-muted">
                    {row.source.replaceAll("_", " ").toLowerCase()}
                  </span>
                  <span className="font-medium text-ink">{stageLabel(row.stage)}</span>
                  <span className="tabular-nums text-muted">{formatAmount(row.amount)}</span>
                  {row.closeDate ? (
                    <span className="text-muted">closes {formatShortDate(row.closeDate)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </section>
    </div>
  );
}
