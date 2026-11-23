import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/config", () => ({ auth: async () => null, signOut: async () => undefined, DEV_BYPASS_ENABLED: false }));

/**
 * Capacity (Josh, 2026-11-23): a launch to every eligible contact on today's
 * catalogue is 339 emails, sent one by one inside the launch action. Vercel's
 * 300 s default is too close, so admin pages (and their Server Actions) get
 * Vercel Pro's 800 s maximum.
 */
describe("admin function time limit", () => {
  it("raises maxDuration to 800 s for every admin page and its actions", async () => {
    const layout = await import("@/app/admin/layout");
    expect(layout.maxDuration).toBe(800);
  });
});
