export type DeliveryRecord = { provider: string; status: string; deliveredAt: Date | null };

/** SENT means provider acceptance, not inbox delivery. Mock never delivers. */
export function emailDeliveryLabel(email: DeliveryRecord | null): string {
  if (!email) return "No email record";
  if (email.status === "UNCERTAIN" || email.status === "PENDING") {
    const where = email.provider === "graph" ? "the sent mailbox" : email.provider === "resend" ? "Resend" : "the email provider";
    return `Acceptance unconfirmed — check ${where}`;
  }
  if (email.status === "BOUNCED") return "Bounced";
  if (email.status === "COMPLAINED") return "Spam complaint";
  if (email.status === "FAILED") return "Failed";
  if (email.provider === "mock") return "Captured in Outbox — not delivered";
  if (email.deliveredAt) return "Delivered";
  if (email.status === "SENT") return "Accepted by email provider";
  return "Delivery not confirmed";
}

const UNCONFIRMED_SEND_STATUSES = ["UNCERTAIN", "PENDING", "REMINDER_PENDING", "REMINDER_UNCERTAIN"];

/**
 * Whether acceptance is unconfirmed, so the sending results show a warning rather
 * than a failure or a success. This is a TONE rule only. It is wider than the
 * unknown-invitation count (`isUnknownInvitation`), which is what the totals use:
 * an interrupted send or an unresolved reminder is shown as a warning but is not
 * counted as an unknown invitation. Never true once a definite failure is recorded.
 */
export function isUnconfirmedDelivery(recipient: { sendStatus: string }, email: { status: string } | null): boolean {
  if (recipient.sendStatus === "FAILED" || email?.status === "FAILED") return false;
  return UNCONFIRMED_SEND_STATUSES.includes(recipient.sendStatus) || email?.status === "UNCERTAIN" || email?.status === "PENDING";
}
