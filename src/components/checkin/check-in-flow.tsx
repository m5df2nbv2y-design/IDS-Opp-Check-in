"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { firstName, formatShortDate } from "@/lib/format";
import { WIN_PROBABILITIES, validResponseDate, type LossReasonOption, type RecipientOpportunity } from "@/lib/client-response";
import type { OpportunityStage } from "@/lib/stages";

type Props = {
  token: string;
  contactName: string;
  items: RecipientOpportunity[];
  lossReasons: LossReasonOption[];
  /** Only supplied by the guarded, fictional local preview page. */
  preview?: boolean;
};
type Answer = {
  status: "OPEN" | "CLOSED_LOST" | null;
  stage: OpportunityStage | null;
  closeDate: string;
  dateConfirmed: boolean;
  lossReason: string;
  comment: string;
};
const choiceStyle = (selected: boolean) => `min-h-14 rounded-2xl border-2 px-5 py-3 text-left text-[17px] font-semibold transition-colors ${selected ? "border-brand bg-brand-soft text-brand" : "border-line bg-surface text-ink hover:border-line-strong"}`;

export function CheckInFlow({ token, contactName, items, lossReasons, preview = false }: Props) {
  const [answers, setAnswers] = useState<Answer[]>(() => items.map((item) => ({
    status: item.selectedStage ? item.selectedStage === "CLOSED_LOST" ? "CLOSED_LOST" : "OPEN" : null,
    stage: item.selectedStage,
    closeDate: item.selectedCloseDate ?? item.currentCloseDate ?? "",
    dateConfirmed: !!item.selectedStage && item.selectedStage !== "CLOSED_LOST",
    lossReason: item.selectedLossReason ?? "",
    comment: item.comment,
  })));
  const [index, setIndex] = useState(() => Math.max(0, items.findIndex((item) => !item.selectedStage)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const item = items[index];
  const answer = answers[index];
  const closing = answer.status === "CLOSED_LOST";
  const ready = closing
    ? lossReasons.some((reason) => reason.value === answer.lossReason)
    : answer.status === "OPEN" && validResponseDate(answer.closeDate) && answer.dateConfirmed && !!answer.stage;

  function update(patch: Partial<Answer>) {
    setAnswers((current) => current.map((entry, position) => position === index ? { ...entry, ...patch } : entry));
    setError(null);
  }
  function goTo(position: number) {
    setIndex(position);
    setError(null);
    window.scrollTo({ top: 0 });
  }
  async function handleNext() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!preview) {
        const reasonLabel = lossReasons.find((reason) => reason.value === answer.lossReason)?.label;
        const response = await fetch(`/api/checkin/${token}/responses`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            flowVersion: 2, itemId: item.id,
            stage: closing ? "CLOSED_LOST" : answer.stage,
            lossReason: closing ? answer.lossReason : null,
            comment: closing ? reasonLabel : answer.comment.trim() || null,
            closeDate: closing ? null : answer.closeDate,
          }),
        });
        if (!response.ok) throw new Error("We couldn’t save this answer. Please try again. If you selected Closed Lost, reload to refresh the available reasons.");
      }
      if (index < items.length - 1) { goTo(index + 1); return; }
      if (!preview) {
        const completion = await fetch(`/api/checkin/${token}/complete`, { method: "POST" });
        if (!completion.ok) throw new Error("Your answer was saved, but we couldn’t submit the check-in. Please try again.");
      }
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Please check your connection and try again.");
    } finally { setBusy(false); }
  }

  if (done) return (
    <main className="mx-auto max-w-lg px-5 py-16">
      <p className="text-sm font-semibold text-brand">CHECK-IN COMPLETE</p>
      <h1 className="mt-3 text-3xl font-semibold text-ink">Thank you, {firstName(contactName)}.</h1>
      <p className="mt-3 text-body">{preview ? "Preview complete. No answers were sent or saved." : "Your updates have been recorded. You can close this tab."}</p>
      <ul className="mt-7 divide-y divide-line rounded-2xl border border-line bg-surface">
        {items.map((entry, position) => <li key={entry.id} className="px-5 py-4">
          <p className="font-semibold text-ink">{entry.projectName}</p>
          <p className="mt-1 text-sm text-muted">{answers[position].status === "CLOSED_LOST"
            ? `Closed Lost · ${lossReasons.find((reason) => reason.value === answers[position].lossReason)?.label ?? ""}`
            : `Open · ${formatShortDate(answers[position].closeDate)} · ${WIN_PROBABILITIES.find((probability) => probability.stage === answers[position].stage)?.label ?? ""}`}</p>
        </li>)}
      </ul>
    </main>
  );

  return <div className="flex min-h-dvh flex-col">
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-lg items-center justify-between px-5 py-4 text-sm text-muted">
        <button type="button" disabled={!index || busy} onClick={() => goTo(index - 1)} className="font-semibold disabled:invisible">← Back</button>
        <span>Project {index + 1} of {items.length}</span>
      </div>
    </header>
    <main className="mx-auto w-full max-w-lg flex-1 px-5 pb-32 pt-7">
      {preview ? <p className="mb-5 rounded-xl bg-brand-soft px-4 py-3 text-sm text-brand">Fictional preview · nothing is saved · sample loss reasons</p> : null}
      <article key={item.id}>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-ink">{item.projectName}</h1>
        <p className="mt-2 text-sm text-muted">Opportunity created {item.createdDate ? formatShortDate(item.createdDate) : "— date unavailable"}</p>
        <fieldset disabled={busy} className="mt-8">
          <legend className="text-lg font-semibold text-ink">What is the current status?</legend>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {(["OPEN", "CLOSED_LOST"] as const).map((status) => <button key={status} type="button" aria-pressed={answer.status === status} className={choiceStyle(answer.status === status)} onClick={() => update({ status, stage: null, lossReason: "", comment: "", dateConfirmed: false })}>{status === "OPEN" ? "Open" : "Closed Lost"}</button>)}
          </div>
        </fieldset>
        {closing ? <div className="mt-7">
          <label htmlFor="loss-reason" className="text-lg font-semibold text-ink">What is the loss reason?</label>
          <select id="loss-reason" value={answer.lossReason} disabled={busy || !lossReasons.length} onChange={(event) => update({ lossReason: event.target.value, stage: "CLOSED_LOST" })} className="mt-3 min-h-14 w-full rounded-xl border border-line bg-surface px-4 text-ink">
            <option value="">Select a loss reason</option>
            {lossReasons.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
          </select>
          {!lossReasons.length ? <p role="status" className="mt-3 text-sm text-danger">The loss reasons are currently unavailable. Please try again later or contact the sender of your invitation.</p> : null}
        </div> : null}
        {answer.status === "OPEN" ? <div className="mt-7">
          <label htmlFor="close-date" className="text-lg font-semibold text-ink">When do you expect this opportunity to close?</label>
          <input id="close-date" type="date" required value={answer.closeDate} disabled={busy} onChange={(event) => update({ closeDate: event.target.value, dateConfirmed: false, stage: null })} className="mt-3 min-h-14 w-full rounded-xl border border-line bg-surface px-4 text-ink" />
          {!answer.dateConfirmed ? <button type="button" disabled={busy || !validResponseDate(answer.closeDate)} onClick={() => update({ dateConfirmed: true })} className="mt-3 font-semibold text-brand disabled:opacity-40">Confirm date →</button> : null}
          {answer.dateConfirmed && validResponseDate(answer.closeDate) ? <fieldset disabled={busy} className="mt-7">
            <legend className="text-lg font-semibold text-ink">How likely is it that you win the project?</legend>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {WIN_PROBABILITIES.map((probability) => <button key={probability.stage} type="button" aria-pressed={answer.stage === probability.stage} className={choiceStyle(answer.stage === probability.stage)} onClick={() => update({ stage: probability.stage })}>{probability.label}</button>)}
            </div>
          </fieldset> : null}
        </div> : null}
      </article>
    </main>
    <footer className="fixed inset-x-0 bottom-0 border-t border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto max-w-lg px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {error ? <p role="alert" className="mb-3 text-sm text-danger">{error}</p> : null}
        <Button size="lg" disabled={!ready || busy} onClick={handleNext}>{busy ? "Saving…" : index === items.length - 1 ? "Submit updates" : "Next project →"}</Button>
      </div>
    </footer>
  </div>;
}
