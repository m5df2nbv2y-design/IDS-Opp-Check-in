import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "./fixtures";
import { env } from "@/lib/env";
import { ResendEmailService } from "@/server/integrations/email/resend-email-service";
import type { OutboundEmail } from "@/lib/email-message";
const message: OutboundEmail = { to: { name: "Test", email: "test@example.invalid" }, subject: "Check-in", html: "https://checkin.test/checkin/synthetic-token-123456789", text: "Test", kind: "TEST" };
const originalKey = env.resendApiKey;
beforeEach(async () => { await resetDatabase(); Object.defineProperty(env, "resendApiKey", { value: "re_test", configurable: true }); });
afterEach(() => { Object.defineProperty(env, "resendApiKey", { value: originalKey, configurable: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("persists before sending and suppresses identical concurrent requests", async () => {
  const fetcher = vi.fn(async () => {
    const rows = await prisma.emailMessage.findMany();
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe("PENDING");
    expect(rows[0].html).not.toContain("synthetic-token");
    return Response.json({ id: "provider-one" });
  });
  vi.stubGlobal("fetch", fetcher);
  const service = new ResendEmailService();
  await Promise.all([service.send(message), service.send(message)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect((await service.send(message)).status).toBe("SENT");
  expect(fetcher).toHaveBeenCalledTimes(1);
  const row = await prisma.emailMessage.findFirstOrThrow();
  expect(row.providerMessageId).toBe("provider-one");
});
it("keeps an uncertain receipt without leaking error text or automatically replaying", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("Bearer re_test /checkin/secret-token")); vi.stubGlobal("fetch", fetcher);
  const service = new ResendEmailService();
  await service.send(message); await service.send(message);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const row = await prisma.emailMessage.findFirstOrThrow();
  expect(row.status).toBe("UNCERTAIN"); expect(row.error).not.toContain("re_test"); expect(row.error).not.toContain("secret-token");
});

it("refuses direct Resend sends from Preview even when the configured provider is mock", async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  await expect(new ResendEmailService().send(message)).rejects.toThrow("Refusing");
  expect(fetcher).not.toHaveBeenCalled();
  expect(await prisma.emailMessage.count()).toBe(0);
});
