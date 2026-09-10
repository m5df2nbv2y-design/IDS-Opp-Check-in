import { redirect } from "next/navigation";
import { auth } from "./config";

/**
 * THE AUTHENTICATION BOUNDARY.
 *
 * Next's own guidance is that proxy.ts (formerly middleware) may be deployed to
 * a CDN and must not be relied on for authorization — it is an optimistic
 * check only. Real enforcement therefore lives here, called close to the data:
 *
 *   - `requireAdminPage()` in the /admin layout        → redirects
 *   - `requireAdmin()` at the top of EVERY server action → throws
 *
 * A layout guard does not protect a POST. Server actions are individually
 * addressable HTTP endpoints, so each one must assert for itself; that is why
 * this is a required call in every mutation rather than an inherited property
 * of the route.
 */

export class UnauthorizedError extends Error {
  constructor(message = "Not signed in. This action requires an authenticated IDS admin.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export type AdminUser = {
  id: string;
  name: string | null;
  email: string | null;
};

/** The signed-in admin, or null. Never throws — for rendering decisions. */
export async function getAdminUser(): Promise<AdminUser | null> {
  const session = await auth();
  if (!session?.user) return null;
  return {
    id: session.user.id ?? "unknown",
    name: session.user.name ?? null,
    email: session.user.email ?? null,
  };
}

/**
 * Assert an authenticated admin. THROWS — use at the top of every server
 * action and any other mutation entry point.
 */
export async function requireAdmin(): Promise<AdminUser> {
  const user = await getAdminUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/**
 * Assert an authenticated admin for a page render. REDIRECTS to sign-in rather
 * than throwing, so an unauthenticated visitor gets a login screen.
 */
export async function requireAdminPage(): Promise<AdminUser> {
  const user = await getAdminUser();
  if (!user) redirect("/signin");
  return user;
}

/**
 * Assert an authenticated admin AND return their identity for audit entries.
 *
 * This is the call every server action makes as its first statement: one line
 * that both enforces the boundary and attributes the change to a real person
 * rather than a generic "admin".
 */
export async function requireAdminActor(): Promise<string> {
  const user = await requireAdmin();
  return user.email ?? user.name ?? user.id;
}
