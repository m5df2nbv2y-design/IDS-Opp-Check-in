import { beforeEach, afterEach, expect, it } from "vitest";
import { Webhook } from "svix";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { resetDatabase } from "./fixtures";
import { POST } from "@/app/api/webhooks/resend/route";
const secret = `whsec_${Buffer.from("synthetic-test-signing-secret-123456").toString("base64")}`;
const originalSecret = env.resendWebhookSecret;
beforeEach(async () => { await resetDatabase(); Object.defineProperty(env, "resendWebhookSecret", { value: secret, configurable: true }); });
afterEach(() => { Object.defineProperty(env, "resendWebhookSecret", { value: originalSecret, configurable: true }); });
function request(type: string, valid = true, date = new Date()) {
  const body = JSON.stringify({ type, created_at: date.toISOString(), data: { email_id: "provider-id" } });
  const signature = new Webhook(secret).sign("event-id", date, body);
  return new Request("https://checkin.test/api/webhooks/resend", { method: "POST", body, headers: {
    "svix-id": "event-id", "svix-timestamp": String(Math.floor(date.getTime() / 1000)), "svix-signature": valid ? signature : "v1,invalid",
  } });
}
it("rejects forged and expired signatures before touching the ledger", async () => {
  expect((await POST(request("email.delivered", false))).status).toBe(400);
  expect((await POST(request("email.delivered", true, new Date(Date.now() - 600_000)))).status).toBe(400);
});
it("records verified delivery idempotently without clearing a later bounce", async () => {
  const row = await prisma.emailMessage.create({ data: { provider: "resend", providerMessageId: "provider-id", kind: "TEST", toEmail: "test@example.invalid", toName: "Test", subject: "test", html: "", text: "", status: "SENT" } });
  expect((await POST(request("email.delivered"))).status).toBe(204);
  expect((await POST(request("email.bounced"))).status).toBe(204);
  expect((await POST(request("email.delivered"))).status).toBe(204);
  const result = await prisma.emailMessage.findUniqueOrThrow({ where: { id: row.id } });
  expect(result.deliveredAt).not.toBeNull(); expect(result.status).toBe("BOUNCED");
});
it("asks for a retry if delivery arrives before the send receipt", async () => {
  expect((await POST(request("email.delivered"))).status).toBe(503);
});
