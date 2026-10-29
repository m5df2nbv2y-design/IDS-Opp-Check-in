export type DeliveryRecord = { provider: string; status: string; deliveredAt: Date | null };

/** SENT means provider acceptance, not inbox delivery. Mock never delivers. */
export function emailDeliveryLabel(email: DeliveryRecord | null): string {
  if (!email) return "No email record";
  if (email.status === "UNCERTAIN" || email.status === "PENDING") return "Acceptance unconfirmed — check Resend";
  if (email.status === "BOUNCED") return "Bounced";
  if (email.status === "COMPLAINED") return "Spam complaint";
  if (email.status === "FAILED") return "Failed";
  if (email.provider === "mock") return "Captured in Outbox — not delivered";
  if (email.deliveredAt) return "Delivered";
  if (email.status === "SENT") return "Accepted by email provider";
  return "Delivery not confirmed";
}
