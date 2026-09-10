"use client";

import { useState, useTransition } from "react";
import { markSignalReviewedAction, saveSignalDraftResponseAction } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Card, SignalMatchBadge, SignalStatusBadge } from "@/components/ui/primitives";
import { formatAmount, formatDateTime } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import { SIGNAL_MATCH_REASON_LABELS, type SignalMatchReason } from "@/server/services/signal-matching-service";

type SignalOpportunity = {
  customerName: string;
  opportunityName: string;
  projectName: string | null;
  amount: number;
  currentStage: string;
  salesforceUrl: string;
  internalRep: { name: string };
  account: { name: string };
};

export type SignalListItem = {
  id: string;
  sheetName: string;
  signalType: string;
  title: string;
  message: string;
  assignedToName: string | null;
  dueDate: Date | null;
  occurredAt: Date;
  sourceUrl: string | null;
  rawAccountName: string | null;
  rawProjectName: string | null;
  matchStatus: string;
  matchReason: string | null;
  status: string;
  reviewedAt: Date | null;
  draftResponse: string | null;
  draftedAt: Date | null;
  opportunity: SignalOpportunity | null;
  account: { name: string } | null;
  candidates?: SignalOpportunity[];
};

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  REMINDER: "Reminder",
  TASK_DUE: "Task due",
  COMMENT: "Comment",
  STATUS_CHANGE: "Status change",
};

export function SignalList({ signals }: { signals: SignalListItem[] }) {
  return (
    <Card className="divide-y divide-line">
      {signals.map((signal) => (
        <SignalRow key={signal.id} signal={signal} />
      ))}
    </Card>
  );
}

function SignalRow({ signal }: { signal: SignalListItem }) {
  const [draftOpen, setDraftOpen] = useState(Boolean(signal.draftResponse));
  const [reviewing, startReviewTransition] = useTransition();
  const [savingDraft, startDraftTransition] = useTransition();

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              {SIGNAL_TYPE_LABELS[signal.signalType] ?? signal.signalType}
            </span>
            <span className="text-[12px] text-muted">{signal.sheetName}</span>
          </div>
          <div className="mt-1 text-[16px] font-semibold text-ink">{signal.title}</div>
          <p className="mt-1 max-w-2xl text-[14px] text-body">{signal.message}</p>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-muted">
            <span>{formatDateTime(signal.occurredAt)}</span>
            {signal.assignedToName ? <span>Smartsheet assignee: {signal.assignedToName}</span> : null}
            {signal.dueDate ? <span>Due {formatDateTime(signal.dueDate)}</span> : null}
            {signal.sourceUrl ? (
              <a href={signal.sourceUrl} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
                Open in Smartsheet ↗
              </a>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <SignalMatchBadge status={signal.matchStatus} />
          <SignalStatusBadge status={signal.status} />
        </div>
      </div>

      <div className="mt-3 rounded-xl bg-canvas px-4 py-3">
        {signal.opportunity ? (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
              Matched opportunity
            </div>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="font-semibold text-ink">{signal.opportunity.customerName}</div>
                <div className="text-[13px] text-body">
                  {signal.opportunity.projectName ?? signal.opportunity.opportunityName}
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {signal.opportunity.account.name} · internal IDS rep{" "}
                  {signal.opportunity.internalRep.name}
                </div>
              </div>
              <div className="text-right text-[13px]">
                <div className="tabular-nums text-body">{formatAmount(signal.opportunity.amount)}</div>
                <div className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">
                  {stageLabel(signal.opportunity.currentStage)}
                </div>
              </div>
            </div>
            <a
              href={signal.opportunity.salesforceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-[12px] font-medium text-brand hover:underline"
            >
              Open in Salesforce ↗
            </a>
          </>
        ) : signal.candidates && signal.candidates.length > 0 ? (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-warning">
              {signal.candidates.length} possible opportunities at {signal.account?.name}
            </div>
            <ul className="mt-1.5 space-y-1">
              {signal.candidates.map((candidate) => (
                <li key={candidate.opportunityName} className="text-[13px] text-body">
                  {candidate.projectName ?? candidate.opportunityName} —{" "}
                  <span className="tabular-nums text-muted">{formatAmount(candidate.amount)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="text-[13px] text-danger">
            No matching organization on file — raw reference: {signal.rawAccountName ?? "none given"}
            {signal.rawProjectName ? ` / ${signal.rawProjectName}` : ""}
          </div>
        )}
        <div className="mt-2 text-[11px] text-muted">
          {SIGNAL_MATCH_REASON_LABELS[signal.matchReason as SignalMatchReason] ?? signal.matchReason}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={reviewing || signal.status !== "NEW"}
          onClick={() =>
            startReviewTransition(async () => {
              await markSignalReviewedAction(signal.id);
            })
          }
        >
          {signal.status === "NEW" ? (reviewing ? "Marking…" : "Mark reviewed") : "Reviewed"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDraftOpen((open) => !open)}>
          {signal.draftResponse ? "Edit draft response" : "Draft response"}
        </Button>
      </div>

      {draftOpen ? (
        <form
          action={(formData) =>
            startDraftTransition(async () => {
              await saveSignalDraftResponseAction(signal.id, formData);
            })
          }
          className="mt-3"
        >
          <textarea
            name="draftResponse"
            defaultValue={signal.draftResponse ?? ""}
            rows={3}
            maxLength={2000}
            placeholder="Draft a reply for internal review — nothing is sent from here."
            className="w-full resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[14px] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none"
          />
          <div className="mt-2 flex items-center gap-3">
            <Button type="submit" variant="secondary" size="sm" disabled={savingDraft}>
              {savingDraft ? "Saving…" : "Save draft"}
            </Button>
            {signal.draftedAt ? (
              <span className="text-[12px] text-muted">Saved {formatDateTime(signal.draftedAt)}</span>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
