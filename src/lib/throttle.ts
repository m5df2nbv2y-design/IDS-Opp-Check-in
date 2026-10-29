/**
 * Recognising a throttle, and deciding how long to wait.
 *
 * The recipient flow used to collapse every result to `response.ok`, which made
 * a 429 indistinguishable from a dropped connection — so a throttled customer
 * was told to check their wifi and invited to retry immediately, which simply
 * hit the limit again.
 *
 * Two constraints shape this file:
 *
 *   1. A throttle may not come from us. A WAF or CDN can return 429 with an
 *      HTML body, so recognising one must NEVER depend on parsing JSON.
 *   2. `Retry-After` is attacker- and infrastructure-controlled text. It is
 *      parsed defensively and always clamped into a sane range, so a hostile or
 *      broken value cannot strand a recipient for hours or spin them in a
 *      zero-second retry loop.
 *
 * Kept free of React so it can be tested directly — the repository has no
 * component-test tooling, so this is the layer that carries the assertions.
 */

/** Used when the header is absent, malformed, or unusable. */
export const DEFAULT_RETRY_SECONDS = 5;
/** Never ask someone to wait less than this; zero would be a retry loop. */
export const MIN_RETRY_SECONDS = 1;
/** Never ask someone to wait longer than this, whatever the header claims. */
export const MAX_RETRY_SECONDS = 120;

export type RequestOutcome =
  /** The server accepted it. */
  | { kind: "ok" }
  /** Rate limited. Wait, then the same request is worth repeating. */
  | { kind: "throttled"; retryAfterSeconds: number }
  /** The server understood and refused. Repeating it unchanged will not help. */
  | { kind: "rejected"; status: number }
  /** Network failure, or a server error. Repeating it later may work. */
  | { kind: "failed"; status: number | null };

function clamp(seconds: number): number {
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, Math.ceil(seconds)));
}

/**
 * `Retry-After` as delay-seconds or HTTP-date, bounded.
 *
 * Returns DEFAULT_RETRY_SECONDS for anything unusable rather than throwing:
 * being throttled is already a bad moment to also crash the page.
 */
export function parseRetryAfter(raw: string | null | undefined, nowMs: number): number {
  if (raw === null || raw === undefined) return DEFAULT_RETRY_SECONDS;

  const value = raw.trim();
  if (value === "") return DEFAULT_RETRY_SECONDS;

  // delay-seconds. Checked before the date branch because Date.parse accepts
  // some bare numbers as years — "120" must mean two minutes, not the year 120.
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return DEFAULT_RETRY_SECONDS;
    return clamp(seconds);
  }

  // A leading "-" is well-formed syntax carrying a nonsensical value, so it is
  // treated as unusable rather than clamped up to the minimum.
  if (/^-\d+$/.test(value)) return DEFAULT_RETRY_SECONDS;

  // Only an HTTP-date reaches Date.parse. Without this guard a malformed
  // numeric value is silently reinterpreted as a date: Date.parse("12.5")
  // yields 2001-12-05, a date in the PAST, which would collapse to the
  // one-second floor — very nearly the retry loop this module exists to
  // prevent. Every RFC 7231 HTTP-date contains letters (day, month, GMT).
  if (!/[a-z]/i.test(value)) return DEFAULT_RETRY_SECONDS;

  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return DEFAULT_RETRY_SECONDS;

  const seconds = (asDate - nowMs) / 1000;
  // A date already in the past means "retry now", which still gets the floor so
  // the UI cannot spin.
  if (seconds <= 0) return MIN_RETRY_SECONDS;
  return clamp(seconds);
}

/** The shape of a fetch Response this module needs. Keeps tests free of DOM. */
export type ThrottleAwareResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
};

/**
 * Classify a response WITHOUT reading its body.
 *
 * A WAF's 429 is often HTML, so a body parse would either throw or misreport it.
 */
export function classifyResponse(
  response: ThrottleAwareResponse,
  nowMs: number = Date.now(),
): RequestOutcome {
  if (response.status === 429) {
    return {
      kind: "throttled",
      retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After"), nowMs),
    };
  }

  if (response.ok) return { kind: "ok" };

  // 5xx is transient and worth retrying; other 4xx are our own validation
  // answers and repeating them unchanged would be pointless.
  if (response.status >= 500) return { kind: "failed", status: response.status };
  return { kind: "rejected", status: response.status };
}

/** A fetch that never threw still has to be classified; a thrown one is a failure. */
export function failedOutcome(): RequestOutcome {
  return { kind: "failed", status: null };
}

/** True when this outcome means the answer is NOT stored on the server. */
export function isUnsaved(outcome: RequestOutcome): boolean {
  return outcome.kind !== "ok";
}
