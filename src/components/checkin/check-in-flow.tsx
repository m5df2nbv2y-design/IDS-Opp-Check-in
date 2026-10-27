"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { firstName, formatShortDate } from "@/lib/format";
import { WIN_PROBABILITIES, validResponseDate, type LossReasonOption, type RecipientOpportunity } from "@/lib/client-response";
import { SubmissionController } from "@/lib/checkin-submission";
import { classifyResponse, failedOutcome, type RequestOutcome } from "@/lib/throttle";
import type { OpportunityStage } from "@/lib/stages";

/**
 * The external contact's entire experience.
 *
 * Two designs meet here, deliberately rather than by merge resolution.
 *
 * The CLIENT RESPONSE V2 flow decides what is asked: project name and the
 * original Salesforce creation date, status as Open or Closed Lost, a required
 * loss reason, an explicitly confirmed close date, and a win probability shown
 * only as a percentage. Opportunity value and the existing Salesforce stage are
 * never sent to this component, so they cannot be displayed.
 *
 * The SUBMISSION CONTROLLER decides how an answer reaches the server. That
 * behaviour was verified in a browser against genuine 429s, and is kept intact:
 * a rate limit is distinguished from a network or validation failure even when
 * the body is HTML, Retry-After is honoured within bounds, an elapsed deadline
 * imposes no further wait, and an answer already stored unchanged is never
 * re-sent — including when only completion needs retrying.
 *
 * V2 saves BEFORE advancing, which is the stricter contract: the recipient
 * cannot move past an answer the server has not accepted. That removes the
 * multi-item recovery problem by construction — there is never more than one
 * outstanding answer — but it makes honest failure reporting more important,
 * not less, because the recipient is held in place when a save does not land.
 */

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

function answerKey(value: Answer): string {
  return JSON.stringify([value.status, value.stage, value.closeDate, value.lossReason, value.comment.trim()]);
}

const choiceStyle = (selected: boolean) => `min-h-14 rounded-2xl border-2 px-5 py-3 text-left text-[17px] font-semibold transition-colors ${selected ? "border-white bg-brand text-white" : "border-white/70 bg-[#173f6d] text-white hover:bg-[#235485]"}`;

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
  /** Epoch ms until which the server asked us to hold off, or null. */
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const item = items[index];
  const answer = answers[index];
  const closing = answer.status === "CLOSED_LOST";
  const ready = closing
    ? lossReasons.some((reason) => reason.value === answer.lossReason)
    : answer.status === "OPEN" && validResponseDate(answer.closeDate) && answer.dateConfirmed && !!answer.stage;

  const controllerRef = useRef<SubmissionController | null>(null);
  const answersRef = useRef(answers);
  const restoredAnswers = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  // Ticks the visible countdown and releases the button when it expires, so a
  // throttled recipient recovers without reloading.
  useEffect(() => {
    if (waitUntil === null) return;
    function tick() {
      const remaining = Math.ceil((waitUntil! - Date.now()) / 1000);
      if (remaining <= 0) {
        setWaitUntil(null);
        setSecondsLeft(0);
        return;
      }
      setSecondsLeft(remaining);
    }
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [waitUntil]);

  const waiting = waitUntil !== null;

  /** Identifies an answer's VALUE, so an unchanged one is never re-sent. */
  function answerKeyAt(position: number): string {
    return answerKey(answersRef.current[position]);
  }

  /** One POST. Never reads the body — a WAF 429 is often HTML, not JSON. */
  function sendAnswerAt(position: number): Promise<RequestOutcome> {
    const value = answersRef.current[position];
    const shut = value.status === "CLOSED_LOST";
    const reasonLabel = lossReasons.find((reason) => reason.value === value.lossReason)?.label;
    return fetch(`/api/checkin/${token}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowVersion: 2,
        itemId: items[position].id,
        stage: shut ? "CLOSED_LOST" : value.stage,
        lossReason: shut ? value.lossReason : null,
        comment: shut ? reasonLabel : value.comment.trim() || null,
        closeDate: shut ? null : value.closeDate,
      }),
    })
      .then((response) => classifyResponse(response))
      .catch(failedOutcome);
  }

  function sendCompletion(): Promise<RequestOutcome> {
    return fetch(`/api/checkin/${token}/complete`, { method: "POST" })
      .then((response) => classifyResponse(response))
      .catch(failedOutcome);
  }

  /** Built on first use from an event handler, never during render. */
  function getController(): SubmissionController {
    if (controllerRef.current === null) {
      controllerRef.current = new SubmissionController(items.length, {
        now: () => Date.now(),
        sendAnswer: sendAnswerAt,
        sendCompletion,
      });
      controllerRef.current.describeAnswer = answerKeyAt;
      items.forEach((saved, position) => {
        if (saved.selectedStage) controllerRef.current!.restoreSavedAnswer(position, answerKey(restoredAnswers.current[position]));
      });
    }
    return controllerRef.current;
  }

  function update(patch: Partial<Answer>) {
    setAnswers((current) => current.map((entry, position) => position === index ? { ...entry, ...patch } : entry));
    setError(null);
  }

  function goTo(position: number) {
    setIndex(position);
    setError(null);
    window.scrollTo({ top: 0 });
  }

  /**
   * Report an answer that did not reach the server.
   *
   * The recipient stays on this project either way. A rate limit gets the wait
   * and a plain explanation; anything else gets the ordinary retry message.
   * Neither claims the answer is stored, because it is not.
   */
  function reportUnsaved(outcome: RequestOutcome | null) {
    if (outcome?.kind === "throttled") {
      setWaitUntil(getController().waitingUntil());
      setError("Too many requests just now. Please wait, then try again — and keep this page open so you don't lose this answer.");
      return;
    }
    setError(
      closing
        ? "We couldn’t save this answer. Please try again. If the loss reasons look out of date, reload to refresh them."
        : "We couldn’t save this answer. Please check your connection and try again.",
    );
  }

  async function handleNext() {
    if (!ready || busy || waiting) return;
    setBusy(true);
    setError(null);
    try {
      // The fictional preview never calls an API, so it advances locally.
      if (preview) {
        if (index < items.length - 1) { goTo(index + 1); return; }
        setDone(true);
        window.scrollTo({ top: 0 });
        return;
      }

      const controller = getController();

      // Save BEFORE advancing. An unchanged answer that is already stored is
      // skipped inside the controller, so tapping again after a throttled
      // COMPLETION does not re-send it.
      await controller.queueSave(index, answerKeyAt(index));
      const outcome = controller.outcomeOf(index);
      if (outcome?.kind !== "ok") {
        reportUnsaved(outcome);
        return;
      }

      if (index < items.length - 1) {
        goTo(index + 1);
        return;
      }

      const result = await controller.submit();
      if (result.kind === "done") {
        setDone(true);
        window.scrollTo({ top: 0 });
        return;
      }
      if (result.kind === "waiting") {
        setWaitUntil(result.until);
        // Two messages on purpose. Once every answer is stored, warning about
        // losing them would be untrue as well as alarming.
        setError(
          result.pendingAnswers
            ? "Too many requests just now. Please wait, then try again — and keep this page open so you don't lose your unsaved answers."
            : "Your answers are saved. Too many requests just now — please wait, then submit again.",
        );
        return;
      }
      setError(
        result.pendingAnswers
          ? "We couldn’t save every answer. Please check your connection and try again."
          : "Your answers were saved, but we couldn’t submit the check-in. Please try again.",
      );
    } finally {
      // Always releases the button, so a failure cannot strand the recipient.
      setBusy(false);
    }
  }

  if (done) return (
    <main className="ids-recipient-message mx-auto max-w-lg px-6 py-9">
      <p className="text-sm font-semibold text-white">CHECK-IN COMPLETE</p>
      <h1 className="mt-3 text-3xl font-semibold text-ink">Thank you, {firstName(contactName)}.</h1>
      <p className="mt-3 text-body">{preview ? "Preview complete. No answers were sent or saved." : "Your updates have been recorded. You can close this tab."}</p>
      <ul className="mt-7 divide-y divide-line">
        {items.map((entry, position) => <li key={entry.id} className="px-5 py-4">
          <p className="font-semibold text-ink">{entry.projectName}</p>
          <p className="mt-1 text-sm text-muted">{answers[position].status === "CLOSED_LOST"
            ? `Closed Lost · ${lossReasons.find((reason) => reason.value === answers[position].lossReason)?.label ?? ""}`
            : `Open · ${formatShortDate(answers[position].closeDate)} · ${WIN_PROBABILITIES.find((probability) => probability.stage === answers[position].stage)?.label ?? ""}`}</p>
        </li>)}
      </ul>
    </main>
  );

  return <div className="ids-recipient-flow flex flex-col">
    <header className="mx-auto w-full max-w-lg px-5">
      <div className="ids-recipient-panel mx-auto flex items-center justify-between px-5 py-3 text-sm text-muted">
        <button type="button" disabled={!index || busy} onClick={() => goTo(index - 1)} className="font-semibold disabled:invisible">← Back</button>
        <span>Project {index + 1} of {items.length}</span>
      </div>
    </header>
    <main className="mx-auto w-full max-w-lg flex-1 px-5 pb-32 pt-3">
      {preview ? <p className="mb-5 text-sm text-white/85">Fictional preview · nothing is saved · sample loss reasons</p> : null}
      <article key={item.id} className="ids-recipient-panel p-5 sm:p-7">
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-ink">{item.projectName}</h1>
        <p className="mt-2 text-sm text-muted">Opportunity created {item.createdDate ? formatShortDate(item.createdDate) : "— date unavailable"}</p>
        <fieldset disabled={busy} className="mt-8">
          <legend className="text-lg font-semibold text-ink">What is the current status?</legend>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {(["OPEN", "CLOSED_LOST"] as const).map((status) => <button key={status} type="button" aria-pressed={answer.status === status} className={choiceStyle(answer.status === status)} onClick={() => { if (answer.status !== status) update({ status, stage: null, lossReason: "", comment: "", closeDate: status === "OPEN" ? item.currentCloseDate ?? "" : "", dateConfirmed: false }); }}>{status === "OPEN" ? "Open" : "Closed Lost"}</button>)}
          </div>
        </fieldset>
        {closing ? <div className="mt-7">
          <label htmlFor="loss-reason" className="text-lg font-semibold text-ink">What is the loss reason?</label>
          <select id="loss-reason" value={answer.lossReason} disabled={busy || !lossReasons.length} onChange={(event) => update({ lossReason: event.target.value, stage: "CLOSED_LOST" })} className="mt-3 min-h-14 w-full rounded-xl border border-white/70 bg-transparent px-4 text-white">
            <option value="">Select a loss reason</option>
            {lossReasons.map((reason) => <option key={reason.value} value={reason.value}>{reason.label}</option>)}
          </select>
          {!lossReasons.length ? <p role="status" className="mt-3 text-sm text-danger">The loss reasons are currently unavailable. Please try again later or contact the sender of your invitation.</p> : null}
        </div> : null}
        {answer.status === "OPEN" ? <div className="mt-7">
          <label htmlFor="close-date" className="text-lg font-semibold text-ink">When do you expect this opportunity to close?</label>
          <input id="close-date" type="date" required value={answer.closeDate} disabled={busy} onChange={(event) => update({ closeDate: event.target.value, dateConfirmed: false, stage: null })} className="mt-3 min-h-14 w-full rounded-xl border border-white/70 bg-transparent px-4 text-white" />
          {!answer.dateConfirmed ? <button type="button" disabled={busy || !validResponseDate(answer.closeDate)} onClick={() => update({ dateConfirmed: true })} className="mt-3 rounded-xl border border-white/60 bg-[#173f6d] px-4 py-3 font-semibold text-white hover:bg-[#235485] disabled:opacity-40">Confirm date →</button> : null}
          {answer.dateConfirmed && validResponseDate(answer.closeDate) ? <fieldset disabled={busy} className="mt-7">
            <legend className="text-lg font-semibold text-ink">How likely is it that you win the project?</legend>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {WIN_PROBABILITIES.map((probability) => <button key={probability.stage} type="button" aria-pressed={answer.stage === probability.stage} className={choiceStyle(answer.stage === probability.stage)} onClick={() => update({ stage: probability.stage })}>{probability.label}</button>)}
            </div>
          </fieldset> : null}
        </div> : null}
      </article>
    </main>
    <footer className="ids-recipient-footer fixed inset-x-0 bottom-0">
      <div className="mx-auto max-w-lg px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {error ? <p role="alert" className="mb-3 text-sm text-danger">{error}</p> : null}
        <Button size="lg" disabled={!ready || busy || waiting} onClick={handleNext}>
          {waiting ? `Please wait ${secondsLeft}s…` : busy ? "Saving…" : index === items.length - 1 ? "Submit updates" : "Next project →"}
        </Button>
      </div>
    </footer>
  </div>;
}
