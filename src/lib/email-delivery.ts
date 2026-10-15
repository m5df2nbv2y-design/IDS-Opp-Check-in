export type DeliveryRecord = { provider: string; status: string; deliveredAt: Date | null };

/** SENT means provider acceptance, not inbox delivery. Mock never delivers. */
export function emailDeliveryLabel(email: DeliveryRecord | null): string {
  if (!email) return "No email record";
  if (email.status === "FAILED") return "Failed";
  if (email.provider === "mock") return "Captured in Outbox — not delivered";
  if (email.deliveredAt) return "Delivered";
  if (email.status === "SENT") return "Accepted by email provider";
  return "Delivery not confirmed";
}
