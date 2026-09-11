import type { NextConfig } from "next";

/**
 * Baseline security headers.
 *
 * Applied to every response, including the public /checkin pages, which are the
 * only part of the application an outsider can reach. Deliberately conservative
 * — nothing here needs a CSP nonce pipeline, which would be a larger change
 * than this pass warrants.
 */
const securityHeaders = [
  // The check-in page must not be embeddable: a framed check-in could be
  // overlaid to trick a customer into submitting something they cannot see.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // A check-in token sits in the URL path, so referrers must not carry it to
  // third parties. The policy above already prevents cross-origin leakage.
  { key: "X-DNS-Prefetch-Control", value: "off" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // Only meaningful over HTTPS; ignored by browsers on plain HTTP, so it is
  // safe to send in development too.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
