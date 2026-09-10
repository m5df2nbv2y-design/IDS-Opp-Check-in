import { redirect } from "next/navigation";
import { authorize, getAuthorizationPolicy, type AuthorizationDenial } from "./authorization";
import { auth, DEV_BYPASS_ENABLED } from "./config";

/**
 * THE AUTHENTICATION AND AUTHORIZATION BOUNDARY.
 *
 * Next's own guidance is that proxy.ts may be deployed to a CDN and must not be
 * relied on for authorization — it is an optimistic check only. Real
 * enforcement therefore lives here, called close to the data:
 *
 *   - `requireAdminPage()` in the /admin layout               → redirects
 *   - `requireAdminActor()` at the top of EVERY server action → throws
 *
 * A layout guard does not protect a POST. Server actions are individually
 * addressable HTTP endpoints, so each must assert for itself.
 *
 * Both checks run: authenticated (who are you) AND authorized (may you be
 * here). Authorization is evaluated from claims in the signed session token,
 * never from anything the client supplies, and is re-evaluated on every
 * mutation rather than only at sign-in.
 */

export class UnauthorizedError extends Error {
  constructor(message = "Not signed in. This action requires an authenticated IDS admin.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Authenticated, but not permitted. Deliberately distinct from Unauthorized. */
export class ForbiddenError extends Error {
  readonly reason: AuthorizationDenial;

  constructor(reason: AuthorizationDenial, message: string) {
    super(message);
    this.name = "ForbiddenError";
    this.reason = reason;
  }
}

export type AdminUser = {
  id: string;
  name: string | null;
  email: string | null;
  /** Entra object id — stable per tenant, unlike email. Null for the dev admin. */
  oid: string | null;
  roles: string[];
  isDevAdmin: boolean;
};

/** The signed-in user, authorized or not. Never throws. */
export async function getSignedInUser(): Promise<AdminUser | null> {
  const session = await auth();
  if (!session?.user) return null;

  return {
    id: session.user.id ?? "unknown",
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    oid: session.user.oid ?? null,
    roles: session.user.roles ?? [],
    isDevAdmin: Boolean(session.user.isDevAdmin),
  };
}

/** Authentication + authorization decision for the current request. */
async function decide() {
  const session = await auth();
  if (!session?.user) return { user: null, result: null };

  const user: AdminUser = {
    id: session.user.id ?? "unknown",
    name: session.user.name ?? null,
    email: session.user.email ?? null,
    oid: session.user.oid ?? null,
    roles: session.user.roles ?? [],
    isDevAdmin: Boolean(session.user.isDevAdmin),
  };

  const policy = getAuthorizationPolicy(process.env, DEV_BYPASS_ENABLED);
  const result = authorize(
    {
      roles: session.user.roles ?? [],
      groups: session.user.groups ?? [],
      groupsOverage: Boolean(session.user.groupsOverage),
      isDevAdmin: user.isDevAdmin,
    },
    policy,
  );

  return { user, result };
}

/** The authorized admin, or null when absent or not permitted. Never throws. */
export async function getAdminUser(): Promise<AdminUser | null> {
  const { user, result } = await decide();
  if (!user || !result?.authorized) return null;
  return user;
}

/**
 * Assert an authenticated AND authorized admin. THROWS — use at the top of
 * every server action and any other mutation entry point.
 */
export async function requireAdmin(): Promise<AdminUser> {
  const { user, result } = await decide();
  if (!user || !result) throw new UnauthorizedError();
  if (!result.authorized) throw new ForbiddenError(result.reason, result.message);
  return user;
}

/**
 * Assert for a page render. Redirects rather than throwing: an unauthenticated
 * visitor gets sign-in, an authenticated-but-unauthorized one gets a page
 * explaining why, instead of an error stack.
 */
export async function requireAdminPage(): Promise<AdminUser> {
  const { user, result } = await decide();
  if (!user || !result) redirect("/signin");
  if (!result.authorized) redirect(`/not-authorized?reason=${result.reason}`);
  return user;
}

/**
 * Assert an authorized admin AND return their identity for audit entries.
 *
 * The call every server action makes as its first statement: one line that
 * enforces the boundary and attributes the change to a real person.
 */
export async function requireAdminActor(): Promise<string> {
  const user = await requireAdmin();
  return user.email ?? user.name ?? user.oid ?? user.id;
}
