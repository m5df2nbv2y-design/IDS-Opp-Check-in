/**
 * Authorization: which authenticated users may use the admin console.
 *
 * Authentication proves who someone is. It does NOT prove they should be here —
 * every employee in the tenant can authenticate, and only Sales Operations
 * should reach /admin.
 *
 * ---------------------------------------------------------------------------
 * Mechanism: Entra App Role, granted via a security group
 * ---------------------------------------------------------------------------
 *   IDS employee
 *     → member of the Sales Operations security group
 *     → that group is assigned the application's App Role in Entra
 *     → the `roles` claim in their token contains the role value
 *     → /admin permitted
 *
 * App Roles rather than raw group claims, deliberately: a user in more than
 * ~200 groups triggers Entra's groups overage, which replaces the `groups`
 * claim with a Graph pointer. Group-based authorization would then fail closed
 * for exactly the most senior people, for a reason invisible in the token. The
 * `roles` claim has no overage behaviour, is scoped to this application, and
 * still lets IDS administer access by group membership.
 *
 * Raw group object ids remain supported as a fallback for orgs that cannot use
 * App Roles.
 *
 * Fails CLOSED: if no policy is configured, nobody is authorized. An
 * unconfigured deployment locks everyone out rather than admitting the tenant.
 */

export type AuthorizationClaims = {
  /** `roles` claim — App Role values assigned to the user or their group. */
  roles?: string[];
  /** `groups` claim — Entra group object ids, when group mode is used. */
  groups?: string[];
  /** True only for the local development bypass identity. */
  isDevAdmin?: boolean;
  /**
   * Set when Entra emitted a groups overage instead of the groups themselves.
   * Distinguishes "not in the group" from "we could not see the groups".
   */
  groupsOverage?: boolean;
};

export type AuthorizationPolicy =
  | { kind: "app-role"; requiredRole: string }
  | { kind: "group"; requiredGroupId: string }
  | { kind: "dev-bypass-only" }
  | { kind: "unconfigured" };

export type AuthorizationResult =
  | { authorized: true; reason: "APP_ROLE" | "GROUP" | "DEV_BYPASS" }
  | { authorized: false; reason: AuthorizationDenial; message: string };

export type AuthorizationDenial =
  | "MISSING_APP_ROLE"
  | "MISSING_GROUP"
  | "GROUPS_OVERAGE"
  | "NOT_CONFIGURED";

/** Reads the configured policy. App Role wins when both are set. */
export function getAuthorizationPolicy(
  env: Record<string, string | undefined> = process.env,
  devBypassEnabled = false,
): AuthorizationPolicy {
  const role = env.AUTH_REQUIRED_APP_ROLE?.trim();
  if (role) return { kind: "app-role", requiredRole: role };

  const groupId = env.AUTH_REQUIRED_GROUP_ID?.trim();
  if (groupId) return { kind: "group", requiredGroupId: groupId };

  // With no policy, the only identity that may pass is the local development
  // admin — and only because that provider cannot exist in production.
  if (devBypassEnabled) return { kind: "dev-bypass-only" };

  return { kind: "unconfigured" };
}

/**
 * Decide whether a set of claims may use the admin console.
 * Pure — no I/O — so every branch is directly testable.
 */
export function authorize(
  claims: AuthorizationClaims,
  policy: AuthorizationPolicy,
): AuthorizationResult {
  // The development identity is authorized under any policy. It only exists
  // when NODE_ENV !== production AND AUTH_DEV_BYPASS=true, so this cannot be
  // reached in a production build.
  if (claims.isDevAdmin) return { authorized: true, reason: "DEV_BYPASS" };

  switch (policy.kind) {
    case "app-role": {
      const roles = claims.roles ?? [];
      if (roles.includes(policy.requiredRole)) {
        return { authorized: true, reason: "APP_ROLE" };
      }
      return {
        authorized: false,
        reason: "MISSING_APP_ROLE",
        message:
          `Your account is not assigned the "${policy.requiredRole}" role for this application. ` +
          `Access is granted by membership of the Sales Operations security group.`,
      };
    }

    case "group": {
      // An overage means Entra withheld the groups, not that the user lacks
      // them. Saying "you're not in the group" would be a false statement.
      if (claims.groupsOverage) {
        return {
          authorized: false,
          reason: "GROUPS_OVERAGE",
          message:
            "Group membership could not be read from the sign-in token (Entra groups overage). " +
            "Switch this application to App Role authorization, which is not subject to overage.",
        };
      }
      const groups = claims.groups ?? [];
      if (groups.includes(policy.requiredGroupId)) {
        return { authorized: true, reason: "GROUP" };
      }
      return {
        authorized: false,
        reason: "MISSING_GROUP",
        message: "Your account is not a member of the group authorized for this application.",
      };
    }

    case "dev-bypass-only":
    case "unconfigured":
      return {
        authorized: false,
        reason: "NOT_CONFIGURED",
        message:
          "No authorization policy is configured for this application. Set " +
          "AUTH_REQUIRED_APP_ROLE to the Entra App Role value that grants access.",
      };
  }
}

/**
 * Extract authorization claims from an Entra token payload.
 * Tolerates the `groups` claim arriving as a string or an array.
 */
export function claimsFromProfile(profile: Record<string, unknown>): AuthorizationClaims {
  const roles = Array.isArray(profile.roles)
    ? profile.roles.filter((role): role is string => typeof role === "string")
    : [];

  const rawGroups = profile.groups;
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((group): group is string => typeof group === "string")
    : typeof rawGroups === "string" && rawGroups.length > 0
      ? [rawGroups]
      : [];

  // Entra signals overage by replacing the claim with a Graph pointer.
  const groupsOverage =
    typeof profile._claim_names === "object" &&
    profile._claim_names !== null &&
    "groups" in (profile._claim_names as Record<string, unknown>);

  return { roles, groups, groupsOverage };
}
