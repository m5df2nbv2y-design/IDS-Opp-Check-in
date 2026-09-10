import { describe, expect, it, vi } from "vitest";
import {
  authorize,
  claimsFromProfile,
  getAuthorizationPolicy,
} from "@/server/auth/authorization";

/**
 * Authentication proves who someone is. Authorization decides whether they may
 * be here. Every employee in the tenant can authenticate; only Sales Operations
 * should reach /admin.
 *
 * The governing property: fail CLOSED. An unconfigured policy, a missing claim,
 * or an unreadable group list all deny — never admit.
 */

const APP_ROLE_POLICY = { kind: "app-role", requiredRole: "SalesOps.Admin" } as const;
const GROUP_POLICY = { kind: "group", requiredGroupId: "group-abc" } as const;

describe("authorization policy selection", () => {
  it("prefers App Role over raw group claims when both are configured", () => {
    const policy = getAuthorizationPolicy({
      AUTH_REQUIRED_APP_ROLE: "SalesOps.Admin",
      AUTH_REQUIRED_GROUP_ID: "group-abc",
    });
    expect(policy).toEqual({ kind: "app-role", requiredRole: "SalesOps.Admin" });
  });

  it("falls back to a group id when no App Role is set", () => {
    expect(getAuthorizationPolicy({ AUTH_REQUIRED_GROUP_ID: "group-abc" })).toEqual({
      kind: "group",
      requiredGroupId: "group-abc",
    });
  });

  it("is UNCONFIGURED when nothing is set — nobody is authorized", () => {
    expect(getAuthorizationPolicy({})).toEqual({ kind: "unconfigured" });
    expect(getAuthorizationPolicy({ AUTH_REQUIRED_APP_ROLE: "   " })).toEqual({
      kind: "unconfigured",
    });
  });
});

describe("authorize", () => {
  it("ADMITS a user holding the required App Role", () => {
    const result = authorize({ roles: ["SalesOps.Admin"] }, APP_ROLE_POLICY);
    expect(result).toEqual({ authorized: true, reason: "APP_ROLE" });
  });

  it("DENIES an authenticated user without the role", () => {
    const result = authorize({ roles: ["SomeOther.Role"] }, APP_ROLE_POLICY);
    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.reason).toBe("MISSING_APP_ROLE");
    expect(result.message).toContain("SalesOps.Admin");
  });

  it("DENIES an authenticated user with no roles at all", () => {
    expect(authorize({}, APP_ROLE_POLICY).authorized).toBe(false);
    expect(authorize({ roles: [] }, APP_ROLE_POLICY).authorized).toBe(false);
  });

  it("matches the role exactly — no prefix or case slippage", () => {
    for (const role of ["salesops.admin", "SalesOps.Admin.Extra", "SalesOps", "Admin"]) {
      expect(authorize({ roles: [role] }, APP_ROLE_POLICY).authorized, role).toBe(false);
    }
  });

  it("ADMITS on group membership when group mode is configured", () => {
    expect(authorize({ groups: ["group-abc"] }, GROUP_POLICY)).toEqual({
      authorized: true,
      reason: "GROUP",
    });
  });

  it("DENIES when the group is absent", () => {
    const result = authorize({ groups: ["group-other"] }, GROUP_POLICY);
    expect(result.authorized).toBe(false);
    if (!result.authorized) expect(result.reason).toBe("MISSING_GROUP");
  });

  it("reports a groups OVERAGE distinctly from 'not in the group'", () => {
    // Entra withheld the groups; claiming the user is not a member would be a
    // false statement about them.
    const result = authorize({ groups: [], groupsOverage: true }, GROUP_POLICY);
    expect(result.authorized).toBe(false);
    if (result.authorized) return;
    expect(result.reason).toBe("GROUPS_OVERAGE");
    expect(result.message).toContain("App Role");
  });

  it("FAILS CLOSED when no policy is configured — even with plausible claims", () => {
    for (const claims of [
      {},
      { roles: ["SalesOps.Admin"] },
      { roles: ["Anything"], groups: ["group-abc"] },
    ]) {
      const result = authorize(claims, { kind: "unconfigured" });
      expect(result.authorized).toBe(false);
      if (!result.authorized) expect(result.reason).toBe("NOT_CONFIGURED");
    }
  });

  it("never admits a tenant member merely for being authenticated", () => {
    // The whole point: authentication alone is not access.
    const result = authorize({ roles: [], groups: [] }, APP_ROLE_POLICY);
    expect(result.authorized).toBe(false);
  });

  it("admits the development identity, which cannot exist in production", () => {
    expect(authorize({ isDevAdmin: true }, { kind: "unconfigured" })).toEqual({
      authorized: true,
      reason: "DEV_BYPASS",
    });
    expect(authorize({ isDevAdmin: true }, APP_ROLE_POLICY).authorized).toBe(true);
  });
});

describe("claim extraction from an Entra profile", () => {
  it("reads the roles claim", () => {
    expect(claimsFromProfile({ roles: ["SalesOps.Admin", "Other"] }).roles).toEqual([
      "SalesOps.Admin",
      "Other",
    ]);
  });

  it("tolerates groups arriving as a string or an array", () => {
    expect(claimsFromProfile({ groups: "group-abc" }).groups).toEqual(["group-abc"]);
    expect(claimsFromProfile({ groups: ["a", "b"] }).groups).toEqual(["a", "b"]);
    expect(claimsFromProfile({}).groups).toEqual([]);
  });

  it("detects the groups overage marker", () => {
    const claims = claimsFromProfile({
      _claim_names: { groups: "src1" },
      _claim_sources: { src1: { endpoint: "https://graph.microsoft.com/..." } },
    });
    expect(claims.groupsOverage).toBe(true);
    expect(claimsFromProfile({ groups: ["a"] }).groupsOverage).toBe(false);
  });

  it("ignores non-string junk in the claims", () => {
    const claims = claimsFromProfile({ roles: ["ok", 42, null], groups: 99 });
    expect(claims.roles).toEqual(["ok"]);
    expect(claims.groups).toEqual([]);
  });
});

describe("requireAdmin enforces authorization, not just authentication", () => {
  const withSession = async (user: Record<string, unknown> | null, env: Record<string, string>) => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    vi.doMock("@/server/auth/config", () => ({
      auth: async () => (user ? { user } : null),
      DEV_BYPASS_ENABLED: false,
    }));
    return import("@/server/auth/require-admin");
  };

  it("throws UnauthorizedError when NOT signed in", async () => {
    const mod = await withSession(null, { AUTH_REQUIRED_APP_ROLE: "SalesOps.Admin" });
    await expect(mod.requireAdmin()).rejects.toThrow(mod.UnauthorizedError);
    expect(await mod.getAdminUser()).toBeNull();
    vi.unstubAllEnvs();
    vi.doUnmock("@/server/auth/config");
  });

  it("throws ForbiddenError when signed in WITHOUT the role", async () => {
    const mod = await withSession(
      { id: "u1", email: "someone@idsculpture.com", roles: ["Other.Role"] },
      { AUTH_REQUIRED_APP_ROLE: "SalesOps.Admin" },
    );

    await expect(mod.requireAdmin()).rejects.toThrow(mod.ForbiddenError);
    await expect(mod.requireAdminActor()).rejects.toThrow(mod.ForbiddenError);
    // Authenticated but unauthorized is NOT the same as signed out.
    expect(await mod.getSignedInUser()).not.toBeNull();
    expect(await mod.getAdminUser()).toBeNull();

    vi.unstubAllEnvs();
    vi.doUnmock("@/server/auth/config");
  });

  it("admits a signed-in user WITH the role and returns their audit identity", async () => {
    const mod = await withSession(
      { id: "u2", email: "josh@idsculpture.com", name: "Josh", roles: ["SalesOps.Admin"], oid: "oid-1" },
      { AUTH_REQUIRED_APP_ROLE: "SalesOps.Admin" },
    );

    const user = await mod.requireAdmin();
    expect(user.email).toBe("josh@idsculpture.com");
    expect(user.oid).toBe("oid-1");
    expect(await mod.requireAdminActor()).toBe("josh@idsculpture.com");
    expect(await mod.getAdminUser()).not.toBeNull();

    vi.unstubAllEnvs();
    vi.doUnmock("@/server/auth/config");
  });

  it("denies everyone when the policy is unconfigured", async () => {
    const mod = await withSession(
      { id: "u3", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"] },
      {},
    );
    await expect(mod.requireAdmin()).rejects.toThrow(mod.ForbiddenError);
    vi.unstubAllEnvs();
    vi.doUnmock("@/server/auth/config");
  });
});
