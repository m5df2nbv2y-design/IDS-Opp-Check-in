import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { resetDatabase } from "./fixtures";

/**
 * The Graph readiness check (Josh, 2026-11-19): confirms the GRAPH_* settings,
 * the app token and the Mail.Send role WITHOUT sending, so going live is
 * "add settings, run check, one internal test send, switch on".
 */

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/admin/outbox",
  useSearchParams: () => new URLSearchParams(),
}));

const BASE_ENV = {
  VERCEL_ENV: "production",
  EMAIL_PROVIDER: "mock",
  GRAPH_TENANT_ID: "tenant-synthetic",
  GRAPH_CLIENT_ID: "client-synthetic",
  GRAPH_CLIENT_SECRET: "secret-synthetic",
  GRAPH_SENDER_MAILBOX: "hello@idsculpture.test",
};
const LEAKS = ["secret-synthetic", "tenant-synthetic", "client-synthetic", "synthetic-signature", "AADSTS7000215"];

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.synthetic-signature`;
const tokenResponse = (claims: Record<string, unknown>) =>
  new Response(JSON.stringify({ access_token: token(claims), expires_in: 3599 }), { status: 200 });

async function check(env: Record<string, string>, answer: () => Response) {
  for (const [key, value] of Object.entries({ ...BASE_ENV, ...env })) vi.stubEnv(key, value);
  const fetchMock = vi.fn<(url: unknown) => Promise<Response>>(async () => answer());
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { GraphEmailService } = await import("@/server/integrations/email/graph-email-service");
  const result = await new GraphEmailService().checkReadiness();
  return { result, fetchMock };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Graph readiness check", () => {
  it("passes when the token carries Mail.Send, while email is still simulated, and sends nothing", async () => {
    const { result, fetchMock } = await check({}, () => tokenResponse({ roles: ["Mail.Send"] }));
    expect(result).toEqual({ missing: [], mailbox: "hello@idsculpture.test", roles: ["Mail.Send"], mailSend: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/oauth2/v2.0/token");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/sendMail"))).toBe(false);
    for (const leak of LEAKS) expect(JSON.stringify(result)).not.toContain(leak);
  });

  it("reports a token without Mail.Send, listing what it does carry", async () => {
    const { result } = await check({}, () => tokenResponse({ roles: ["User.Read.All"] }));
    expect(result).toMatchObject({ roles: ["User.Read.All"], mailSend: false });
    expect(result.error).toBeUndefined();
  });

  it("treats a token with no roles claim as consent not granted", async () => {
    const { result } = await check({}, () => tokenResponse({}));
    expect(result).toMatchObject({ roles: [], mailSend: false });
  });

  it("names the missing settings and calls Microsoft for nothing", async () => {
    const { result, fetchMock } = await check({ GRAPH_CLIENT_SECRET: "", GRAPH_SENDER_MAILBOX: " " }, () => tokenResponse({ roles: ["Mail.Send"] }));
    expect(result).toEqual({ missing: ["GRAPH_CLIENT_SECRET", "GRAPH_SENDER_MAILBOX"], mailbox: "", roles: [], mailSend: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a rejected token request shows only the HTTP status, never Microsoft's body", async () => {
    const { result } = await check({}, () => new Response(JSON.stringify({ error: "AADSTS7000215 invalid secret-synthetic" }), { status: 401 }));
    expect(result).toMatchObject({ mailSend: false, roles: [] });
    expect(result.error).toMatch(/HTTP 401/);
    for (const leak of LEAKS) expect(JSON.stringify(result)).not.toContain(leak);
  });

  it("refuses outside Production and calls Microsoft for nothing", async () => {
    const { result, fetchMock } = await check({ VERCEL_ENV: "preview" }, () => tokenResponse({ roles: ["Mail.Send"] }));
    expect(result.mailSend).toBe(false);
    expect(result.error).toBe("The Graph readiness check runs only in Production.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Graph readiness check, edge cases", () => {
  it("a second check gets a fresh token, so consent granted in between shows up", async () => {
    let roles: string[] = [];
    for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
    const fetchMock = vi.fn<(url: unknown) => Promise<Response>>(async () => tokenResponse({ roles }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { GraphEmailService } = await import("@/server/integrations/email/graph-email-service");
    expect((await new GraphEmailService().checkReadiness()).mailSend).toBe(false);
    roles = ["Mail.Send"];
    expect((await new GraphEmailService().checkReadiness()).mailSend).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a token that cannot be decoded, or odd roles, never throws", async () => {
    const malformed = await check({}, () => new Response(JSON.stringify({ access_token: "not-a-jwt", expires_in: 3599 }), { status: 200 }));
    expect(malformed.result).toMatchObject({ roles: [], mailSend: false });
    const mixed = await check({}, () => tokenResponse({ roles: ["Mail.Send", 7, null] }));
    expect(mixed.result).toMatchObject({ roles: ["Mail.Send"], mailSend: true });
    const notArray = await check({}, () => tokenResponse({ roles: "Mail.Send" }));
    expect(notArray.result).toMatchObject({ roles: [], mailSend: false });
  });
});

describe("the Outbox readiness card", () => {
  async function renderOutbox(query: Record<string, string>, roles: string[] = ["Mail.Send"]) {
    await resetDatabase();
    for (const [key, value] of Object.entries({ ...BASE_ENV, AUTH_REQUIRED_APP_ROLE: "SalesOps.Admin" })) vi.stubEnv(key, value);
    session.current = { user: { id: "u1", name: "Admin", email: "admin@example.com", roles: ["SalesOps.Admin"], oid: "oid-1" } };
    const fetchMock = vi.fn<(url: unknown) => Promise<Response>>(async () => tokenResponse({ roles }));
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
    const { default: OutboxPage } = await import("@/app/admin/outbox/page");
    const html = renderToStaticMarkup(await OutboxPage({ searchParams: Promise.resolve(query) } as never));
    return { html, fetchMock };
  }

  it("shows the provider and a Run check link, and calls Microsoft for nothing until asked", async () => {
    const { html, fetchMock } = await renderOutbox({});
    expect(html).toContain("Email readiness (Microsoft Graph)");
    expect(html).toContain("/admin/outbox?check=1");
    expect(html).toMatch(/Email provider in use: <span[^>]*>Simulated outbox</);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on ?check=1 shows Ready with Mail.Send granted, and no secret", async () => {
    const { html } = await renderOutbox({ check: "1" });
    expect(html).toContain("Token and Mail.Send permission OK. The internal test send is still required.");
    expect(html).toContain("granted");
    expect(html).toContain("hello@idsculpture.test");
    expect(html).toContain("The internal test send confirms both.");
    for (const leak of LEAKS) expect(html).not.toContain(leak);
  });

  it("on ?check=1 without consent shows Not ready and says consent is missing", async () => {
    const { html } = await renderOutbox({ check: "1" }, []);
    expect(html).toContain("Not ready.");
    expect(html).toContain("not granted");
    expect(html).toContain("admin consent not given yet");
    expect(html).not.toContain("The internal test send confirms both.");
  });
});
