import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { clientIp } from "./client-ip";

/**
 * SEC-001 — request limits on the three routes an outsider can reach.
 *
 * WHAT THIS IS FOR. Not token guessing: a check-in token is 256 random bits
 * stored only as a SHA-256 digest, and no rate limit meaningfully changes the
 * odds of guessing one. This exists because each request past the cheap
 * length pre-filter costs a hash plus an indexed lookup with three joins
 * against the production database, and an unauthenticated stranger can ask for
 * that as fast as they like. The limit bounds cost and noise.
 *
 * THE RISK IS THE CONTROL ITSELF. A recipient with several opportunities fires
 * one save per opportunity in quick succession, and several recipients at one
 * customer share a public IP. A naive per-IP rule throttles real people in the
 * middle of a check-in, which is worse than the abuse it prevents. Two things
 * follow, and both are deliberate:
 *
 *   - Classes A-C are keyed on IP *and* a truncated token digest, so one
 *     office IP does not pool unrelated recipients into one allowance.
 *   - The default mode is COUNT, not ENFORCE. The limiter observes real
 *     traffic and returns no 429 until someone has looked at the shape of it.
 *     Shipping a brand-new limiter in blocking mode on go-live day is how a
 *     launch breaks its own customers.
 *
 * NEVER A RAW TOKEN. Counter keys are durable state, so ADR-005 applies: only
 * a truncated digest of the token appears in a key, never the token.
 */

export type LimitClass = "page" | "save" | "complete" | "unresolved";

/** Per class, because one global number cannot fit both a save burst and a completion. */
const LIMITS: Record<LimitClass, { max: number; windowSeconds: number }> = {
  // Generous: reloads, back-button, and link-preview fetchers are all normal.
  page: { max: 60, windowSeconds: 60 },
  // Must clear the fastest legitimate recipient plus their retries.
  save: { max: 120, windowSeconds: 60 },
  // Legitimately called once per check-in.
  complete: { max: 10, windowSeconds: 60 },
  // The abuse case: a token that resolved to nothing. Tighter on purpose,
  // because no real recipient repeatedly presents an invalid token.
  unresolved: { max: 20, windowSeconds: 60 },
};

export type RateLimitMode = "off" | "count" | "enforce";

export function rateLimitMode(): RateLimitMode {
  const raw = (env.rateLimitMode || "").toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "count";
}

export type RateLimitDecision = {
  /** False only when the limit is exceeded AND the mode is "enforce". */
  allowed: boolean;
  /** True when the ceiling was passed, whatever the mode. Use this for observation. */
  exceeded: boolean;
  limitClass: LimitClass;
  count: number;
  max: number;
  /** Seconds until the window ends. Suitable for a Retry-After header. */
  retryAfterSeconds: number;
  /**
   * Set when the limit could not be evaluated, with the reason. The decision
   * is always `allowed: true` in that case — see the fail-open note below.
   */
  degraded?: "store-unavailable" | "no-client-ip" | "untrusted-client-ip";
};

/**
 * Count one request and say whether it may proceed.
 *
 * FAIL OPEN, deliberately. If the counter store is unreachable, or there is no
 * address to count against, the request is allowed. For an internal
 * twice-yearly check-in the cost of blocking a real customer who cannot then
 * answer is plainly higher than the cost of an unlimited window during an
 * outage. The trade is that the limiter can stop limiting silently, so every
 * such case is reported in `degraded` for the caller to log, and monitoring
 * that is SEC-010 (open).
 */
export async function rateLimit(
  limitClass: LimitClass,
  headers: Headers,
  token?: string,
  /**
   * Defaults to the configured mode. Passed explicitly only by tests, which
   * need to exercise all three — `env` is read once at module load, so setting
   * the variable afterwards would not be seen, and reading process.env here
   * would break the rule that configuration lives in one place.
   */
  mode: RateLimitMode = rateLimitMode(),
): Promise<RateLimitDecision> {
  const { max, windowSeconds } = LIMITS[limitClass];
  const allow = (degraded?: RateLimitDecision["degraded"]): RateLimitDecision => ({
    allowed: true,
    exceeded: false,
    limitClass,
    count: 0,
    max,
    retryAfterSeconds: windowSeconds,
    degraded,
  });

  if (mode === "off") return allow();

  const ip = clientIp(headers);
  // No address means no honest key. Inventing a shared one would pool every
  // such request into a single allowance and throttle them as a group.
  if (!ip.known) return allow("no-client-ip");

  const key = counterKey(limitClass, ip.ip, token);

  let result: { count: number; expiresAt: Date };
  try {
    result = await increment(key, windowSeconds);
  } catch {
    // The store is the thing protecting the database, not the database itself.
    // If it is unavailable we are not willing to refuse a customer over it.
    return allow("store-unavailable");
  }

  const exceeded = result.count > max;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((result.expiresAt.getTime() - Date.now()) / 1000),
  );

  // An address from a client-appendable header can be set to anyone's, so
  // enforcing on it would let an attacker spend a real recipient's allowance.
  // Count it — the observation is still useful — but never block on it.
  if (exceeded && !ip.trusted) {
    return {
      allowed: true,
      exceeded: true,
      limitClass,
      count: result.count,
      max,
      retryAfterSeconds,
      degraded: "untrusted-client-ip",
    };
  }

  return {
    allowed: !(exceeded && mode === "enforce"),
    exceeded,
    limitClass,
    count: result.count,
    max,
    retryAfterSeconds,
  };
}

/**
 * The counter key.
 *
 * Classes A-C carry a truncated token digest so that several recipients behind
 * one corporate IP do not share an allowance. 12 hex characters is 48 bits:
 * long enough that two recipients sharing a key is not a practical concern,
 * short enough to keep the primary key small. The class is part of the key, so
 * a save burst cannot consume the completion allowance.
 *
 * Class D is keyed on IP ALONE, and that is not an oversight. An attacker
 * presenting a fresh random token each time produces a different digest every
 * request, so any token-derived key is defeated by construction. The only
 * stable attribute of a caller with no valid token is where it came from.
 */
function counterKey(limitClass: LimitClass, ip: string, token?: string): string {
  if (limitClass === "unresolved" || !token) return `${limitClass}:${ip}`;
  const digest = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `${limitClass}:${ip}:${digest}`;
}

/**
 * Increment inside one statement, because a read-then-write loses counts.
 *
 * Two concurrent requests that both read 5 and both write 6 have served two
 * requests for the price of one, and under exactly the load a limiter exists
 * to handle. `INSERT ... ON CONFLICT DO UPDATE` is a single atomic statement:
 * the row is locked for its duration, so every caller sees a distinct count.
 *
 * The same statement also rolls the window over. A row whose window has passed
 * is reset to 1 in place rather than deleted and recreated, so a busy key does
 * not churn rows, and an expired row left behind by a key that goes quiet is
 * harmless until the sweep removes it.
 */
async function increment(
  key: string,
  windowSeconds: number,
): Promise<{ count: number; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + windowSeconds * 1000);
  const table = `"${schemaName()}"."RateLimitCounter"`;

  const rows = await prisma.$queryRawUnsafe<{ count: number; expiresAt: Date }[]>(
    `INSERT INTO ${table} ("key", "count", "expiresAt")
     VALUES ($1, 1, $2)
     ON CONFLICT ("key") DO UPDATE SET
       "count" = CASE
         WHEN ${table}."expiresAt" <= NOW() THEN 1
         ELSE ${table}."count" + 1
       END,
       "expiresAt" = CASE
         WHEN ${table}."expiresAt" <= NOW() THEN $2
         ELSE ${table}."expiresAt"
       END
     RETURNING "count", "expiresAt"`,
    key,
    expiresAt,
  );

  const row = rows[0];
  if (!row) throw new Error("rate limit counter returned no row");
  return { count: Number(row.count), expiresAt: new Date(row.expiresAt) };
}

/**
 * The schema to qualify the raw statement above with.
 *
 * Prisma names tables with their schema explicitly in the SQL it generates,
 * rather than setting the connection's `search_path`. A raw statement that
 * names a table UNQUALIFIED therefore resolves against `public`, which is the
 * wrong schema on any deployment that uses another one — and because this
 * limiter fails open, the symptom would be a limiter that silently never
 * limits rather than an error anyone notices. That is precisely the failure
 * this function exists to prevent, and it was a real bug caught in test.
 *
 * The value comes from our own connection string, never from a request, and is
 * validated anyway: it is interpolated as an identifier, which cannot be
 * parameterized. The counter key and timestamp remain bound parameters.
 */
function schemaName(): string {
  const match = /[?&]schema=([^&]+)/.exec(env.databaseUrl);
  const schema = match ? decodeURIComponent(match[1]) : "public";
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) {
    throw new Error(`Unsupported schema name for the rate limit counter: ${schema}`);
  }
  return schema;
}

/**
 * Remove windows that have long since passed.
 *
 * An unbounded keyspace is itself a denial-of-service vector: every distinct
 * address that ever arrives leaves a row. Nothing here runs on a schedule yet,
 * so this is called opportunistically (see `maybeSweep`) rather than relying on
 * a cron that does not exist.
 *
 * The grace period means a sweep never races a window that is still being
 * counted against.
 */
export async function sweepExpiredCounters(graceSeconds = 300): Promise<number> {
  const cutoff = new Date(Date.now() - graceSeconds * 1000);
  const { count } = await prisma.rateLimitCounter.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return count;
}

/**
 * Sweep occasionally, without putting a delete on the request path.
 *
 * One in roughly every 200 limited requests pays for the cleanup. At check-in
 * volumes that is a handful of sweeps per campaign, and no single recipient
 * ever waits for one — the call is not awaited by the caller.
 */
export function maybeSweep(): void {
  if (Math.random() >= 1 / 200) return;
  void sweepExpiredCounters().catch(() => {
    // Cleanup is maintenance. Failing it must never affect a request.
  });
}

/**
 * The 429 itself.
 *
 * `Retry-After` is the whole point: the recipient client reads it and shows a
 * countdown instead of inviting an immediate re-tap, so a throttled person is
 * told to wait rather than told their connection is broken.
 *
 * The body deliberately carries no token, no count and no key — only that a
 * limit applied, and for how long.
 */
export function tooManyRequests(decision: RateLimitDecision): Response {
  return Response.json(
    { ok: false, reason: "RATE_LIMITED", retryAfterSeconds: decision.retryAfterSeconds },
    {
      status: 429,
      headers: {
        "Retry-After": String(decision.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Report an exceeded ceiling or a degraded evaluation to the server log.
 *
 * Deliberately NOT an audit record. The audit trail is a record of what people
 * did to campaigns and opportunities; filling it with throttle events would
 * bury the entries it exists to preserve. A log line is the right weight.
 *
 * Nothing here can carry a raw token: the class, the count and the reason are
 * all that is printed.
 */
export function reportRateLimit(decision: RateLimitDecision): void {
  if (decision.degraded) {
    console.warn(
      `[rate-limit] not evaluated (${decision.degraded}) class=${decision.limitClass}` +
        (decision.exceeded ? ` counted=${decision.count}/${decision.max} but NOT enforced` : ""),
    );
    return;
  }
  if (!decision.exceeded) return;
  console.warn(
    `[rate-limit] ${decision.allowed ? "exceeded (count-only, allowed)" : "BLOCKED"} ` +
      `class=${decision.limitClass} count=${decision.count}/${decision.max} ` +
      `retryAfter=${decision.retryAfterSeconds}s`,
  );
}

/**
 * Count a request whose token resolved to nothing (class D).
 *
 * Called AFTER the lookup, because token validity is the one thing no layer in
 * front of the application can know — a proxy sees headers and paths, not
 * whether a digest matches a row. So the cost of the failing request is not
 * avoided here; it is bounded, by declining to keep serving a source that
 * keeps failing.
 */
export async function countUnresolved(
  headers: Headers,
  mode?: RateLimitMode,
): Promise<RateLimitDecision> {
  const decision = await rateLimit("unresolved", headers, undefined, mode ?? rateLimitMode());
  reportRateLimit(decision);
  return decision;
}
