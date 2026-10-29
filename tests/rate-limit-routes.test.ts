import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDatabase } from "./fixtures";

/**
 * The limiter through the real route handlers, in enforcing mode.
 *
 * The module tests in rate-limit.test.ts prove the counting. This file proves
 * the two things a recipient's browser actually depends on: that the route
 * returns 429 rather than carrying on, and that it carries `Retry-After` so
 * the client shows a countdown instead of inviting an immediate re-tap.
 *
 * The mode is stubbed and the module registry reset before importing, because
 * `src/lib/env.ts` reads configuration once at load. Importing the route
 * normally would get the default count-only mode and never refuse anything,
 * which is correct for production and useless for this assertion.
 */

const TOKEN = "x".repeat(43); // the shape issueToken() produces; resolves to nothing

async function enforcingRoutes() {
  vi.stubEnv("RATE_LIMIT_MODE", "enforce");
  vi.resetModules();
  const complete = await import("@/app/api/checkin/[token]/complete/route");
  const responses = await import("@/app/api/checkin/[token]/responses/route");
  return { complete, responses };
}

function post(body?: unknown): Request {
  return new Request("https://checkin.test/api/checkin/token/x", {
    method: "POST",
    headers: { "x-vercel-forwarded-for": "203.0.113.200", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(async () => {
  await resetDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("POST /api/checkin/[token]/complete", () => {
  it("answers 429 with Retry-After once the ceiling is passed", async () => {
    const { complete } = await enforcingRoutes();

    // Completion allows 10/min. These all resolve to no recipient, so they
    // return 404 — the point is that the limiter counted them.
    for (let i = 0; i < 10; i += 1) {
      const response = await complete.POST(post(), params(TOKEN) as never);
      expect(response.status, `call ${i + 1}`).not.toBe(429);
    }

    const limited = await complete.POST(post(), params(TOKEN) as never);
    expect(limited.status).toBe(429);

    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const body = (await limited.json()) as Record<string, unknown>;
    expect(body.reason).toBe("RATE_LIMITED");
    // The refusal must not echo the token back to the caller.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });
});

describe("POST /api/checkin/[token]/responses", () => {
  it("counts a malformed body too, so a flood of junk is bounded", async () => {
    const { responses } = await enforcingRoutes();

    // Not valid input: no itemId or stage. It is rejected with 400, but it
    // still costs us a request, so the limiter runs BEFORE the body is parsed.
    const first = await responses.POST(post({ nonsense: true }), params(TOKEN) as never);
    expect(first.status).toBe(400);

    // Saving allows 120/min. Spend the rest of the window on junk.
    for (let i = 1; i < 120; i += 1) {
      await responses.POST(post({ nonsense: true }), params(TOKEN) as never);
    }

    const limited = await responses.POST(post({ nonsense: true }), params(TOKEN) as never);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  it("keeps the save and completion ceilings separate", async () => {
    const { complete, responses } = await enforcingRoutes();

    // Exhaust completion (10).
    for (let i = 0; i < 11; i += 1) {
      await complete.POST(post(), params(TOKEN) as never);
    }
    expect((await complete.POST(post(), params(TOKEN) as never)).status).toBe(429);

    // A save is still accepted: a recipient who double-tapped submit is not
    // then prevented from correcting an answer.
    const save = await responses.POST(post({ nonsense: true }), params(TOKEN) as never);
    expect(save.status).not.toBe(429);
  });
});
