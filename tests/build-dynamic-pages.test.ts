import { describe, expect, it } from "vitest";
import { prerenderedPages } from "../scripts/check-dynamic-pages";

/**
 * Pages must render per request so Next can put the CSP nonce on their scripts.
 * A prerendered page carries no nonce and the policy blocks its scripts, so the
 * build fails instead (Josh, 2026-11-19).
 */
describe("dynamic pages build check", () => {
  it("passes when only Next's own fallbacks are prerendered", () => {
    expect(prerenderedPages({ routes: { "/_global-error": {}, "/icon.png": {}, "/apple-icon.png": {} } })).toEqual([]);
  });

  it("names every other prerendered page", () => {
    expect(prerenderedPages({ routes: { "/_global-error": {}, "/signin": {}, "/checkin/[token]": {} } })).toEqual(["/signin", "/checkin/[token]"]);
  });

  it("names a prerendered [param] page shell", () => {
    expect(prerenderedPages({ routes: {}, dynamicRoutes: { "/checkin/[token]": {} } })).toEqual(["/checkin/[token]"]);
  });

  it("an empty manifest passes", () => {
    expect(prerenderedPages({ routes: {} })).toEqual([]);
  });
});
