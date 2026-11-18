import { NextResponse, type NextRequest } from "next/server";

/**
 * Two jobs, both before a page renders:
 *
 * 1. Content-Security-Policy on every page, with a fresh nonce per request.
 *    Next reads the nonce from the request's CSP header and applies it to its
 *    own scripts, so an injected inline script cannot run. This matters most on
 *    the public check-in page, whose URL carries a live bearer token.
 *
 * 2. OPTIMISTIC sign-in redirect for /admin only — NOT the authentication
 *    boundary. Next's documentation is explicit that proxy runs before rendering
 *    and may be deployed to a CDN, so it must not be relied on for authorization.
 *    The real enforcement is requireAdmin() / requireAdminPage() in
 *    src/server/auth/require-admin.ts. The external check-in experience must
 *    never be touched by this redirect.
 */
function contentSecurityPolicy(nonce: string) {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    // 'unsafe-eval' only in development: React uses eval for debug stacks.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // next/image writes inline style attributes, which a nonce cannot cover.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // /signin posts through Auth.js to Microsoft Entra.
    "form-action 'self' https://login.microsoftonline.com",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

function isAdminPath(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export function proxy(request: NextRequest) {
  if (isAdminPath(request.nextUrl.pathname)) {
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
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);

  const requestHeaders = new Headers(request.headers);
  // Any future next/script or inline script must read this via headers().get("x-nonce").
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    // Sign-in redirect: every /admin request, prefetches included, as before.
    "/admin/:path*",
    // CSP: every page. Skips API routes, static assets, public files and prefetches.
    {
      source:
        "/((?!api/|_next/static|_next/image|favicon.ico|brand/|.*\\.(?:png|jpg|jpeg|webp|svg|ico|txt|xml)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
