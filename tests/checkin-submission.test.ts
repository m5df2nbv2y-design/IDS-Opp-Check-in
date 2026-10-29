import { beforeEach, describe, expect, it } from "vitest";
import { SubmissionController, type SubmissionTransport } from "@/lib/checkin-submission";
import type { RequestOutcome } from "@/lib/throttle";

/**
 * The save / wait / retry / complete state machine, driven directly.
 *
 * These exist because string assertions over the component could not catch the
 * defect that shipped in 2d55ca2: with more than one opportunity, an EARLIER
 * throttled item was never re-queued, so every later submit re-read the same
 * stale 429 and restarted the countdown forever. Case 1 reproduces exactly
 * that, and fails against the old control flow.
 *
 * Transport and clock are injected, so nothing sleeps and nothing touches the
 * network.
 */

type Scripted = RequestOutcome | "ok" | "throttle" | "fail";

function outcome(value: Scripted, seconds = 10): RequestOutcome {
  if (value === "ok") return { kind: "ok" };
  if (value === "fail") return { kind: "failed", status: null };
  if (value === "throttle") return { kind: "throttled", retryAfterSeconds: seconds };
  return value;
}

/** A transport whose answers are scripted per position and per attempt. */
class FakeTransport implements SubmissionTransport {
  clock = 1_000_000;
  /** position -> queue of scripted results; the last one repeats. */
  answerScript = new Map<number, Scripted[]>();
  completionScript: Scripted[] = ["ok"];
  /** Every request, in order. */
  log: string[] = [];

  now() {
    return this.clock;
  }

  advance(seconds: number) {
    this.clock += seconds * 1000;
  }

  scriptAnswer(position: number, ...results: Scripted[]) {
    this.answerScript.set(position, [...results]);
  }

  async sendAnswer(position: number): Promise<RequestOutcome> {
    this.log.push(`save:${position}`);
    const queue = this.answerScript.get(position) ?? ["ok"];
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return outcome(next);
  }

  async sendCompletion(): Promise<RequestOutcome> {
    this.log.push("complete");
    const next = this.completionScript.length > 1
      ? this.completionScript.shift()!
      : this.completionScript[0];
    return outcome(next);
  }

  countOf(entry: string) {
    return this.log.filter((item) => item === entry).length;
  }
}

describe("CASE 1 — an earlier throttled answer still recovers", () => {
  let transport: FakeTransport;
  let controller: SubmissionController;

  beforeEach(() => {
    transport = new FakeTransport();
    controller = new SubmissionController(2, transport);
  });

  it("REGRESSION: retries the earlier item, not just the last one", async () => {
    // The exact shape of the shipped bug: item 0 is throttled, item 1 saves.
    transport.scriptAnswer(0, "throttle", "ok");
    transport.scriptAnswer(1, "ok");

    await controller.queueSave(0);
    await controller.queueSave(1);

    const first = await controller.submit();
    expect(first.kind).toBe("waiting");
    if (first.kind === "waiting") expect(first.pendingAnswers).toBe(true);

    // The recipient waits, exactly as told, then taps submit again.
    transport.advance(10);
    const second = await controller.submit();

    // Against 2d55ca2 this was never reached: item 0 kept its stale throttled
    // outcome, was never re-sent, and submit started another countdown.
    expect(second).toEqual({ kind: "done" });
    expect(transport.countOf("save:0")).toBe(2);
    expect(transport.countOf("complete")).toBe(1);
  });

  it("does not resend the answer that already succeeded", async () => {
    transport.scriptAnswer(0, "throttle", "ok");
    transport.scriptAnswer(1, "ok");

    await controller.queueSave(0);
    await controller.queueSave(1);
    await controller.submit();
    transport.advance(10);
    await controller.submit();

    // Item 1 was stored on its first attempt and must not be sent again.
    expect(transport.countOf("save:1")).toBe(1);
  });
});

describe("CASE 2 — a deadline learned in the background is respected", () => {
  it("blocks queued saves issued after a 429 arrives, then recovers", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(3, transport);

    transport.scriptAnswer(0, "throttle", "ok");
    transport.scriptAnswer(1, "ok");
    transport.scriptAnswer(2, "ok");

    // Item 0 is throttled while the recipient is still moving through the flow.
    await controller.queueSave(0);
    expect(controller.isWaiting()).toBe(true);

    // Saves queued AFTER that must not fire into a limiter that already said
    // stop. 2d55ca2 established the wait only inside submit, so these went out.
    await controller.queueSave(1);
    await controller.queueSave(2);
    expect(transport.countOf("save:1")).toBe(0);
    expect(transport.countOf("save:2")).toBe(0);

    const held = await controller.submit();
    expect(held.kind).toBe("waiting");

    transport.advance(10);
    const after = await controller.submit();
    expect(after).toEqual({ kind: "done" });
    // Each item eventually stored, without a reload or repeated tapping.
    expect(transport.countOf("save:1")).toBe(1);
    expect(transport.countOf("save:2")).toBe(1);
  });

  it("does not restart an elapsed deadline, so waiting is never doubled", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "throttle", "ok");

    await controller.queueSave(0);
    const first = await controller.submit();
    expect(first.kind).toBe("waiting");
    const deadline = first.kind === "waiting" ? first.until : 0;

    // Time passes beyond the deadline: no further wait may be imposed.
    transport.advance(10);
    expect(controller.isWaiting()).toBe(false);
    expect(controller.remainingWait()).toBe(0);
    expect(transport.now()).toBeGreaterThanOrEqual(deadline);

    expect(await controller.submit()).toEqual({ kind: "done" });
  });

  it("extends, never shortens, an existing deadline", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(2, transport);
    transport.scriptAnswer(0, { kind: "throttled", retryAfterSeconds: 60 }, "ok");
    transport.scriptAnswer(1, { kind: "throttled", retryAfterSeconds: 2 }, "ok");

    await controller.queueSave(0);
    const longDeadline = controller.waitingUntil();
    await controller.queueSave(1);

    // A shorter later limit must not release the recipient early.
    expect(controller.waitingUntil()).toBe(longDeadline);
  });
});

describe("CASE 3 — a superseded request's throttle still counts", () => {
  it("applies the cooldown, then persists the NEWEST answer", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "throttle", "ok");

    // First edit is throttled; the recipient immediately edits again, so a
    // newer save supersedes it. The limit belongs to the transport, not to the
    // superseded answer, so it must still apply.
    const firstEdit = controller.queueSave(0);
    const secondEdit = controller.queueSave(0);
    await Promise.all([firstEdit, secondEdit]);

    expect(controller.isWaiting()).toBe(true);
    // The newer save was held rather than fired into the live limit.
    expect(transport.countOf("save:0")).toBe(1);

    transport.advance(10);
    expect(await controller.submit()).toEqual({ kind: "done" });
    // Exactly one further request: the newest answer.
    expect(transport.countOf("save:0")).toBe(2);
  });
});

describe("CASE 4 — completion throttled after every save succeeded", () => {
  it("retries ONLY completion, without resaving stored answers", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(2, transport);
    transport.scriptAnswer(0, "ok");
    transport.scriptAnswer(1, "ok");
    transport.completionScript = ["throttle", "ok"];

    await controller.queueSave(0);
    await controller.queueSave(1);

    const held = await controller.submit();
    expect(held.kind).toBe("waiting");
    // Answers ARE stored — the copy must not tell them to fear losing anything.
    if (held.kind === "waiting") expect(held.pendingAnswers).toBe(false);

    transport.advance(10);
    expect(await controller.submit()).toEqual({ kind: "done" });

    expect(transport.countOf("save:0")).toBe(1);
    expect(transport.countOf("save:1")).toBe(1);
    expect(transport.countOf("complete")).toBe(2);
    // Order matters: no save was issued between the two completion attempts.
    expect(transport.log).toEqual(["save:0", "save:1", "complete", "complete"]);
  });
});

describe("CASE 5 — repeated taps and plain failures", () => {
  it("repeated taps during a wait issue NO requests", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "throttle", "ok");

    await controller.queueSave(0);
    const before = transport.log.length;

    for (let tap = 0; tap < 5; tap += 1) {
      const result = await controller.submit();
      expect(result.kind).toBe("waiting");
    }

    // An impatient recipient must not become the flood.
    expect(transport.log.length).toBe(before);
  });

  it("recovers a TRANSIENT failure inside the same tap", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "fail", "ok");

    await controller.queueSave(0);
    // No wait is imposed for a network failure — there is no limit to respect —
    // so the single retry inside submit runs immediately and succeeds. One tap
    // is enough, which is the point.
    expect(await controller.submit()).toEqual({ kind: "done" });
    expect(transport.countOf("save:0")).toBe(2);
  });

  it("reports a PERSISTENT failure rather than claiming success", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "fail");

    await controller.queueSave(0);
    const result = await controller.submit();
    expect(result).toEqual({ kind: "failed", pendingAnswers: true });
    // Retried once within the tap, then stopped — not an unbounded loop.
    expect(transport.countOf("save:0")).toBe(2);
    expect(transport.countOf("complete")).toBe(0);
    expect(controller.isWaiting()).toBe(false);
  });

  it("a validation refusal is not treated as a throttle", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, { kind: "rejected", status: 400 });

    await controller.queueSave(0);
    const result = await controller.submit();
    expect(result).toEqual({ kind: "failed", pendingAnswers: true });
    expect(controller.isWaiting()).toBe(false);
  });

  it("a throttled completion never reports done", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "ok");
    transport.completionScript = ["throttle"];

    await controller.queueSave(0);
    const result = await controller.submit();
    expect(result.kind).not.toBe("done");
  });

  it("a failed completion leaves stored answers stored", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "ok");
    transport.completionScript = ["fail", "ok"];

    await controller.queueSave(0);
    expect(await controller.submit()).toEqual({ kind: "failed", pendingAnswers: false });

    // Retrying completion must not re-send the answer.
    expect(await controller.submit()).toEqual({ kind: "done" });
    expect(transport.countOf("save:0")).toBe(1);
  });
});

describe("a realistic multi-item check-in still finishes", () => {
  it("completes with six opportunities and one throttled midway", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(6, transport);
    transport.scriptAnswer(3, "throttle", "ok");

    for (let position = 0; position < 6; position += 1) {
      await controller.queueSave(position);
    }

    const held = await controller.submit();
    expect(held.kind).toBe("waiting");

    transport.advance(10);
    expect(await controller.submit()).toEqual({ kind: "done" });

    // Everything stored exactly once, except the throttled one which took two.
    expect(transport.countOf("save:3")).toBe(2);
    expect(transport.countOf("complete")).toBe(1);
  });
});

/**
 * Proof that CASE 1 distinguishes the fix from the defect.
 *
 * The controller is new code, so the new tests cannot be run against 2d55ca2
 * directly. Instead the SHIPPED control flow is reproduced faithfully here and
 * driven with the same transport. It encodes exactly what 2d55ca2 did:
 *
 *   - handleNext saved only the CURRENT index
 *   - submit re-queued unsaved items only when nothing was throttled
 *     (`if (held === null)`), so a throttled item was never re-sent
 *   - the relative delay was restarted on every submit
 *
 * Keeping this executable means the defect cannot quietly return.
 */
describe("PROOF — the previous control flow could not recover", () => {
  /** A faithful replica of 2d55ca2's submit(). */
  async function legacySubmit(
    transport: FakeTransport,
    outcomes: (RequestOutcome | null)[],
    lastIndex: number,
  ): Promise<"done" | "waiting" | "failed"> {
    // handleNext: only the current (final) item is saved on a submit tap.
    outcomes[lastIndex] = await transport.sendAnswer(lastIndex);

    const unsaved = outcomes
      .map((outcome, position) => ({ outcome, position }))
      .filter(({ outcome }) => outcome === null || outcome.kind !== "ok");

    if (unsaved.length > 0) {
      const throttled = unsaved
        .map(({ outcome }) => outcome)
        .filter((o): o is Extract<RequestOutcome, { kind: "throttled" }> => o?.kind === "throttled");

      if (throttled.length > 0) return "waiting"; // held, and NOTHING re-queued
      for (const { position } of unsaved) {
        outcomes[position] = await transport.sendAnswer(position);
      }
      return "failed";
    }

    const completion = await transport.sendCompletion();
    return completion.kind === "ok" ? "done" : "failed";
  }

  it("STICKS FOREVER on an earlier throttled item — the shipped defect", async () => {
    const transport = new FakeTransport();
    transport.scriptAnswer(0, "throttle", "ok");
    transport.scriptAnswer(1, "ok");

    // Item 0 throttled during the flow, item 1 fine.
    const outcomes: (RequestOutcome | null)[] = [await transport.sendAnswer(0), null];
    expect(outcomes[0]?.kind).toBe("throttled");

    // The recipient taps submit, waits, taps again — five times over.
    const results: string[] = [];
    for (let tap = 0; tap < 5; tap += 1) {
      results.push(await legacySubmit(transport, outcomes, 1));
      transport.advance(30);
    }

    // Never completes, however long they wait or how often they tap.
    expect(results).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
    // Item 0 was requested exactly once — its retry never happened.
    expect(transport.countOf("save:0")).toBe(1);
    expect(transport.countOf("complete")).toBe(0);
  });

  it("the SAME scenario completes with the controller", async () => {
    const transport = new FakeTransport();
    transport.scriptAnswer(0, "throttle", "ok");
    transport.scriptAnswer(1, "ok");
    const controller = new SubmissionController(2, transport);

    await controller.queueSave(0);
    await controller.queueSave(1);
    expect((await controller.submit()).kind).toBe("waiting");

    transport.advance(10);
    expect(await controller.submit()).toEqual({ kind: "done" });
    expect(transport.countOf("save:0")).toBe(2);
    expect(transport.countOf("complete")).toBe(1);
  });
});

/**
 * Found by driving the real browser, not by these tests.
 *
 * The component queues a save for the CURRENT item on every tap of the action
 * button — including the tap that retries a throttled COMPLETION. So after a
 * completion-only 429, submitting again re-sent the final item's answer even
 * though it was already stored and unchanged: a wasted write into a limiter
 * that had just asked us to slow down.
 *
 * These tests drive the controller the way the component does — queueSave then
 * submit — which is what the earlier tests missed by calling submit() alone.
 */
describe("REGRESSION — an unchanged stored answer is never re-sent", () => {
  it("does not resave the current item when only completion was throttled", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(2, transport);
    controller.describeAnswer = (p) => `answer-${p}`;
    transport.completionScript = ["throttle", "ok"];

    await controller.queueSave(0, "answer-0");
    await controller.queueSave(1, "answer-1");

    const held = await controller.submit();
    expect(held.kind).toBe("waiting");
    if (held.kind === "waiting") expect(held.pendingAnswers).toBe(false);

    transport.advance(10);
    // The retry tap, exactly as the component performs it.
    await controller.queueSave(1, "answer-1");
    expect(await controller.submit()).toEqual({ kind: "done" });

    expect(transport.countOf("save:0")).toBe(1);
    expect(transport.countOf("save:1")).toBe(1);
    expect(transport.countOf("complete")).toBe(2);
    // No save may sit between the two completion attempts.
    expect(transport.log).toEqual(["save:0", "save:1", "complete", "complete"]);
  });

  it("DOES resend when the answer actually changed", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);

    await controller.queueSave(0, "first");
    await controller.queueSave(0, "edited");

    expect(transport.countOf("save:0")).toBe(2);
    expect(await controller.submit()).toEqual({ kind: "done" });
  });

  it("still resends when the previous attempt did not succeed", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.scriptAnswer(0, "fail", "ok");

    // Same key both times, but the first attempt failed — so it is not stored
    // and the guard must not suppress the retry.
    await controller.queueSave(0, "same");
    await controller.queueSave(0, "same");
    expect(transport.countOf("save:0")).toBe(2);
  });
});


describe("server-saved answers restored after refresh", () => {
  it("completes without rewriting a restored answer, but persists a later edit", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(2, transport);
    controller.restoreSavedAnswer(0, "saved-open-answer");
    expect(controller.outcomeOf(0)?.kind).toBe("ok");
    await controller.queueSave(1, "new-answer");
    expect(await controller.submit()).toEqual({ kind: "done" });
    expect(transport.log).toEqual(["save:1", "complete"]);
    await controller.queueSave(0, "edited-open-answer");
    expect(transport.countOf("save:0")).toBe(1);
  });
  it("persists an earlier answer edited after returning to it", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(2, transport);
    const keys = ["original", "last"];
    controller.describeAnswer = position => keys[position];
    controller.restoreSavedAnswer(0, keys[0]);
    await controller.queueSave(1, keys[1]);
    keys[0] = "edited-back-navigation";
    expect(await controller.submit()).toEqual({ kind: "done" });
    expect(transport.log).toEqual(["save:1", "save:0", "complete"]);
  });

});
