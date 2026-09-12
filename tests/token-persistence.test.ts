import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { completeCheckIn, resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { resetDatabase } from "./fixtures";

/**
 * Where the bearer token is allowed to exist.
 *
 * The check-in token is a bearer credential: anyone holding it can read a
 * customer's opportunities and answer as them. `CheckInRecipient` therefore
 * stores only a SHA-256 hash — but hashing there buys nothing if the raw token
 * is sitting in plaintext in another table, which is exactly the defect this
 * file exists to prevent regressing.
 *
 * The invariant: for a REAL email provider the raw token must not be persisted
 * in ANY column of ANY table. The simulated provider is the single, explicit
 * exception — the demo outbox renders a working link, and nothing it holds ever
 * left the machine.
 *
 * The scan is driven off information_schema rather than a hand-written list of
 * columns, so a new table or column is covered the day it is added.
 */

/**
 * The schema the tests actually run in.
 *
 * The driver adapter schema-qualifies its queries rather than setting a
 * search_path, so `current_schema()` reports "public" while the tables live in
 * the per-run schema. The scan has to be told explicitly, or it silently finds
 * nothing and the whole file passes for the wrong reason.
 */
const SCHEMA = new URL(process.env.DATABASE_URL!).searchParams.get("schema") ?? "public";

/** Every text-bearing column in the application schema, from the database itself. */
async function textColumns(): Promise<{ table: string; column: string }[]> {
  const rows = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = $1
       AND data_type IN ('text', 'character varying', 'character')
       AND table_name <> '_prisma_migrations'
     ORDER BY table_name, column_name`,
    SCHEMA,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

/** Every place a raw token is stored, as "Table.column" strings. */
async function findToken(token: string): Promise<string[]> {
  const columns = await textColumns();
  // A scan that inspects nothing would "pass" every assertion below.
  expect(columns.length, "the column scan found no columns to search").toBeGreaterThan(20);

  const hits: string[] = [];
  for (const { table, column } of columns) {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n FROM "${SCHEMA}"."${table}" WHERE "${column}" LIKE $1`,
      `%${token}%`,
    );
    if (Number(rows[0].n) > 0) hits.push(`${table}.${column}`);
  }
  return hits;
}

/**
 * Launches a real campaign through a FRESH module graph.
 *
 * getEmailService() caches its provider in a module-level singleton, so a test
 * that stubs EMAIL_PROVIDER must re-import the workflow or it keeps sending
 * through the provider the first import happened to build.
 */
async function launchCampaignFreshly() {
  vi.resetModules();
  const draftService = await import("@/server/services/campaign-draft-service");
  const db = await import("@/lib/db");

  const draft = await draftService.getOrCreateDraft("test");
  const opportunities = await db.prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED" },
    take: 2,
    select: { id: true },
  });
  await draftService.setSelection({
    campaignId: draft.id,
    opportunityIds: opportunities.map((o) => o.id),
    selected: true,
  });
  await draftService.sendDraft(draft.id, "test");
  return draft.id;
}

describe("the bearer token is never persisted by a real provider", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("stores no raw token in ANY column when the provider is real", async () => {
    // Resend, with the network stubbed: a real (non-simulated) provider, so
    // nothing it persists may carry the bearer token.
    const sent: string[] = [];
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key_for_persistence_check");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body).html);
        return new Response(JSON.stringify({ id: "stub" }), { status: 200 });
      }),
    );

    const campaignId = await launchCampaignFreshly();

    // The token the recipient actually received, taken from the outbound body.
    const tokens = sent
      .map((html) => html.match(/\/checkin\/([A-Za-z0-9_-]{20,})/)?.[1])
      .filter((t): t is string => Boolean(t));

    expect(tokens.length, "the provider must actually have been given a link").toBeGreaterThan(0);

    for (const token of tokens) {
      const hits = await findToken(token);
      expect(
        hits,
        `raw bearer token found persisted in: ${hits.join(", ")}`,
      ).toEqual([]);
    }

    // And the audit row still exists — we lose the token, not the record.
    const rows = await prisma.emailMessage.findMany({ where: { campaignId } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.provider).toBe("resend");
  });

  it("still delivers a WORKING link to the recipient", async () => {
    const sent: string[] = [];
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key_for_persistence_check");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body).html);
        return new Response(JSON.stringify({ id: "stub" }), { status: 200 });
      }),
    );

    await launchCampaignFreshly();

    const token = sent
      .map((html) => html.match(/\/checkin\/([A-Za-z0-9_-]{20,})/)?.[1])
      .find(Boolean)!;

    // Losing the stored copy must not cost the recipient anything.
    const resolved = await resolveCheckInToken(token);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    for (const item of resolved.session.items) {
      const saved = await saveResponse({ token, itemId: item.id, stage: "NEGOTIATION" });
      expect(saved.ok).toBe(true);
    }
    const completed = await completeCheckIn(token);
    expect(completed.ok).toBe(true);
  });

  it("keeps the demo outbox working for the SIMULATED provider only", async () => {
    // The mock provider is the one explicit exception: the demo outbox renders
    // a working button, and nothing it holds ever left the machine.
    const campaignId = await launchCampaignFreshly();

    const rows = await prisma.emailMessage.findMany({ where: { campaignId } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.provider).toBe("mock");

    const withLink = rows.filter((row) => row.linkUrl?.includes("/checkin/"));
    expect(withLink.length, "the demo outbox needs an openable link").toBeGreaterThan(0);

    const token = withLink[0].linkUrl!.split("/checkin/")[1];
    const resolved = await resolveCheckInToken(token);
    expect(resolved.ok).toBe(true);
  });

  it("redacts the token from the rendered bodies, not just the link", async () => {
    // The link appears in html and text as well. Redacting only linkUrl would
    // leave two working copies behind — which is what the original defect was.
    const sent: string[] = [];
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key_for_persistence_check");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        sent.push(JSON.parse(init.body).html);
        return new Response(JSON.stringify({ id: "stub" }), { status: 200 });
      }),
    );

    const campaignId = await launchCampaignFreshly();
    const rows = await prisma.emailMessage.findMany({ where: { campaignId } });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The audit record survives; only the credential is gone.
      expect(row.html).toContain("/checkin/[redacted]");
      expect(row.text).toContain("/checkin/[redacted]");
      expect(row.linkUrl).toContain("/checkin/[redacted]");
      expect(row.subject.length).toBeGreaterThan(0);
      expect(row.toEmail.length).toBeGreaterThan(0);
    }

    // What actually went OUT still carried a live token.
    expect(sent.some((html) => /\/checkin\/[A-Za-z0-9_-]{20,}/.test(html))).toBe(true);
  });

  it("refuses the demo test email rather than sending a dead link", async () => {
    // Once invitations go through a real provider there is no live link to
    // reuse. Sending anyway would look successful and deliver a broken button.
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key_for_persistence_check");
    vi.stubEnv("DEMO_TEST_EMAIL", "demo.person@example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "stub" }), { status: 200 })),
    );

    const campaignId = await launchCampaignFreshly();
    const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });

    const { sendDemoTestEmail } = await import("@/server/services/test-email-service");
    const result = await sendDemoTestEmail(recipient.id, "admin@ids.invalid");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("NO_CHECKIN_LINK");
    expect(result.message).toContain("real email provider");
  });

  it("never stores the raw token on the recipient row, under any provider", async () => {
    const campaignId = await launchCampaignFreshly();
    const rows = await prisma.emailMessage.findMany({ where: { campaignId } });
    const token = rows.find((r) => r.linkUrl?.includes("/checkin/"))!.linkUrl!.split("/checkin/")[1];

    const recipients = await prisma.checkInRecipient.findMany();
    for (const recipient of recipients) {
      expect(recipient.tokenHash).not.toBe(token);
      expect(recipient.tokenHash).not.toContain(token);
      expect(recipient.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    }

    // Under the simulated provider the token may appear ONLY in the outbox
    // copy of the message — the link and the two rendered bodies that contain
    // it. Anywhere else is a leak, even in the demo.
    const hits = await findToken(token);
    expect(hits.sort()).toEqual([
      "EmailMessage.html",
      "EmailMessage.linkUrl",
      "EmailMessage.text",
    ]);
  });
});
