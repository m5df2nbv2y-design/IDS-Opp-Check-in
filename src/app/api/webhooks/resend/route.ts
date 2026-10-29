import { Webhook } from "svix";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

/** Verify the original bytes before parsing or using any delivery event. */
export async function POST(request: Request) {
  if (!env.resendWebhookSecret) return new Response("Webhook not configured", { status: 503 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 256_000) return new Response("Payload too large", { status: 413 });
  let event: { type?: string; created_at?: string; data?: { email_id?: string } };
  try {
    new Webhook(env.resendWebhookSecret).verify(raw, {
      "svix-id": request.headers.get("svix-id") ?? "",
      "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
      "svix-signature": request.headers.get("svix-signature") ?? "",
    });
    event = JSON.parse(raw);
  } catch { return new Response("Invalid signature", { status: 400 }); }
  if (!event || typeof event.data?.email_id !== "string" || typeof event.created_at !== "string") return new Response("Invalid event", { status: 400 });
  const at = new Date(event.created_at);
  if (!Number.isFinite(at.getTime())) return new Response("Invalid event date", { status: 400 });
  const row = await prisma.emailMessage.findUnique({ where: { providerMessageId: event.data.email_id } });
  // Provider callbacks may beat the send receipt commit. Ask Resend to retry.
  if (!row || row.provider !== "resend") return new Response("Receipt not available", { status: 503 });
  if (event.type === "email.delivered") {
    await prisma.emailMessage.updateMany({ where: { id: row.id, deliveredAt: null }, data: { deliveredAt: at } });
  } else if (event.type === "email.bounced" || event.type === "email.complained") {
    await prisma.emailMessage.updateMany({
      where: { id: row.id, ...(event.type === "email.bounced" ? { status: { not: "COMPLAINED" } } : {}) },
      data: { status: event.type === "email.bounced" ? "BOUNCED" : "COMPLAINED" },
    });
  }
  return new Response(null, { status: 204 });
}
