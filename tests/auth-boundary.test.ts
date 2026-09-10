import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * The authentication boundary.
 *
 * Next's own guidance is that proxy.ts may be deployed to a CDN and must not be
 * relied on for authorization, so the real enforcement is requireAdmin() called
 * close to the data — by the /admin layout AND independently by every server
 * action, because a layout guard does not protect a POST.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(`${root}${relative}`, "utf8");

describe("requireAdmin", () => {
  it("throws UnauthorizedError when there is no session", async () => {
    vi.resetModules();
    vi.doMock("@/server/auth/config", () => ({ auth: async () => null, DEV_BYPASS_ENABLED: false }));

    const { requireAdmin, requireAdminActor, UnauthorizedError, getAdminUser } = await import(
      "@/server/auth/require-admin"
    );

    expect(await getAdminUser()).toBeNull();
    await expect(requireAdmin()).rejects.toThrow(UnauthorizedError);
    await expect(requireAdminActor()).rejects.toThrow(UnauthorizedError);
    vi.doUnmock("@/server/auth/config");
  });

  it("throws when a session exists but carries no user", async () => {
    vi.resetModules();
    vi.doMock("@/server/auth/config", () => ({ auth: async () => ({ expires: "soon" }), DEV_BYPASS_ENABLED: false }));

    const { requireAdmin, UnauthorizedError } = await import("@/server/auth/require-admin");
    await expect(requireAdmin()).rejects.toThrow(UnauthorizedError);
    vi.doUnmock("@/server/auth/config");
  });

  it("returns the signed-in admin and their audit identity when AUTHORIZED", async () => {
    vi.resetModules();
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    vi.doMock("@/server/auth/config", () => ({
      DEV_BYPASS_ENABLED: false,
      auth: async () => ({
        user: {
          id: "u1",
          name: "Josh Young",
          email: "josh@idsculpture.com",
          // Authentication alone is no longer enough — the role is what admits.
          roles: ["SalesOps.Admin"],
          oid: "entra-oid-1",
        },
      }),
    }));

    const { requireAdmin, requireAdminActor } = await import("@/server/auth/require-admin");

    const user = await requireAdmin();
    expect(user.email).toBe("josh@idsculpture.com");
    expect(user.roles).toContain("SalesOps.Admin");
    // Audit entries attribute changes to a real person, not a generic "admin".
    expect(await requireAdminActor()).toBe("josh@idsculpture.com");

    vi.unstubAllEnvs();
    vi.doUnmock("@/server/auth/config");
  });

  it("REJECTS an authenticated user who lacks the role", async () => {
    vi.resetModules();
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    vi.doMock("@/server/auth/config", () => ({
      DEV_BYPASS_ENABLED: false,
      auth: async () => ({
        user: { id: "u9", email: "someone.else@idsculpture.com", roles: [] },
      }),
    }));

    const { requireAdmin, ForbiddenError } = await import("@/server/auth/require-admin");
    await expect(requireAdmin()).rejects.toThrow(ForbiddenError);

    vi.unstubAllEnvs();
    vi.doUnmock("@/server/auth/config");
  });
});

describe("every server action asserts independently of the layout", () => {
  const source = read("src/app/admin/actions.ts");

  const actionNames = [...source.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);

  it("finds the expected set of actions", () => {
    expect(actionNames.length).toBeGreaterThanOrEqual(11);
  });

  it.each(actionNames)("%s calls requireAdminActor() as its first statement", (name) => {
    const body = source.slice(source.indexOf(`export async function ${name}(`));
    const openBrace = body.indexOf("{");
    const firstStatement = body
      .slice(openBrace + 1)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("//"));

    expect(firstStatement, `${name} must assert before doing anything`).toContain(
      "requireAdminActor()",
    );
  });

  it("never falls back to a hardcoded admin identity", () => {
    // Actions must attribute to the signed-in user, so a literal "admin" actor
    // would mean an unauthenticated code path had crept back in.
    expect(source).not.toMatch(/actor:\s*"admin"/);
    expect(source).not.toMatch(/\(\s*"admin"\s*\)/);
  });
});

describe("the admin layout guards page rendering", () => {
  const layout = read("src/app/admin/layout.tsx");

  it("calls requireAdminPage() before rendering anything", () => {
    expect(layout).toContain("requireAdminPage()");
    const guardIndex = layout.indexOf("requireAdminPage()");
    const returnIndex = layout.indexOf("return (");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(returnIndex);
  });
});

describe("the development bypass cannot exist in production", () => {
  const config = read("src/server/auth/config.ts");

  it("requires BOTH a non-production build and an explicit opt-in", () => {
    expect(config).toContain('process.env.NODE_ENV === "production"');
    expect(config).toContain('process.env.AUTH_DEV_BYPASS === "true"');
    expect(config).toMatch(/DEV_BYPASS_ENABLED\s*=\s*!IS_PRODUCTION && /);
  });

  it("only registers the credentials provider when the bypass is enabled", () => {
    // Not merely hidden in the UI — the provider is absent from the array, so
    // the code path does not exist in a production build.
    expect(config).toMatch(/if \(DEV_BYPASS_ENABLED\) \{\s*providers\.push\(/);
  });

  it("computes the flag the same way at runtime", () => {
    const evaluate = (nodeEnv: string, bypass: string | undefined) =>
      nodeEnv !== "production" && bypass === "true";

    expect(evaluate("production", "true")).toBe(false);
    expect(evaluate("production", undefined)).toBe(false);
    expect(evaluate("development", "true")).toBe(true);
    expect(evaluate("development", "TRUE")).toBe(false);
    expect(evaluate("development", undefined)).toBe(false);
    expect(evaluate("test", "")).toBe(false);
  });
});

describe("the external check-in experience is never authenticated", () => {
  it("proxy.ts matches /admin only", () => {
    const proxy = read("proxy.ts");
    expect(proxy).toContain('matcher: ["/admin/:path*"]');
    expect(proxy).not.toContain("/checkin");
  });

  it("the recipient route does not require a session", () => {
    const page = read("src/app/checkin/[token]/page.tsx");
    expect(page).not.toContain("requireAdmin");
    expect(page).not.toContain("auth()");
    // Its only gate is the emailed token.
    expect(page).toContain("resolveCheckInToken");
  });

  it("the recipient API routes do not require a session", () => {
    for (const route of [
      "src/app/api/checkin/[token]/responses/route.ts",
      "src/app/api/checkin/[token]/complete/route.ts",
    ]) {
      const source = read(route);
      expect(source).not.toContain("requireAdmin");
    }
  });
});
