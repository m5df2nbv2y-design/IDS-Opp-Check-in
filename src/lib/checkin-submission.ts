import { isUnsaved, type RequestOutcome } from "@/lib/throttle";

/**
 * The save / wait / retry / complete state machine for a recipient check-in.
 *
 * Extracted from the React component deliberately. The first attempt at
 * throttle handling put this logic inline and shipped a bug that only appears
 * with more than one opportunity: an EARLIER item was throttled, the final item
 * saved cleanly, and submit then started a countdown without ever re-queueing
 * the throttled one. Every later submit re-read the same stale 429 and started
 * the countdown again, so that answer could never be saved and the check-in
 * could never finish. String assertions over the component source could not
 * have caught it. A plain object with injected transport and clock can be
 * driven directly by tests, so it is.
 *
 * Two rules the machine exists to enforce:
 *
 *   1. A throttle is a DEADLINE, not a delay. It is set the moment a 429 is
 *      received — not when submit happens to look — and every later request
 *      checks it. A deadline already in the past imposes no wait, so a
 *      recipient who waited is not made to wait again.
 *   2. A retry after the deadline re-sends every still-unsaved answer ONCE,
 *      using its current value, waits for those results, and only then tries to
 *      complete. Answers already stored are never re-sent.
 */

export type SubmissionTransport = {
  /** Send the CURRENT answer for this position. Never throws. */
  sendAnswer(position: number): Promise<RequestOutcome>;
  /** Attempt completion. Never throws. */
  sendCompletion(): Promise<RequestOutcome>;
  /** Injected so tests control time rather than sleeping. */
  now(): number;
};

export type SubmitResult =
  /** Finished. The check-in is complete. */
  | { kind: "done" }
  /**
   * Held by a rate limit. `until` is an absolute epoch-ms deadline.
   * `pendingAnswers` is false when every answer is already stored and only
   * completion is being held — which gets different, calmer copy.
   */
  | { kind: "waiting"; until: number; pendingAnswers: boolean }
  /** Something failed that waiting will not fix. */
  | { kind: "failed"; pendingAnswers: boolean };

export class SubmissionController {
  private readonly outcomes: (RequestOutcome | null)[];
  private readonly chains: Promise<void>[];
  private readonly sequence: number[];
  /** Absolute epoch-ms. Null when no limit is in force. */
  private deadline: number | null = null;

  constructor(
    private readonly itemCount: number,
    private readonly transport: SubmissionTransport,
  ) {
    this.outcomes = Array.from({ length: itemCount }, () => null);
    this.chains = Array.from({ length: itemCount }, () => Promise.resolve());
    this.sequence = Array.from({ length: itemCount }, () => 0);
  }

  /** Milliseconds still to wait, or 0. An elapsed deadline imposes nothing. */
  remainingWait(): number {
    if (this.deadline === null) return 0;
    const left = this.deadline - this.transport.now();
    if (left <= 0) {
      this.deadline = null;
      return 0;
    }
    return left;
  }

  isWaiting(): boolean {
    return this.remainingWait() > 0;
  }

  /** The active deadline, or null. Exposed so the UI can show a countdown. */
  waitingUntil(): number | null {
    return this.remainingWait() > 0 ? this.deadline : null;
  }

  /**
   * Record a throttle as an absolute deadline.
   *
   * Applied even when the response belongs to a SUPERSEDED request: the limit
   * is a property of the transport, not of that answer, so discarding it
   * because a newer edit exists would let the next save ignore a live limit.
   * Only ever extends — a later, shorter deadline must not shorten a longer one.
   */
  private noteOutcome(outcome: RequestOutcome) {
    if (outcome.kind !== "throttled") return;
    const until = this.transport.now() + outcome.retryAfterSeconds * 1000;
    this.deadline = this.deadline === null ? until : Math.max(this.deadline, until);
  }

  /**
   * Queue a save for one item, behind anything already in flight for it.
   *
   * Serialised per item so two writes for the same answer are never in flight
   * together and a slow earlier write cannot land after a newer edit.
   */
  queueSave(position: number): Promise<void> {
    const seq = (this.sequence[position] ?? 0) + 1;
    this.sequence[position] = seq;
    this.outcomes[position] = null;

    const chained = this.chains[position]
      .catch(() => undefined)
      .then(async () => {
        // A limit learned while this was queued applies to it too. Without this
        // check a queue of saves keeps firing into a limiter that has already
        // said stop.
        if (this.isWaiting()) {
          this.outcomes[position] = { kind: "throttled", retryAfterSeconds: 0 };
          return;
        }

        const outcome = await this.transport.sendAnswer(position);
        this.noteOutcome(outcome);

        // A newer edit is authoritative, so this result is not recorded as that
        // item's state — but its throttle was already noted above.
        if (this.sequence[position] !== seq) return;
        this.outcomes[position] = outcome;
      });

    this.chains[position] = chained;
    return chained;
  }

  /** Positions whose current answer is not confirmed stored on the server. */
  private unsavedPositions(): number[] {
    const unsaved: number[] = [];
    for (let position = 0; position < this.itemCount; position += 1) {
      const outcome = this.outcomes[position];
      if (outcome === null || isUnsaved(outcome)) unsaved.push(position);
    }
    return unsaved;
  }

  private settle(): Promise<void[]> {
    return Promise.all(this.chains.map((chain) => chain.catch(() => undefined))) as Promise<void[]>;
  }

  /**
   * One submit attempt, driven by the recipient's tap.
   *
   * Retries are deliberately NOT automatic: an automatic retry into a live
   * limit is how a client produces a flood. The tap is the backoff.
   */
  async submit(): Promise<SubmitResult> {
    await this.settle();

    if (this.isWaiting()) {
      return {
        kind: "waiting",
        until: this.deadline!,
        pendingAnswers: this.unsavedPositions().length > 0,
      };
    }

    // The fix for the blocking defect: every still-unsaved answer is re-sent
    // once, with its CURRENT value. The previous version re-queued only when
    // nothing was throttled, so a throttled item was never retried at all.
    let unsaved = this.unsavedPositions();
    if (unsaved.length > 0) {
      await Promise.all(unsaved.map((position) => this.queueSave(position)));
      await this.settle();
      unsaved = this.unsavedPositions();
    }

    if (unsaved.length > 0) {
      if (this.isWaiting()) {
        return { kind: "waiting", until: this.deadline!, pendingAnswers: true };
      }
      return { kind: "failed", pendingAnswers: true };
    }

    // Every answer is stored. Completion is its own request — and a throttle
    // here must NOT re-send answers that already succeeded.
    const completion = await this.transport.sendCompletion();
    this.noteOutcome(completion);

    if (completion.kind === "throttled") {
      return { kind: "waiting", until: this.deadline!, pendingAnswers: false };
    }
    if (completion.kind !== "ok") {
      return { kind: "failed", pendingAnswers: false };
    }
    return { kind: "done" };
  }
}
