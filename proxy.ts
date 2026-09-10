import { NextResponse, type NextRequest } from "next/server";

/**
 * OPTIMISTIC redirect only — NOT the authentication boundary.
 *
 * Next's documentation is explicit that proxy runs before rendering and may be
 * deployed to a CDN, so it must not be relied on for authorization. This exists
 * purely so an unauthenticated visitor is bounced to sign-in before a page
 * renders, rather than seeing a flash of the console.
 *
 * The real enforcement is requireAdmin() / requireAdminPage() in
 * src/server/auth/require-admin.ts, called by the admin layout and by every
 * server action. Deleting this file would cost UX polish, not security.
 */
export function proxy(request: NextRequest) {
  // Presence of a session cookie only — its validity is checked server-side by
  // the real boundary. Auth.js prefixes the cookie with __Secure- over HTTPS.
  const hasSessionCookie =
    request.cookies.has("authjs.session-token") ||
    request.cookies.has("__Secure-authjs.session-token");

  if (!hasSessionCookie) {
    const signIn = new URL("/signin", request.url);
    signIn.searchParams.set("from", request.nextUrl.pathname);
    return NextResponse.redirect(signIn);
  }

  return NextResponse.next();
}

export const config = {
  // /admin only. The external check-in experience must never be touched.
  matcher: ["/admin/:path*"],
};
