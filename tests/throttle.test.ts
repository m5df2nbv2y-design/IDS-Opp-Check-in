import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_SECONDS,
  MAX_RETRY_SECONDS,
  MIN_RETRY_SECONDS,
  classifyResponse,
  failedOutcome,
  isUnsaved,
  parseRetryAfter,
  type ThrottleAwareResponse,
} from "@/lib/throttle";

/**
 * Being throttled must look different from losing your connection.
 *
 * The recipient flow used to reduce every result to `response.ok`, so a 429 was
 * indistinguishable from a dropped request: the customer was told to check
 * their wifi, and the retry fired on the next tap straight back into the limit.
 *
 * `Retry-After` arrives from infrastructure we may not control — a WAF, a CDN —
 * so it is parsed defensively here and always clamped. A hostile or broken
 * value must not strand someone for hours or spin them in a zero-second loop.
 *
 * SCOPE LIMIT, stated plainly: the repository has no component-test tooling
 * (no jsdom, no @testing-library, and vitest runs `environment: "node"` over
 * `tests/**\/*.test.ts`). These tests therefore verify the DECISION LOGIC the
 * recipient UI depends on. They do NOT render CheckInFlow and are not evidence
 * about the rendered experience — see the development log for what that leaves
 * unverified.
 */

function response(status: number, headers: Record<string, string> = {}): ThrottleAwareResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
  };
}

const NOW = Date.parse("2026-10-14T20:00:00.000Z");

describe("recognising a throttle", () => {
  it("identifies 429 WITHOUT reading the body", () => {
    // A WAF 429 is often HTML. Needing to parse JSON to notice a throttle would
    // either throw or silently misreport it, so the body is never touched.
    const outcome = classifyResponse(response(429, { "Retry-After": "7" }), NOW);
    expect(outcome.kind).toBe("throttled");
    if (outcome.kind === "throttled") expect(outcome.retryAfterSeconds).toBe(7);
  });

  it("treats a throttle with NO Retry-After as a bounded wait, not an error", () => {
    const outcome = classifyResponse(response(429), NOW);
    expect(outcome.kind).toBe("throttled");
    if (outcome.kind === "throttled") {
      expect(outcome.retryAfterSeconds).toBe(DEFAULT_RETRY_SECONDS);
    }
  });

  it("keeps a validation refusal separate from a throttle", () => {
    // 400 means the answer itself was wrong. Retrying it unchanged is pointless,
    // so it must never be presented as "wait and try again".
    expect(classifyResponse(response(400), NOW)).toEqual({ kind: "rejected", status: 400 });
    expect(classifyResponse(response(404), NOW)).toEqual({ kind: "rejected", status: 404 });
    expect(classifyResponse(response(409), NOW)).toEqual({ kind: "rejected", status: 409 });
  });

  it("keeps a server error separate from a throttle", () => {
    expect(classifyResponse(response(500), NOW)).toEqual({ kind: "failed", status: 500 });
    expect(classifyResponse(response(503), NOW)).toEqual({ kind: "failed", status: 503 });
  });

  it("reports success as success", () => {
    expect(classifyResponse(response(200), NOW)).toEqual({ kind: "ok" });
  });

  it("reports a thrown fetch as a failure, not a throttle", () => {
    expect(failedOutcome()).toEqual({ kind: "failed", status: null });
  });

  it("treats everything except success as NOT saved on the server", () => {
    // The distinction the copy depends on: an answer that did not reach the
    // server lives only in this page, and the recipient has to be told so.
    expect(isUnsaved({ kind: "ok" })).toBe(false);
    expect(isUnsaved({ kind: "throttled", retryAfterSeconds: 5 })).toBe(true);
    expect(isUnsaved({ kind: "rejected", status: 400 })).toBe(true);
    expect(isUnsaved({ kind: "failed", status: null })).toBe(true);
  });
});

describe("Retry-After as delay-seconds", () => {
  it("accepts a plain number of seconds", () => {
    expect(parseRetryAfter("7", NOW)).toBe(7);
    expect(parseRetryAfter("  30  ", NOW)).toBe(30);
  });

  it("never returns less than the floor, so the UI cannot spin", () => {
    expect(parseRetryAfter("0", NOW)).toBe(MIN_RETRY_SECONDS);
  });

  it("CAPS an excessive wait rather than stranding the recipient", () => {
    // A limiter — or an attacker-influenced edge — asking for an hour must not
    // take the check-in hostage.
    expect(parseRetryAfter("3600", NOW)).toBe(MAX_RETRY_SECONDS);
    expect(parseRetryAfter("999999999", NOW)).toBe(MAX_RETRY_SECONDS);
  });

  it("falls back on a negative value", () => {
    expect(parseRetryAfter("-1", NOW)).toBe(DEFAULT_RETRY_SECONDS);
    expect(parseRetryAfter("-3600", NOW)).toBe(DEFAULT_RETRY_SECONDS);
  });

  it("falls back on malformed, missing and non-finite values", () => {
    // "12.5" matters: Date.parse reads it as 2001-12-05, a PAST date, which
    // would otherwise collapse to the one-second floor instead of falling back.
    for (const raw of [null, undefined, "", "   ", "soon", "NaN", "Infinity", "-Infinity", "5s", "1e9", "12.5", "+30", "0x10"]) {
      expect(parseRetryAfter(raw, NOW), `input ${JSON.stringify(raw)}`).toBe(DEFAULT_RETRY_SECONDS);
    }
  });
});

describe("Retry-After as an HTTP-date", () => {
  it("measures the wait from the supplied clock, not the wall clock", () => {
    // Controlled time: the test must not depend on when it runs.
    const future = new Date(NOW + 45_000).toUTCString();
    expect(parseRetryAfter(future, NOW)).toBe(45);
  });

  it("rounds a part-second up rather than down", () => {
    // toUTCString() truncates to whole seconds, so the fraction is created by
    // offsetting the CLOCK rather than the date: 11s away, asked 0.4s later.
    const future = new Date(NOW + 11_000).toUTCString();
    expect(parseRetryAfter(future, NOW + 400)).toBe(11);
  });

  it("treats a date already in the past as retry-now, still floored", () => {
    const past = new Date(NOW - 60_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(MIN_RETRY_SECONDS);
  });

  it("CAPS a far-future date", () => {
    const far = new Date(NOW + 86_400_000).toUTCString();
    expect(parseRetryAfter(far, NOW)).toBe(MAX_RETRY_SECONDS);
  });

  it("does not mistake a bare number for a year", () => {
    // Date.parse("120") yields the year 120 in some engines. Seconds are
    // checked first precisely so "120" means two minutes.
    expect(parseRetryAfter("120", NOW)).toBe(120);
    expect(parseRetryAfter("120", NOW)).not.toBe(MAX_RETRY_SECONDS === 120 ? -1 : MAX_RETRY_SECONDS);
  });
});

describe("the bounds hold for every input", () => {
  it("always returns a finite value inside the allowed range", () => {
    const inputs = [
      null, undefined, "", " ", "0", "1", "7", "120", "3600", "-1", "-0", "abc", "NaN",
      "Infinity", "1e3", "12.5", "Tue, 14 Oct 2026 20:00:45 GMT", "not-a-date",
      "9999999999999999999999", "0x10", "+30",
    ];
    for (const raw of inputs) {
      const seconds = parseRetryAfter(raw, NOW);
      expect(Number.isFinite(seconds), `input ${JSON.stringify(raw)}`).toBe(true);
      expect(seconds, `input ${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(MIN_RETRY_SECONDS);
      expect(seconds, `input ${JSON.stringify(raw)}`).toBeLessThanOrEqual(MAX_RETRY_SECONDS);
    }
  });
});

/**
 * Structural guarantees about the recipient flow itself.
 *
 * These read the source rather than render it — the same technique
 * `production-readiness.test.ts` already uses for the client/server boundary.
 * They catch the failure modes that a future edit could reintroduce silently.
 */
describe("the recipient flow keeps its throttle guarantees", () => {
  const flow = readFileSync(
    fileURLToPath(new URL("../src/components/checkin/check-in-flow.tsx", import.meta.url)),
    "utf8",
  );

  it("NEVER puts a recipient's answers in durable browser storage", () => {
    // Surviving a reload would mean a check-in token's answers sitting in the
    // browser after the tab closes. The page is deliberately the only copy.
    expect(flow).not.toMatch(/localStorage/);
    expect(flow).not.toMatch(/sessionStorage/);
    expect(flow).not.toMatch(/document\.cookie/);
    expect(flow).not.toMatch(/indexedDB/i);
  });

  it("never logs — so a raw token cannot reach the console", () => {
    expect(flow).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });

  it("does not collapse responses to response.ok", () => {
    // The original defect. `.then(r => r.ok)` is what made a 429 look like a
    // dropped connection.
    expect(flow).not.toMatch(/\.then\(\s*\(\s*response\s*\)\s*=>\s*response\.ok\s*\)/);
    expect(flow).toContain("classifyResponse");
  });

  it("catches fetch rejections on BOTH the save and the completion path", () => {
    // A thrown fetch that is not caught leaves the button stuck on "Submitting…".
    expect(flow.match(/\.catch\(failedOutcome\)/g) ?? []).toHaveLength(2);
  });

  it("releases the busy state even when submit throws", () => {
    expect(flow).toMatch(/finally[\s\S]*?setBusy\(false\)/);
  });

  it("blocks the button while a wait is in force", () => {
    expect(flow).toMatch(/disabled=\{[\s\S]*?waiting[\s\S]*?\}/);
  });

  it("delegates save/retry/completion to the testable controller", () => {
    // This assertion replaces one that checked for `if (held === null)` — which
    // was the BUGGY LINE ITSELF. A string assertion happily pinned the defect
    // in place, which is exactly why retry behaviour is now covered by
    // executable tests in checkin-submission.test.ts instead of by matching
    // source text here.
    expect(flow).toContain("SubmissionController");
    expect(flow).toContain("getController().submit()");
    expect(flow).toContain("getController().queueSave(index, answerKeyAt(index))");
    // The key is what lets an unchanged, already-stored answer be skipped.
    expect(flow).toContain("function answerKeyAt");
  });

  it("tells the truth about unsaved answers only when they are unsaved", () => {
    // Two different messages on purpose: one where answers are still pending
    // and the page is the only copy, one where they are confirmed stored.
    expect(flow).toContain("keep this page open");
    expect(flow).toContain("Your answers are saved.");
    // The old copy blamed the customer's network for our own rate limit.
    expect(flow).not.toMatch(/Check your connection[^"]*wait/i);
  });
});
