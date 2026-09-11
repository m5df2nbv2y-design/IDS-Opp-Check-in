import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import {
  getOrCreateDraft,
  sendDraft,
  setSelection,
} from "@/server/services/campaign-draft-service";
import { resetDatabase } from "./fixtures";

/**
 * The demo test-email path is the only code in this application that sends real
 * mail. What matters is not that it works, but that it cannot be aimed
 * anywhere except the address configured on the server.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(`${root}${relative}`, "utf8");

const DEMO_ADDRESS = "demo.person@example.com";

/** Captures what would have gone to Resend, without any network call. */
function stubResend() {
  const calls: { to: string[]; subject: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body);
      calls.push({ to: payload.to, subject: payload.subject, body: payload.html });
      return new Response(JSON.stringify({ id: "resend-test-id" }), { status: 200 });
    }),
  );
  return calls;
}

async function launchCampaign() {
  const draft = await getOrCreateDraft("test");
  const opportunity = await prisma.opportunity.findFirstOrThrow({
    where: { isOpen: true, resolutionStatus: "RESOLVED" },
    orderBy: { amount: "desc" },
  });
  await setSelection({ campaignId: draft.id, opportunityIds: [opportunity.id], selected: true });
  await sendDraft(draft.id, "test");
  const recipient = await prisma.checkInRecipient.findFirstOrThrow({
    where: { campaignId: draft.id },
    include: { contact: true },
  });
  return { recipient, opportunity };
}

/** Imported fresh each time so the env stubs are read at module load. */
async function loadService() {
  vi.resetModules();
  return import("@/server/services/test-email-service");
}

describe("the demo test email", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends ONLY to the server-configured address, never the contact's own", async () => {
    vi.stubEnv("DEMO_TEST_EMAIL", DEMO_ADDRESS);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const calls = stubResend();
    const { recipient } = await launchCampaign();

    const { sendDemoTestEmail } = await loadService();
    const result = await sendDemoTestEmail(recipient.id, "admin@ids.invalid");

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual([DEMO_ADDRESS]);
    // The real contact has an address, and it must not have been used.
    expect(recipient.contact.email).toBeTruthy();
    expect(recipient.contact.email).not.toBe(DEMO_ADDRESS);
    expect(calls[0].to).not.toContain(recipient.contact.email);
  });

  it("fails closed when no demo address is configured", async () => {
    vi.stubEnv("DEMO_TEST_EMAIL", "");
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const calls = stubResend();
    const { recipient } = await launchCampaign();

    const { sendDemoTestEmail } = await loadService();
    const result = await sendDemoTestEmail(recipient.id, "admin@ids.invalid");

    expect(result).toMatchObject({ ok: false, reason: "NOT_CONFIGURED" });
    // Nothing reached the provider.
    expect(calls).toHaveLength(0);
  });

  it("reuses the existing check-in link rather than minting a new token", async () => {
    vi.stubEnv("DEMO_TEST_EMAIL", DEMO_ADDRESS);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const calls = stubResend();
    const { recipient } = await launchCampaign();

    const invite = await prisma.emailMessage.findFirstOrThrow({
      where: { campaignId: recipient.campaignId, kind: "INVITE" },
    });
    const tokenHashBefore = recipient.tokenHash;

    const { sendDemoTestEmail } = await loadService();
    await sendDemoTestEmail(recipient.id, "admin@ids.invalid");

    expect(calls[0].body).toContain(invite.linkUrl!);

    // The real recipient's link must still work — re-minting would break it.
    const after = await prisma.checkInRecipient.findUniqueOrThrow({ where: { id: recipient.id } });
    expect(after.tokenHash).toBe(tokenHashBefore);
  });

  it("does not add a recipient, campaign, or invite that would skew engagement", async () => {
    vi.stubEnv("DEMO_TEST_EMAIL", DEMO_ADDRESS);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    stubResend();
    const { recipient } = await launchCampaign();

    const before = {
      recipients: await prisma.checkInRecipient.count(),
      campaigns: await prisma.campaign.count(),
      invites: await prisma.emailMessage.count({ where: { kind: { in: ["INVITE", "REMINDER"] } } }),
    };

    const { sendDemoTestEmail } = await loadService();
    await sendDemoTestEmail(recipient.id, "admin@ids.invalid");

    expect(await prisma.checkInRecipient.count()).toBe(before.recipients);
    expect(await prisma.campaign.count()).toBe(before.campaigns);
    expect(
      await prisma.emailMessage.count({ where: { kind: { in: ["INVITE", "REMINDER"] } } }),
    ).toBe(before.invites);
    // It is recorded, as its own kind.
    expect(await prisma.emailMessage.count({ where: { kind: "TEST" } })).toBe(1);
  });

  it("treats a rapid second click as the same send", async () => {
    vi.stubEnv("DEMO_TEST_EMAIL", DEMO_ADDRESS);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const calls = stubResend();
    const { recipient } = await launchCampaign();

    const { sendDemoTestEmail } = await loadService();
    await sendDemoTestEmail(recipient.id, "admin@ids.invalid");
    const second = await sendDemoTestEmail(recipient.id, "admin@ids.invalid");

    expect(second).toMatchObject({ ok: true, alreadySent: true });
    expect(calls).toHaveLength(1);
  });

  it("records the send in the audit trail", async () => {
    vi.stubEnv("DEMO_TEST_EMAIL", DEMO_ADDRESS);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    stubResend();
    const { recipient } = await launchCampaign();

    const { sendDemoTestEmail } = await loadService();
    await sendDemoTestEmail(recipient.id, "josh@ids.invalid");

    const event = await prisma.auditEvent.findFirstOrThrow({ where: { type: "TEST_EMAIL_SENT" } });
    expect(event.actor).toBe("josh@ids.invalid");
    expect(event.summary).toContain(DEMO_ADDRESS);
  });

  it("writes nothing to Salesforce", async () => {
    vi.stubEnv("DEMO_TEST_EMAIL", DEMO_ADDRESS);
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const calls = stubResend();
    const { recipient, opportunity } = await launchCampaign();

    const { sendDemoTestEmail } = await loadService();
    await sendDemoTestEmail(recipient.id, "admin@ids.invalid");

    // The only outbound request was to the email provider.
    expect(calls).toHaveLength(1);
    const after = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(after.currentStage).toBe(opportunity.currentStage);
    expect(after.amount).toBe(opportunity.amount);
  });
});

describe("the test-email path cannot be aimed by the browser", () => {
  it("takes a recipient id, never an address", () => {
    const service = read("src/server/services/test-email-service.ts");
    const action = read("src/app/admin/actions.ts");

    // The signature accepts an id; an email parameter would be the hole.
    expect(service).toMatch(/sendDemoTestEmail\(\s*recipientId: string,\s*actor: string,?\s*\)/);
    expect(action).toMatch(/sendTestEmailAction\(recipientId: string\)/);
    // The destination comes from the server environment and is re-applied
    // immediately before the send.
    expect(service).toContain("env.demoTestEmail");
    expect(service).toContain("message.to = { name: message.to.name, email: deliverTo }");
  });

  it("is guarded like every other admin action", () => {
    const action = read("src/app/admin/actions.ts");
    const body = action.slice(action.indexOf("export async function sendTestEmailAction"));
    const firstStatement = body
      .slice(body.indexOf("{") + 1)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("//"));

    expect(firstStatement).toContain("requireAdminActor()");
  });

  it("leaves the configured email provider alone", () => {
    // The factory must still choose mock; the demo path calls Resend directly.
    const factory = read("src/server/integrations/email/index.ts");
    expect(factory).not.toContain("demoTestEmail");
    expect(read("src/server/services/test-email-service.ts")).toContain("new ResendEmailService()");
  });

  it("offers no free-text recipient field in the UI", () => {
    const panel = read("src/components/admin/test-email-panel.tsx");
    expect(panel).not.toContain("<input");
    expect(panel).not.toContain("type=\"email\"");
    // The address shown is display-only, passed down from the server.
    expect(panel).toContain("demoAddress");
  });
});
