import { prisma } from "@/lib/db";
import type { EmailProviderInfo, OutboundEmail } from "./types";

/**
 * The one place an outbound message becomes an outbox row.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The check-in token is a bearer credential: whoever holds it can read a
 * customer's opportunities and answer as them. `CheckInRecipient` therefore
 * stores only a SHA-256 hash — but that buys nothing if the raw token is
 * sitting in plaintext elsewhere, and it was: the token appears in the link,
 * and the link appears in the rendered `html` and `text` bodies too.
 *
 * So redaction happens HERE, for every provider, rather than in each provider
 * where a new one could forget. The rule is a property of the provider, not of
 * the caller:
 *
 *   simulated provider → the full link is kept. The demo outbox renders a
 *                        working button, and nothing it holds ever left the
 *                        machine.
 *   real provider      → every copy of the token is redacted before the row is
 *                        written. The message still exists for audit — who was
 *                        emailed, when, with what subject and copy — it simply
 *                        cannot be replayed.
 *
 * The token lives in memory only long enough for the provider to hand it to the
 * delivery API. It is never written to disk for a real send.
 */

/** Stand-in written where a bearer token was, so the URL shape survives. */
export const REDACTED_TOKEN = "[redacted]";

/**
 * Replaces every check-in token in a string with a placeholder.
 *
 * Matches the token by its position in the path rather than by its value, so it
 * works on the URL, on an HTML body containing it several times, and on the
 * plaintext alternative — without needing to be told what the token was.
 */
export function redactCheckInTokens(value: string): string;
export function redactCheckInTokens(value: null | undefined): null;
export function redactCheckInTokens(value: string | null | undefined): string | null;
export function redactCheckInTokens(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(/\/checkin\/[A-Za-z0-9_-]+/g, `/checkin/${REDACTED_TOKEN}`);
}

type RecordInput = {
  message: OutboundEmail;
  info: EmailProviderInfo;
  status: "SENT" | "FAILED";
  error?: string | null;
};

/**
 * Writes the outbox row, redacting the bearer token unless the provider is
 * simulated. Every provider must go through this — it is the only writer of
 * EmailMessage.
 */
export async function recordOutboundEmail({ message, info, status, error }: RecordInput) {
  // A simulated provider delivered nothing anywhere, so its outbox is allowed
  // to hold a working link — that is what makes the local demo demonstrable.
  const keep = info.simulated;
  const clean = (value: string | null | undefined) =>
    keep ? (value ?? null) : redactCheckInTokens(value);

  return prisma.emailMessage.create({
    data: {
      provider: info.id,
      kind: message.kind,
      toEmail: message.to.email,
      toName: message.to.name,
      subject: message.subject,
      html: clean(message.html) ?? "",
      text: clean(message.text) ?? "",
      linkUrl: clean(message.linkUrl),
      campaignId: message.campaignId ?? null,
      contactId: message.contactId ?? null,
      status,
      error: error ?? null,
    },
  });
}
