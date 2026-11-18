import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import nextConfig from "../next.config";
import { config, proxy } from "../src/proxy";

/**
 * The CSP is issued per request by proxy.ts, with a fresh nonce each time.
 * These tests drive the proxy directly, the same way Next calls it.
 */
const SESSION = "authjs.session-token=x";

function get(path: string, cookie?: string) {
  return proxy(
    new NextRequest(`https://checkin.test${path}`, {
      headers: cookie ? { cookie } : {},
    }),
  );
}

function csp(path: string, cookie?: string) {
  const value = get(path, cookie).headers.get("Content-Security-Policy");
  expect(value).toBeTruthy();
  return value!;
}

function nonceOf(policy: string) {
  return /'nonce-([^']+)'/.exec(policy)?.[1];
}

afterEach(() => vi.unstubAllEnvs());

describe("the Content-Security-Policy", () => {
  it("carries every required directive in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const policy = csp("/checkin/abc");
    const nonce = nonceOf(policy);
    expect(nonce).toBeTruthy();
    for (const directive of [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic';`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self' https://login.microsoftonline.com",
      "frame-ancestors 'none'",
      "upgrade-insecure-requests",
    ]) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("report-");
  });

  it("adds 'unsafe-eval' only in development, and drops upgrade-insecure-requests there", () => {
    vi.stubEnv("NODE_ENV", "development");
    const policy = csp("/signin");
    expect(policy).toContain(`script-src 'self' 'nonce-${nonceOf(policy)}' 'strict-dynamic' 'unsafe-eval'`);
    expect(policy).not.toContain("upgrade-insecure-requests");
  });

  it("issues a fresh nonce on every request", () => {
    vi.stubEnv("NODE_ENV", "production");
    const nonces = new Set(Array.from({ length: 5 }, () => nonceOf(csp("/checkin/abc"))));
    expect(nonces.size).toBe(5);
  });

  it("passes the policy to the renderer on the request so Next can apply the nonce", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = get("/checkin/abc");
    const policy = response.headers.get("Content-Security-Policy")!;
    // NextResponse.next({ request: { headers } }) forwards overridden request
    // headers via x-middleware-request-* on the response.
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonceOf(policy));
  });

  it("is applied to a check-in route and to an admin route", () => {
    expect(csp("/checkin/some-token")).toContain("default-src 'self'");
    expect(csp("/admin/campaigns/1", SESSION)).toContain("default-src 'self'");
  });

  it("matches page routes but not API routes, static assets or public files", () => {
    const matches = (url: string, headers?: Record<string, string>) =>
      unstable_doesMiddlewareMatch({ config, url, headers });
    for (const url of ["/checkin/abc", "/signin", "/admin", "/recipient-preview", "/nope", "/apiary"]) {
      expect(matches(url), url).toBe(true);
    }
    for (const url of ["/api/x", "/_next/static/x", "/_next/image", "/brand/logo.png", "/favicon.ico", "/robots.txt"]) {
      expect(matches(url), url).toBe(false);
    }
  });

  it("skips prefetches for the CSP, but an /admin prefetch still hits the sign-in entry", () => {
    for (const headers of [{ "next-router-prefetch": "1" }, { purpose: "prefetch" }]) {
      expect(unstable_doesMiddlewareMatch({ config, url: "/checkin/abc", headers })).toBe(false);
      expect(unstable_doesMiddlewareMatch({ config, url: "/admin", headers })).toBe(true);
    }
  });

  it("lives next to app/, the only place Next runs it", () => {
    // A root proxy.ts is silently ignored when the app is under src/.
    expect(existsSync(new URL("../proxy.ts", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../src/proxy.ts", import.meta.url))).toBe(true);
  });
});

describe("the baseline headers are kept", () => {
  it("still sends every baseline header on every path", async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((r) => r.source === "/:path*")!;
    const keys = rule.headers.map((h) => h.key);
    for (const key of [
      "X-Frame-Options",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "X-DNS-Prefetch-Control",
      "Permissions-Policy",
      "Strict-Transport-Security",
    ]) {
      expect(keys).toContain(key);
    }
  });
});

describe("the sign-in redirect is unchanged", () => {
  it("redirects an /admin request with no session to sign-in", () => {
    for (const path of ["/admin", "/admin/campaigns/1"]) {
      const response = get(path);
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/signin");
      expect(location.searchParams.get("from")).toBe(path);
    }
  });

  it("lets an /admin request with a session through", () => {
    expect(get("/admin", SESSION).headers.get("location")).toBeNull();
    expect(get("/admin", "__Secure-authjs.session-token=x").headers.get("location")).toBeNull();
  });

  it("never redirects a check-in or other public page, even with no session", () => {
    for (const path of ["/checkin/abc", "/checkin/bad", "/signin", "/recipient-preview", "/administrator", "/"]) {
      const response = get(path);
      expect(response.headers.get("location"), path).toBeNull();
      expect(response.status, path).toBe(200);
    }
  });
});
