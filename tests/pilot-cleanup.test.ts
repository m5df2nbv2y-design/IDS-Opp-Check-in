import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  clearPilotData,
  hostLabel,
  inventoryPilotData,
  parseCleanupArgs,
  PilotCleanupRefused,
} from "@/server/ops/pilot-cleanup";
import { getOrCreateDraft, setSelection } from "@/server/services/campaign-draft-service";
import { completeCheckIn, resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

const DB_URL = "postgresql://ids:secret@db.prod.example:5432/ids?schema=public";

const ZERO_COUNTS = {
  campaigns: 0,
  recipients: 0,
  checkInItems: 0,
  submittedAnswers: 0,
  selections: 0,
  pilotEmails: 0,
  campaignAuditEvents: 0,
  launchSnapshots: 0,
};

/** Everything the cleanup must leave exactly as it was. */
async function keptRows() {
  const byId = { orderBy: { id: "asc" as const } };
  return {
    accounts: await prisma.account.findMany(byId),
    contacts: await prisma.externalContact.findMany(byId),
    reps: await prisma.salesRep.findMany(byId),
    opportunities: await prisma.opportunity.findMany(byId),
    snapshots: await prisma.opportunitySnapshot.findMany({ ...byId, where: { source: { not: "CAMPAIGN_LAUNCH" } } }),
    signals: await prisma.opportunitySignal.findMany(byId),
    realEmails: await prisma.emailMessage.findMany({ ...byId, where: { provider: { not: "mock" }, kind: { not: "TEST" } } }),
    audit: await prisma.auditEvent.findMany({ ...byId, where: { campaignId: null } }),
    rateLimits: await prisma.rateLimitCounter.findMany({ orderBy: { key: "asc" } }),
    mockOpportunities: await prisma.mockSalesforceOpportunity.findMany({ orderBy: { externalId: "asc" } }),
    mockContacts: await prisma.mockSalesforceContact.findMany({ orderBy: { externalId: "asc" } }),
  };
}

/** A launched campaign, a draft with a selection, plus history that must survive. */
async function seedPilot() {
  const launched = await launchCampaignAndCollectTokens("Pilot");
  const draft = await getOrCreateDraft("test");
  const opportunity = await prisma.opportunity.findFirstOrThrow({ where: { isOpen: true } });
  await setSelection({ campaignId: draft.id, opportunityIds: [opportunity.id], selected: true });

  await prisma.opportunitySnapshot.create({
    data: {
      opportunityId: opportunity.id,
      externalId: opportunity.externalId,
      source: "OUTCOME_OBSERVED",
      amount: 1,
      stage: "Closed Won",
      isOpen: false,
      isWon: true,
      accountName: "Kept",
      internalRepName: "Kept",
    },
  });
  await prisma.opportunitySignal.create({
    data: { externalId: "sig-1", sheetName: "S", signalType: "COMMENT", title: "t", message: "m", occurredAt: new Date() },
  });
  // A real send outside any campaign: kept.
  await prisma.emailMessage.create({
    data: { provider: "graph", kind: "INVITE", toEmail: "x@example.com", toName: "X", subject: "s", html: "h", text: "t" },
  });
  await prisma.rateLimitCounter.create({ data: { key: "k", count: 3, expiresAt: new Date(Date.now() + 60_000) } });
  return { launched, draft };
}

/** The same rows a demo test email leaves, sent through the real path with Resend stubbed. */
async function sendDemoTestEmailFor(campaignId: string) {
  vi.stubEnv("DEMO_TEST_EMAIL", "demo.person@example.com");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "resend-test-id" }), { status: 200 })));
  vi.resetModules();
  const { sendDemoTestEmail } = await import("@/server/services/test-email-service");
  const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });
  const result = await sendDemoTestEmail(recipient.id, "admin@ids.invalid");
  expect(result.ok).toBe(true);
}

const BLOCKER_PHRASES = {
  itemsWithSalesforceWrites: "1 pilot check-in item(s) had a real Salesforce write attempt",
  realSendsInPilot: "1 real-provider invitation/reminder email(s) not marked FAILED are tied to a pilot campaign",
} as const;

async function expectRefused(field: keyof typeof BLOCKER_PHRASES) {
  const campaigns = await prisma.campaign.count();
  const emails = await prisma.emailMessage.count();
  const audit = await prisma.auditEvent.count();

  const error = await clearPilotData({ actor: "Josh" }).catch((caught) => caught);

  expect(error).toBeInstanceOf(PilotCleanupRefused);
  expect(error.blockers).toEqual({ itemsWithSalesforceWrites: 0, realSendsInPilot: 0, [field]: 1 });
  expect(error.message).toBe(`${BLOCKER_PHRASES[field]}. Nothing was removed.`);
  expect(await prisma.campaign.count()).toBe(campaigns);
  expect(await prisma.emailMessage.count()).toBe(emails);
  expect(await prisma.auditEvent.count()).toBe(audit);
}

describe("pilot data cleanup", () => {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dry run counts pilot data and changes nothing", async () => {
    await seedPilot();
    const before = await keptRows();
    const auditBefore = await prisma.auditEvent.count();

    const { counts, blockers } = await inventoryPilotData();

    expect(counts.campaigns).toBe(2);
    expect(counts.recipients).toBeGreaterThan(0);
    expect(counts.checkInItems).toBeGreaterThan(0);
    expect(counts.submittedAnswers).toBe(0);
    expect(counts.selections).toBeGreaterThan(0);
    expect(counts.pilotEmails).toBeGreaterThan(0);
    expect(counts.campaignAuditEvents).toBeGreaterThan(0);
    expect(counts.launchSnapshots).toBeGreaterThan(0);
    expect(blockers).toEqual({ itemsWithSalesforceWrites: 0, realSendsInPilot: 0 });
    expect(await keptRows()).toEqual(before);
    expect(await prisma.auditEvent.count()).toBe(auditBefore);
    expect(await prisma.campaign.count()).toBe(2);
  });

  it("apply removes every pilot record, keeps the rest, and records one summary", async () => {
    const { launched } = await seedPilot();
    const before = await keptRows();
    const { counts } = await inventoryPilotData();
    const token = [...launched.tokens.values()][0];
    expect((await resolveCheckInToken(token)).ok).toBe(true);

    const removed = await clearPilotData({ actor: "Josh" });

    expect(removed).toEqual(counts);
    expect((await inventoryPilotData()).counts).toEqual(ZERO_COUNTS);
    // Nothing pilot is left orphaned by the SetNull relation either.
    expect(await prisma.auditEvent.count({ where: { type: { in: ["INVITE_SENT", "CAMPAIGN_CREATED"] } } })).toBe(0);
    expect(await prisma.emailMessage.count({ where: { provider: "mock" } })).toBe(0);

    const summaries = await prisma.auditEvent.findMany({ where: { type: "PILOT_DATA_CLEARED" } });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ actor: "Josh", actorKind: "ADMIN", campaignId: null });
    expect(JSON.parse(summaries[0].detail!)).toEqual({ version: 1, ...counts });

    const after = await keptRows();
    expect({ ...after, audit: after.audit.filter((event) => event.type !== "PILOT_DATA_CLEARED") }).toEqual(before);

    // The pilot contact's check-in link no longer resolves.
    expect(await resolveCheckInToken(token)).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("apply on a clean database writes only the summary event", async () => {
    const auditBefore = await prisma.auditEvent.count();
    const { counts, blockers } = await inventoryPilotData();
    expect(counts).toEqual(ZERO_COUNTS);
    expect(blockers).toEqual({ itemsWithSalesforceWrites: 0, realSendsInPilot: 0 });

    await clearPilotData({ actor: "Josh" });

    expect(await prisma.auditEvent.count()).toBe(auditBefore + 1);
    expect(await prisma.auditEvent.count({ where: { type: "PILOT_DATA_CLEARED" } })).toBe(1);
  });

  it.each(["SYNCED", "SYNCING", "UNCERTAIN", "FAILED"])("refuses when a pilot item is %s", async (syncStatus) => {
    await seedPilot();
    const item = await prisma.checkInOpportunity.findFirstOrThrow();
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { syncStatus } });

    await expectRefused("itemsWithSalesforceWrites");
  });

  it("removes 'no change' answers submitted through the real path (SKIPPED with syncedAt)", async () => {
    const { launched } = await seedPilot();
    const token = [...launched.tokens.values()][0];
    const resolved = await resolveCheckInToken(token);
    if (!resolved.ok) throw new Error("token did not resolve");
    for (const item of resolved.session.items) {
      expect(await saveResponse({ token, itemId: item.id, stage: item.currentStage })).toMatchObject({ ok: true });
    }
    expect(await completeCheckIn(token)).toMatchObject({ ok: true });

    const skipped = await prisma.checkInOpportunity.findMany({ where: { recipientId: resolved.session.recipientId } });
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((item) => item.syncStatus === "SKIPPED" && item.syncedAt !== null)).toBe(true);

    const { counts, blockers } = await inventoryPilotData();
    expect(counts.submittedAnswers).toBe(skipped.length);
    expect(blockers.itemsWithSalesforceWrites).toBe(0);

    await clearPilotData({ actor: "Josh" });
    expect((await inventoryPilotData()).counts).toEqual(ZERO_COUNTS);
  });

  it("removes WITHHELD answers", async () => {
    await seedPilot();
    await prisma.checkInOpportunity.updateMany({ data: { syncStatus: "WITHHELD", submittedAt: new Date() } });

    await clearPilotData({ actor: "Josh" });
    expect((await inventoryPilotData()).counts).toEqual(ZERO_COUNTS);
  });

  it("removes a demo test email sent through Resend on a pilot campaign", async () => {
    const { launched } = await seedPilot();
    await sendDemoTestEmailFor(launched.campaignId);
    expect(await prisma.emailMessage.count({ where: { provider: "resend", kind: "TEST" } })).toBe(1);

    await clearPilotData({ actor: "Josh" });

    expect(await prisma.emailMessage.count({ where: { kind: "TEST" } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { type: "TEST_EMAIL_SENT" } })).toBe(0);
  });

  it.each(["INVITE", "REMINDER"])("refuses when a real-provider %s is tied to a pilot campaign", async (kind) => {
    const { draft } = await seedPilot();
    await prisma.emailMessage.create({
      data: { provider: "resend", kind, toEmail: "x@example.com", toName: "X", subject: "s", html: "h", text: "t", campaignId: draft.id },
    });

    await expectRefused("realSendsInPilot");
  });

  it("removes a FAILED real-provider invitation on a pilot campaign without blocking", async () => {
    const { draft } = await seedPilot();
    await prisma.emailMessage.create({
      data: { provider: "resend", kind: "INVITE", status: "FAILED", toEmail: "x@example.com", toName: "X", subject: "s", html: "h", text: "t", campaignId: draft.id },
    });
    expect((await inventoryPilotData()).blockers.realSendsInPilot).toBe(0);

    await clearPilotData({ actor: "Josh" });

    expect(await prisma.emailMessage.count({ where: { provider: "resend" } })).toBe(0);
    expect((await inventoryPilotData()).counts).toEqual(ZERO_COUNTS);
  });

  it("a concurrent write on a second connection aborts the Serializable apply, which removes nothing", async () => {
    const { draft } = await seedPilot();
    const auditBefore = await prisma.auditEvent.count();
    const emailsBefore = await prisma.emailMessage.count();
    const original = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
      original(async (tx) => {
        // The cleanup's snapshot is taken by its first read; an admin then edits a
        // pilot campaign on another connection and commits before the deletes run.
        await (tx as typeof prisma).campaign.count();
        await prisma.campaign.update({ where: { id: draft.id }, data: { emailSubject: "Edited mid-cleanup" } });
        return fn(tx);
      }, options)) as never);

    const error = await clearPilotData({ actor: "Josh" }).catch((caught) => caught);

    // P2034 is Prisma's serialization failure; under Read Committed the apply would succeed.
    expect(error).toMatchObject({ code: "P2034" });
    expect(await prisma.campaign.count()).toBe(2);
    expect(await prisma.auditEvent.count()).toBe(auditBefore);
    expect(await prisma.emailMessage.count()).toBe(emailsBefore);
    expect(await prisma.auditEvent.count({ where: { type: "PILOT_DATA_CLEARED" } })).toBe(0);
  });

  it("rolls back everything when a delete fails mid-apply", async () => {
    await seedPilot();
    const schema = new URL(process.env.DATABASE_URL!).searchParams.get("schema") ?? "public";
    const fn = `"${schema}".pilot_cleanup_fail_delete`;
    const table = `"${schema}"."Campaign"`;
    const auditBefore = await prisma.auditEvent.count();
    const emailsBefore = await prisma.emailMessage.count();
    const snapshotsBefore = await prisma.opportunitySnapshot.count();

    // Campaigns are deleted after audit, outbox and snapshots, so this fails late.
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'pilot_cleanup_forced_failure'; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(`CREATE TRIGGER pilot_cleanup_fail_delete BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(clearPilotData({ actor: "Josh" })).rejects.toThrow(/pilot_cleanup_forced_failure/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS pilot_cleanup_fail_delete ON ${table}`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }

    expect(await prisma.campaign.count()).toBe(2);
    expect(await prisma.auditEvent.count()).toBe(auditBefore);
    expect(await prisma.emailMessage.count()).toBe(emailsBefore);
    expect(await prisma.opportunitySnapshot.count()).toBe(snapshotsBefore);
  });
});

describe("cleanup arguments", () => {
  it("defaults to a dry run", () => {
    expect(parseCleanupArgs([], DB_URL)).toEqual({ ok: true, apply: false });
  });

  it("applies with a matching host and an actor", () => {
    expect(parseCleanupArgs(["--apply", "--confirm", "db.prod.example", "--actor", "Josh"], DB_URL)).toEqual({
      ok: true,
      apply: true,
      actor: "Josh",
    });
  });

  it("refuses a host that does not match, without echoing either host or the credentials", () => {
    const result = parseCleanupArgs(["--apply", "--confirm", "db.other.example", "--actor", "Josh"], DB_URL);
    expect(result.ok).toBe(false);
    const message = (result as { message: string }).message;
    expect(message).toContain("does not match");
    expect(message).not.toContain("db.prod.example");
    expect(message).not.toContain("db.other.example");
    expect(message).not.toContain("secret");
  });

  it("refuses --apply without --actor or --confirm", () => {
    expect(parseCleanupArgs(["--apply", "--confirm", "db.prod.example"], DB_URL).ok).toBe(false);
    expect(parseCleanupArgs(["--apply", "--actor", "Josh"], DB_URL).ok).toBe(false);
    expect(parseCleanupArgs(["--apply", "--actor"], DB_URL).ok).toBe(false);
  });

  it("refuses a flag given twice", () => {
    expect(parseCleanupArgs(["--apply", "--apply"], DB_URL).ok).toBe(false);
    expect(
      parseCleanupArgs(["--apply", "--confirm", "db.prod.example", "--actor", "Josh", "--actor", "Eve"], DB_URL).ok,
    ).toBe(false);
    expect(
      parseCleanupArgs(["--apply", "--confirm", "db.other.example", "--confirm", "db.prod.example", "--actor", "Josh"], DB_URL).ok,
    ).toBe(false);
  });

  it("refuses unknown arguments", () => {
    expect(parseCleanupArgs(["--force"], DB_URL).ok).toBe(false);
  });

  it("names the target by the first host label only", () => {
    expect(hostLabel("postgresql://u:secret@ep-cool-123.us-east-2.aws.neon.tech/db")).toBe("ep-cool-123");
    expect(hostLabel(DB_URL)).not.toContain("secret");
  });
});

describe("the clear-pilot-data script", () => {
  const script = fileURLToPath(new URL("../scripts/clear-pilot-data.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  function run(args: string[]) {
    try {
      const output = execFileSync("npx", ["tsx", script, ...args], { cwd, env: { ...process.env }, stdio: "pipe", encoding: "utf8" });
      return { code: 0, output };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  async function snapshot() {
    return { campaigns: await prisma.campaign.count(), emails: await prisma.emailMessage.count(), audit: await prisma.auditEvent.count() };
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedPilot();
  });

  it("dry-runs by default: exits 0 and changes nothing", { timeout: 120_000 }, async () => {
    const before = await snapshot();
    const result = run([]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Dry run. Nothing was changed.");
    expect(await snapshot()).toEqual(before);
  });

  it("exits non-zero and deletes nothing when --confirm names the wrong host", { timeout: 120_000 }, async () => {
    const before = await snapshot();
    const result = run(["--apply", "--confirm", "wrong-host", "--actor", "T"]);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("does not match");
    expect(await snapshot()).toEqual(before);
  });
});
