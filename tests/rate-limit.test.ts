import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  countUnresolved,
  rateLimit as rawRateLimit,
  rateLimitMode,
  sweepExpiredCounters,
  tooManyRequests,
  type LimitClass,
} from "@/server/security/rate-limit";
import { resetDatabase } from "./fixtures";

/**
 * SEC-001 request limits.
 *
 * The limit itself is the easy half. These tests spend most of their effort on
 * the two ways a limiter does damage:
 *
 *   1. It throttles a REAL recipient — someone with many opportunities saving
 *      quickly, or several colleagues behind one office IP.
 *   2. It can be AIMED at someone, by spoofing the address it counts on, so an
 *      attacker spends a customer's allowance instead of their own.
 *
 * Both are asserted here, not assumed.
 */

/**
 * Most of these assert what happens AT the ceiling, which only has observable
 * consequences in enforcing mode, so that is the default here. The modes
 * themselves are covered separately below.
 */
const rateLimit = (limitClass: LimitClass, headers: Headers, token?: string) =>
  rawRateLimit(limitClass, headers, token, "enforce");

/** Headers as the platform sets them: an address a client cannot forge. */
function trusted(ip: string): Headers {
  return new Headers({ "x-vercel-forwarded-for": ip });
}

/** Headers as a client can send them: appendable, therefore not enforceable. */
function spoofable(ip: string): Headers {
  return new Headers({ "x-forwarded-for": ip });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("the ceiling", () => {
  it("allows up to the limit and refuses the request after it", async () => {
    const headers = trusted("203.0.113.10");
    // Completion has the lowest ceiling (10/min), so this stays quick.
    for (let i = 1; i <= 10; i += 1) {
      const decision = await rateLimit("complete", headers, "token-aaaaaaaaaaaaaaaaaaaa");
      expect(decision.allowed, `call ${i}`).toBe(true);
      expect(decision.exceeded, `call ${i}`).toBe(false);
    }

    const over = await rateLimit("complete", headers, "token-aaaaaaaaaaaaaaaaaaaa");
    expect(over.exceeded).toBe(true);
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(11);
    expect(over.max).toBe(10);
  });

  it("reports a Retry-After inside the window, never zero", async () => {
    const headers = trusted("203.0.113.11");
    for (let i = 0; i < 11; i += 1) {
      await rateLimit("complete", headers, "token-bbbbbbbbbbbbbbbbbbbb");
    }
    const over = await rateLimit("complete", headers, "token-bbbbbbbbbbbbbbbbbbbb");
    expect(over.retryAfterSeconds).toBeGreaterThan(0);
    expect(over.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("counts each class separately, so saving cannot consume completion", async () => {
    const headers = trusted("203.0.113.12");
    const token = "token-cccccccccccccccccccc";
    // Exhaust completion.
    for (let i = 0; i < 11; i += 1) await rateLimit("complete", headers, token);
    expect((await rateLimit("complete", headers, token)).exceeded).toBe(true);

    // Saving is untouched: a different class is a different counter.
    const save = await rateLimit("save", headers, token);
    expect(save.exceeded).toBe(false);
    expect(save.allowed).toBe(true);
  });
});

describe("a real recipient is never throttled", () => {
  /**
   * The most important test here. The sample org's busiest contact holds 6
   * opportunities and live data holds more, so a fast recipient fires a burst
   * of saves. If this ever fails, the control is hurting the people it is
   * supposed to be invisible to.
   */
  it("clears a 40-opportunity check-in saved at speed, with retries", async () => {
    const headers = trusted("198.51.100.5");
    const token = "token-dddddddddddddddddddd";

    // 40 opportunities, each saved once, plus a revision on every one: 80
    // saves in one window — far beyond any real check-in.
    for (let i = 0; i < 80; i += 1) {
      const decision = await rateLimit("save", headers, token);
      expect(decision.exceeded, `save ${i + 1} of 80`).toBe(false);
    }

    // And the completion that follows still goes through.
    expect((await rateLimit("complete", headers, token)).allowed).toBe(true);
  });

  it("does not pool colleagues behind one office IP into a shared allowance", async () => {
    // Corporate NAT: one public address, three different recipients.
    const office = trusted("198.51.100.7");
    const a = "token-eeeeeeeeeeeeeeeeeeee";
    const b = "token-ffffffffffffffffffff";
    const c = "token-gggggggggggggggggggg";

    // One of them exhausts their own completion ceiling.
    for (let i = 0; i < 11; i += 1) await rateLimit("complete", office, a);
    expect((await rateLimit("complete", office, a)).exceeded).toBe(true);

    // Their colleagues are unaffected — the token digest is part of the key.
    expect((await rateLimit("complete", office, b)).exceeded).toBe(false);
    expect((await rateLimit("complete", office, c)).exceeded).toBe(false);
  });
});

describe("the invalid-token class", () => {
  it("is tighter than the save ceiling it protects", async () => {
    const headers = trusted("203.0.113.20");
    for (let i = 0; i < 20; i += 1) {
      expect((await countUnresolved(headers, "enforce")).exceeded).toBe(false);
    }
    expect((await countUnresolved(headers, "enforce")).exceeded).toBe(true);
  });

  it("cannot be evaded by presenting a fresh random token each time", async () => {
    // The reason class D is keyed on address ALONE. A token-derived key would
    // produce a new counter per request and never trip.
    const headers = trusted("203.0.113.21");
    for (let i = 0; i < 21; i += 1) {
      await rateLimit("unresolved", headers, `different-token-${i}-aaaaaaaaaaaaaaaaaaaa`);
    }
    const decision = await rateLimit("unresolved", headers, "another-entirely-different-one");
    expect(decision.exceeded).toBe(true);
  });

  it("keys separately per address, so one abuser cannot block everyone", async () => {
    const abuser = trusted("203.0.113.22");
    for (let i = 0; i < 21; i += 1) await countUnresolved(abuser, "enforce");
    expect((await countUnresolved(abuser, "enforce")).exceeded).toBe(true);

    expect((await countUnresolved(trusted("203.0.113.23"), "enforce")).exceeded).toBe(false);
  });
});

describe("the limiter cannot be aimed at a recipient", () => {
  it("counts a spoofable address but refuses to BLOCK on it", async () => {
    // An attacker sets x-forwarded-for to a real recipient's address. If that
    // were enforceable, they could spend someone else's allowance and lock
    // them out of their own check-in.
    const headers = spoofable("198.51.100.99");
    for (let i = 0; i < 12; i += 1) {
      await rateLimit("complete", headers, "token-hhhhhhhhhhhhhhhhhhhh");
    }
    const decision = await rateLimit("complete", headers, "token-hhhhhhhhhhhhhhhhhhhh");

    expect(decision.exceeded).toBe(true);        // observed
    expect(decision.allowed).toBe(true);         // but never blocked
    expect(decision.degraded).toBe("untrusted-client-ip");
  });

  it("prefers the platform header when a client also supplies one", async () => {
    const headers = new Headers({
      "x-vercel-forwarded-for": "203.0.113.30",
      "x-forwarded-for": "198.51.100.1",
    });
    for (let i = 0; i < 11; i += 1) {
      await rateLimit("complete", headers, "token-iiiiiiiiiiiiiiiiiiii");
    }
    // Enforced, which is only possible if the TRUSTED header was the key.
    const decision = await rateLimit("complete", headers, "token-iiiiiiiiiiiiiiiiiiii");
    expect(decision.allowed).toBe(false);
    expect(decision.degraded).toBeUndefined();

    // And the spoofed address was never charged.
    const other = await rateLimit("complete", trusted("198.51.100.1"), "token-iiiiiiiiiiiiiiiiiiii");
    expect(other.exceeded).toBe(false);
  });

  it("allows, without counting, when there is no address at all", async () => {
    const decision = await rateLimit("complete", new Headers(), "token-jjjjjjjjjjjjjjjjjjjj");
    expect(decision.allowed).toBe(true);
    expect(decision.degraded).toBe("no-client-ip");
    // Nothing was written: inventing a shared key would pool these requests.
    expect(await prisma.rateLimitCounter.count()).toBe(0);
  });
});

describe("modes", () => {
  it("count-only observes the breach and still allows the request", async () => {
    const headers = trusted("203.0.113.40");
    const token = "token-kkkkkkkkkkkkkkkkkkkk";
    for (let i = 0; i < 11; i += 1) {
      await rawRateLimit("complete", headers, token, "count");
    }
    const decision = await rawRateLimit("complete", headers, token, "count");

    expect(decision.exceeded).toBe(true);
    expect(decision.allowed).toBe(true);
  });

  /**
   * The safety property for go-live: a brand-new limiter must not be able to
   * turn a customer away before anyone has seen real traffic through it.
   */
  it("DEFAULTS to count-only, so a fresh deployment cannot refuse a recipient", async () => {
    expect(rateLimitMode()).toBe("count");

    const headers = trusted("203.0.113.41");
    const token = "token-llllllllllllllllllll";
    for (let i = 0; i < 12; i += 1) {
      // No mode argument: exactly what the routes do in production.
      await rawRateLimit("complete", headers, token);
    }
    const decision = await rawRateLimit("complete", headers, token);
    expect(decision.exceeded).toBe(true);
    expect(decision.allowed).toBe(true);
  });

  it("off does not count at all", async () => {
    for (let i = 0; i < 5; i += 1) {
      await rawRateLimit("complete", trusted("203.0.113.42"), "token-mmmmmmmmmmmmmmmmmmmm", "off");
    }
    expect(await prisma.rateLimitCounter.count()).toBe(0);
  });
});

describe("the window", () => {
  it("resets in place once it has passed, rather than accumulating rows", async () => {
    const headers = trusted("203.0.113.50");
    const token = "token-nnnnnnnnnnnnnnnnnnnn";
    for (let i = 0; i < 11; i += 1) await rateLimit("complete", headers, token);
    expect((await rateLimit("complete", headers, token)).exceeded).toBe(true);

    const before = await prisma.rateLimitCounter.count();

    // Expire the window by hand rather than waiting a minute.
    await prisma.rateLimitCounter.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const after = await rateLimit("complete", headers, token);
    expect(after.count).toBe(1);
    expect(after.allowed).toBe(true);
    // Reused in place: the same key, not a second row.
    expect(await prisma.rateLimitCounter.count()).toBe(before);
  });
});

describe("counter hygiene", () => {
  it("never stores a raw token in a counter key", async () => {
    // ADR-005: counter keys are durable state, so the bearer credential must
    // not appear in one. The same property tests/token-persistence.test.ts
    // asserts for email columns.
    const token = "SuperSecretRawToken-aaaaaaaaaaaaaaaaaaaaaaa";
    await rateLimit("save", trusted("203.0.113.60"), token);
    await rateLimit("page", trusted("203.0.113.60"), token);
    await rateLimit("complete", trusted("203.0.113.60"), token);

    const keys = (await prisma.rateLimitCounter.findMany({ select: { key: true } })).map(
      (row) => row.key,
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(token);
      expect(key).not.toContain("SuperSecretRawToken");
    }
  });

  it("sweeps windows that have long passed, and spares live ones", async () => {
    await rateLimit("complete", trusted("203.0.113.70"), "token-oooooooooooooooooooo");
    await rateLimit("complete", trusted("203.0.113.71"), "token-pppppppppppppppppppp");
    expect(await prisma.rateLimitCounter.count()).toBe(2);

    // One key went quiet an hour ago; the other is still being counted.
    await prisma.rateLimitCounter.updateMany({
      where: { key: { contains: "203.0.113.70" } },
      data: { expiresAt: new Date(Date.now() - 3_600_000) },
    });

    const removed = await sweepExpiredCounters();
    expect(removed).toBe(1);
    expect(await prisma.rateLimitCounter.count()).toBe(1);
  });
});

describe("the 429 response", () => {
  it("carries Retry-After and leaks nothing about the limit or the token", async () => {
    const headers = trusted("203.0.113.80");
    for (let i = 0; i < 12; i += 1) {
      await rateLimit("complete", headers, "token-qqqqqqqqqqqqqqqqqqqq");
    }
    const decision = await rateLimit("complete", headers, "token-qqqqqqqqqqqqqqqqqqqq");
    const response = tooManyRequests(decision);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(decision.retryAfterSeconds));
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.reason).toBe("RATE_LIMITED");
    // No count, no ceiling, no key, no token.
    expect(Object.keys(body).sort()).toEqual(["ok", "reason", "retryAfterSeconds"]);
    expect(JSON.stringify(body)).not.toContain("token-qqqq");
  });
});

describe("concurrency", () => {
  /**
   * A read-then-write limiter loses counts under exactly the load it exists
   * to handle: two callers both read 5, both write 6, and two requests were
   * served for the price of one. The increment is a single atomic statement
   * specifically to make this impossible.
   */
  it("loses no counts when requests arrive together", async () => {
    const headers = trusted("203.0.113.90");
    const token = "token-rrrrrrrrrrrrrrrrrrrr";

    const decisions = await Promise.all(
      Array.from({ length: 30 }, () => rateLimit("save", headers, token)),
    );

    // Every caller saw a distinct count, and the total is exact.
    const counts = decisions.map((d) => d.count).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

    const row = await prisma.rateLimitCounter.findFirstOrThrow();
    expect(row.count).toBe(30);
  });
});
