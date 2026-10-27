"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatAmount, firstName, formatShortDate, pluralize } from "@/lib/format";
import { OPPORTUNITY_STAGES, isClosedStage, stageLabel, type OpportunityStage } from "@/lib/stages";
import { SubmissionController } from "@/lib/checkin-submission";
import { classifyResponse, failedOutcome, type RequestOutcome } from "@/lib/throttle";
import type { CheckInSessionItem } from "@/server/services/response-service";

type Props = {
  token: string;
  contactName: string;
  items: CheckInSessionItem[];
};

type Answer = { stage: OpportunityStage | null; comment: string; closeDate: string };

/**
 * The external contact's entire experience: land on opportunity 1, tap a
 * status, tap next. No login, no account, no admin chrome, and nothing about
 * how IDS divides these opportunities between its own reps.
 *
 * Two choices keep it at ~60 seconds:
 *   - No welcome screen. The greeting rides along with the first opportunity,
 *     so the emailed link opens straight into the work.
 *   - Answers save in the background while the recipient moves on. Nothing
 *     waits on the network until the final submit, which settles every save
 *     first and reports honestly if any of them failed.
 *
 * A rate limit is treated as its own outcome rather than a generic failure. The
 * old code collapsed every result to `response.ok`, so a 429 produced "check
 * your connection" — blaming the customer's network for a limit we imposed —
 * and the retry fired on the next tap, hitting the limit again. Now the wait is
 * shown and enforced, and the copy says plainly that the unsaved answers live
 * only in this page.
 */
export function CheckInFlow({ token, contactName, items }: Props) {
  const [answers, setAnswers] = useState<Answer[]>(() =>
    items.map((item) => ({
      stage: item.selectedStage,
      comment: item.comment,
      closeDate: item.selectedCloseDate ?? item.currentCloseDate ?? "",
    })),
  );

  const firstUnanswered = answers.findIndex((answer) => answer.stage === null);
  const [index, setIndex] = useState(firstUnanswered === -1 ? items.length - 1 : firstUnanswered);
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** Epoch ms until which the server asked us to hold off, or null. */
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const noteRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Latest answers, readable from the transport.
   *
   * A retry must send the answer as it stands NOW, not the value captured when
   * the first attempt was queued — otherwise a recipient who edits while
   * throttled has their correction silently dropped.
   */
  const controllerRef = useRef<SubmissionController | null>(null);
  const answersRef = useRef(answers);
  // Written in an effect, not during render: the transport only reads it from
  // an event handler, which always runs after the effect for that render.
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  /**
   * The save / wait / retry / complete state machine.
   *
   * Lives in @/lib/checkin-submission so it can be driven directly by tests.
   * Keeping it inline here is what allowed a retry-coordination defect to ship:
   * an earlier throttled answer was never re-sent, so the check-in could never
   * finish and no string assertion over this file could have noticed.
   */

  // Ticks the visible countdown and releases the button when it expires. The
  // recipient never has to reload to recover.
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

  const item = items[index];
  const answer = answers[index];
  const isLast = index === items.length - 1;
  const resuming = firstUnanswered > 0;
  // Closing a project is the one answer that must come with an explanation.
  // The note opens automatically, is labelled as required, and gates the
  // button - so the requirement is visible before the tap, not after it.
  const closing = isClosedStage(answer.stage);
  const reasonMissing = closing && answer.comment.trim().length === 0;
  const showNote = noteOpen || closing || answer.comment.length > 0;

  function update(patch: Partial<Answer>) {
    setAnswers((current) =>
      current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
    setError(null);
  }

  /** One POST. Never reads the body — a WAF 429 is often HTML, not JSON. */
  function postAnswer(position: number, value: Answer): Promise<RequestOutcome> {
    return fetch(`/api/checkin/${token}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        itemId: items[position].id,
        stage: value.stage,
        comment: value.comment.trim() || null,
        // Only send a revised date when it actually differs from the one we
        // showed them, so "unchanged" stays distinguishable from "confirmed".
        closeDate:
          value.closeDate && value.closeDate !== items[position].currentCloseDate
            ? value.closeDate
            : null,
      }),
    })
      .then((response) => classifyResponse(response))
      .catch(failedOutcome);
  }

  // Declared as plain functions so the ref is read when a request is actually
  // sent, never during render.
  /** Identifies an answer's VALUE, so an unchanged one is never re-sent. */
  function answerKeyAt(position: number): string {
    const a = answersRef.current[position];
    return `${a.stage ?? ""}|${a.comment.trim()}|${a.closeDate}`;
  }

  function sendAnswerAt(position: number): Promise<RequestOutcome> {
    return postAnswer(position, answersRef.current[position]);
  }
  function sendCompletion(): Promise<RequestOutcome> {
    return fetch(`/api/checkin/${token}/complete`, { method: "POST" })
      .then((response) => classifyResponse(response))
      .catch(failedOutcome);
  }

  /**
   * Built on first use from an event handler, never during render — the
   * controller is not needed to render anything, and constructing it in render
   * would mean reading a ref there.
   */
  function getController(): SubmissionController {
    if (controllerRef.current === null) {
      controllerRef.current = new SubmissionController(items.length, {
        now: () => Date.now(),
        sendAnswer: sendAnswerAt,
        sendCompletion,
      });
      controllerRef.current.describeAnswer = answerKeyAt;
    }
    return controllerRef.current;
  }


  function goTo(next: number) {
    setIndex(next);
    setNoteOpen(false);
    setError(null);
    window.scrollTo({ top: 0 });
  }

  async function handleNext() {
    if (!answer.stage || reasonMissing || waiting) return;

    void getController().queueSave(index, answerKeyAt(index));

    if (!isLast) {
      goTo(index + 1);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await submit();
    } finally {
      // Always releases the button, including on an unexpected throw, so a
      // failure can never leave the recipient stuck on "Submitting…".
      setBusy(false);
    }
  }

  async function submit() {
    const result = await getController().submit();

    if (result.kind === "done") {
      setDone(true);
      window.scrollTo({ top: 0 });
      return;
    }

    if (result.kind === "waiting") {
      setWaitUntil(result.until);
      // Two messages on purpose. While answers are still pending this page is
      // the only copy of them, and saying so is the honest thing. Once they are
      // stored, warning about losing them would be needlessly alarming.
      setError(
        result.pendingAnswers
          ? "Too many requests just now. Please wait, then tap submit again — and keep this page open so you don't lose your unsaved answers."
          : "Your answers are saved. Too many requests just now — please wait, then tap submit again.",
      );
      return;
    }

    setError(
      result.pendingAnswers
        ? "We couldn't save every answer. Check your connection and tap submit again."
        : "We saved your answers but couldn't submit. Please tap submit again.",
    );
  }

  if (done) {
    return <Complete contactName={contactName} items={items} answers={answers} />;
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto w-full max-w-lg px-5 py-2.5">
          <div className="flex items-center justify-between text-[13px] font-medium text-muted">
            <button
              type="button"
              onClick={() => goTo(Math.max(0, index - 1))}
              disabled={index === 0 || busy}
              className="-ml-1 rounded-lg px-1 py-0.5 transition-colors hover:text-ink disabled:invisible"
            >
              ← Back
            </button>
            <span className="tabular-nums">
              {index + 1} of {items.length}
            </span>
          </div>
          <div
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line"
            role="progressbar"
            aria-valuenow={index + 1}
            aria-valuemin={1}
            aria-valuemax={items.length}
            aria-label="Check-in progress"
          >
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-300"
              style={{ width: `${((index + 1) / items.length) * 100}%` }}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg flex-1 px-5 pb-32 pt-3">
        {index === 0 ? (
          <div className="mb-2.5 border-b border-line pb-2.5">
            <p className="text-[18px] font-semibold tracking-tight text-ink">
              Hi {firstName(contactName)} <span aria-hidden>👋</span>
            </p>
            <p className="mt-0.5 text-[14px] text-muted">
              {resuming
                ? `Picking up where you left off — ${items.length - firstUnanswered} left.`
                : `We found ${items.length} open ${pluralize(items.length, "opportunity", "opportunities")} associated with your organization. About 60 seconds.`}
            </p>
          </div>
        ) : null}

        <article key={item.id}>
          <h1 className="text-[23px] font-semibold leading-tight tracking-tight text-ink">
            {item.customerName}
          </h1>
          <p className="mt-0.5 text-[16px] text-body">{item.projectName}</p>

          <dl className="mt-2.5 flex gap-2.5">
            <div className="flex-1 rounded-xl border border-line bg-surface px-3.5 py-2">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                Opportunity
              </dt>
              <dd className="mt-0.5 text-[17px] font-semibold tabular-nums text-ink">
                {formatAmount(item.amount)}
              </dd>
            </div>
            <div className="flex-1 rounded-xl border border-line bg-surface px-3.5 py-2">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                Current status
              </dt>
              <dd className="mt-0.5 text-[17px] font-semibold text-ink">
                {stageLabel(item.currentStage)}
              </dd>
            </div>
          </dl>

          {item.currentCloseDate ? (
            <div className="mt-2.5 rounded-xl border border-line bg-surface px-3.5 py-2.5">
              <label
                htmlFor={`close-${item.id}`}
                className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted"
              >
                Expected completion
              </label>
              <input
                id={`close-${item.id}`}
                type="date"
                value={answer.closeDate}
                onChange={(event) => update({ closeDate: event.target.value })}
                className="mt-1 w-full bg-transparent text-[17px] font-semibold text-ink focus:outline-none"
              />
              {answer.closeDate !== item.currentCloseDate ? (
                <p className="mt-1 text-[12px] font-medium text-brand">
                  Updated from {formatShortDate(item.currentCloseDate)}
                </p>
              ) : (
                <p className="mt-1 text-[12px] text-muted">Change it if this has moved.</p>
              )}
            </div>
          ) : null}

          <h2 className="mt-3 text-[16px] font-semibold tracking-tight text-ink">
            What&apos;s the current status?
          </h2>

          <div className="mt-2.5 grid gap-2">
            {OPPORTUNITY_STAGES.map((stage) => {
              const selected = answer.stage === stage.value;
              const isCurrent = item.currentStage === stage.value;
              return (
                <button
                  key={stage.value}
                  type="button"
                  onClick={() => update({ stage: stage.value })}
                  aria-pressed={selected}
                  className={`flex min-h-[54px] w-full items-center justify-between gap-3 rounded-2xl border-2 px-5 text-left transition-colors ${
                    selected
                      ? "border-brand bg-brand-soft"
                      : "border-line bg-surface hover:border-line-strong"
                  }`}
                >
                  <span
                    className={`text-[17px] font-semibold ${selected ? "text-brand" : "text-ink"}`}
                  >
                    {stage.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {isCurrent ? (
                      <span className="rounded-full border border-line-strong bg-canvas px-2 py-0.5 text-[11px] font-semibold text-muted">
                        Current
                      </span>
                    ) : null}
                    <span
                      className={`flex size-6 items-center justify-center rounded-full border-2 ${
                        selected ? "border-brand bg-brand" : "border-line-strong"
                      }`}
                    >
                      {selected ? (
                        <svg viewBox="0 0 20 20" className="size-3.5 fill-white" aria-hidden>
                          <path d="M7.6 13.3 4.3 10l-1.1 1.1 4.4 4.4 9-9-1.1-1.1z" />
                        </svg>
                      ) : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {showNote ? (
            <div className="mt-4">
              <label htmlFor="note" className="text-[14px] font-semibold text-ink">
                {closing ? "Why did this project end?" : "Anything we should know?"}
              </label>
              <textarea
                id="note"
                ref={noteRef}
                value={answer.comment}
                onChange={(event) => update({ comment: event.target.value })}
                rows={3}
                maxLength={1000}
                placeholder={
                  closing
                    ? "Budget cut, lost to another vendor, project cancelled…"
                    : "Optional — waiting on the construction schedule…"
                }
                className="mt-1.5 w-full resize-none rounded-2xl border border-line bg-surface px-4 py-3 text-[16px] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setNoteOpen(true);
                requestAnimationFrame(() => noteRef.current?.focus());
              }}
              className="mt-4 text-[14px] font-semibold text-brand"
            >
              + Add a note
            </button>
          )}
        </article>
      </main>

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto w-full max-w-lg px-5 pb-[max(0.875rem,env(safe-area-inset-bottom))] pt-3">
          {error ? (
            <p className="mb-2.5 rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] font-medium text-danger">
              {error}
            </p>
          ) : null}
          <Button
            size="lg"
            onClick={handleNext}
            disabled={!answer.stage || reasonMissing || busy || waiting}
          >
            {waiting
              ? `Please wait ${secondsLeft}s…`
              : busy
                ? "Submitting…"
                : isLast
                  ? "SUBMIT"
                  : "NEXT →"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Complete({
  contactName,
  items,
  answers,
}: {
  contactName: string;
  items: CheckInSessionItem[];
  answers: Answer[];
}) {
  const [dismissed, setDismissed] = useState(false);
  const changed = items.filter(
    (item, i) =>
      answers[i].stage !== item.currentStage ||
      (answers[i].closeDate && answers[i].closeDate !== item.currentCloseDate),
  );

  return (
    <main className="mx-auto w-full max-w-lg px-6 py-12">
      <div className="flex size-14 items-center justify-center rounded-full bg-success-soft">
        <svg viewBox="0 0 20 20" className="size-7 fill-success" aria-hidden>
          <path d="M7.6 13.3 4.3 10l-1.1 1.1 4.4 4.4 9-9-1.1-1.1z" />
        </svg>
      </div>

      <h1 className="mt-5 text-[28px] font-semibold leading-tight tracking-tight text-ink">
        You&apos;re done <span aria-hidden>🎉</span>
      </h1>
      <p className="mt-3 text-[17px] text-body">
        Thanks, {firstName(contactName)}. Your {items.length} opportunity{" "}
        {pluralize(items.length, "update")} {items.length === 1 ? "has" : "have"} been recorded.
      </p>

      {changed.length > 0 ? (
        <div className="mt-7">
          <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted">
            {changed.length} {pluralize(changed.length, "update")} recorded
          </p>
          <ul className="mt-2.5 divide-y divide-line rounded-card border border-line bg-surface">
            {changed.map((item) => {
              const i = items.indexOf(item);
              return (
                <li key={item.id} className="px-4 py-3">
                  <div className="text-[15px] font-medium text-ink">{item.customerName}</div>
                  {answers[i].stage !== item.currentStage ? (
                    <div className="mt-0.5 text-[13px] text-muted">
                      {stageLabel(item.currentStage)} <span aria-hidden>→</span>{" "}
                      <span className="font-semibold text-body">{stageLabel(answers[i].stage)}</span>
                    </div>
                  ) : null}
                  {answers[i].closeDate && answers[i].closeDate !== item.currentCloseDate ? (
                    <div className="mt-0.5 text-[13px] text-muted">
                      Completion {formatShortDate(item.currentCloseDate)} <span aria-hidden>→</span>{" "}
                      <span className="font-semibold text-body">
                        {formatShortDate(answers[i].closeDate)}
                      </span>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="mt-9">
        {dismissed ? (
          <p className="text-[15px] font-medium text-success">
            Submitted — you can close this tab.
          </p>
        ) : (
          <Button
            size="lg"
            onClick={() => {
              // A tab the page did not open cannot close itself on mobile, so
              // fall back to an explicit acknowledgement instead of doing nothing.
              window.close();
              setDismissed(true);
            }}
          >
            DONE
          </Button>
        )}
      </div>
    </main>
  );
}
