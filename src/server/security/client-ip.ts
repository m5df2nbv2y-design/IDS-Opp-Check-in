/**
 * The client IP a rate limiter is allowed to count on.
 *
 * This is the part of a limiter that is easiest to get quietly wrong. Any
 * client can send `X-Forwarded-For: 1.2.3.4`. If that is trusted, two things
 * follow, and the second is worse than the first:
 *
 *   1. An attacker rotates the header and is never limited.
 *   2. An attacker SETS SOMEONE ELSE'S address and spends their allowance,
 *      throttling a real recipient. A limiter that can be aimed at a customer
 *      is worse than no limiter.
 *
 * So a header is only trusted when the platform in front of us is known to
 * overwrite it. On Vercel that is `x-vercel-forwarded-for`, which the proxy
 * sets from the connection it terminated; a value a client puts there does not
 * survive. `x-real-ip` is also platform-set. Plain `x-forwarded-for` is a
 * client-appendable list and is used only as a last resort, leftmost entry,
 * because that is where the platform puts the real peer.
 */

/** Headers in order of trustworthiness, most trusted first. */
const TRUSTED = ["x-vercel-forwarded-for", "x-real-ip"] as const;

export type ClientIp =
  /** An address we are willing to count against. */
  | { known: true; ip: string; trusted: boolean }
  /** No usable address. The caller must decide, and must not invent a key. */
  | { known: false };

/**
 * `trusted: false` means the address came from a client-appendable header. It
 * is still the best guess available for local development, but a limiter
 * should treat it as advisory: see `rateLimit`, which refuses to ENFORCE on an
 * untrusted address while still counting it.
 */
export function clientIp(headers: Headers): ClientIp {
  for (const name of TRUSTED) {
    const value = normalize(headers.get(name));
    if (value) return { known: true, ip: value, trusted: true };
  }

  // Leftmost entry: proxies append, so the original peer is first.
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = normalize(forwarded.split(",")[0]);
    if (first) return { known: true, ip: first, trusted: false };
  }

  return { known: false };
}

/**
 * Keep the address short, printable and bounded. An unbounded value would
 * become an unbounded primary key, which is its own denial-of-service vector.
 */
function normalize(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || value.length > 45) return null; // 45 = longest IPv6 text form
  // Anything outside hex, dots, colons and brackets is not an address.
  if (!/^[0-9a-fA-F.:[\]]+$/.test(value)) return null;
  return value.toLowerCase();
}
