import { createHash, randomBytes } from "node:crypto";

/**
 * Check-in links carry a random, opaque token and nothing else:
 *   /checkin/<token>
 *
 * No Salesforce ids, customer names, opportunity data, or email addresses ever
 * appear in the URL. Only the SHA-256 hash of the token is persisted, so a
 * database leak does not hand out working links.
 */

export type IssuedToken = {
  /** Raw token — only ever placed in the emailed URL, never stored. */
  token: string;
  hash: string;
  /** Last 6 chars, safe to show in admin UI for support lookups. */
  hint: string;
};

export function issueToken(): IssuedToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), hint: token.slice(-6) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function checkInUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/checkin/${token}`;
}
