import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { getSalesforceService } from "@/server/integrations/salesforce";
import * as audit from "@/server/services/audit-service";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import {
  listUncertainWrites,
  reconcileUncertainWrite,
} from "@/server/services/reconcile-service";
import { retryFailedSyncs } from "@/server/services/sync-service";
import { anUncertainItem, resetDatabase } from "./fixtures";

/**
 * Getting out of UNCERTAIN.
 *
 * UNCERTAIN means a PATCH left the process and Salesforce never confirmed it.
 * The item is excluded from the claim set `{ PENDING, FAILED, WITHHELD }` so no
 * automatic or bulk operation can touch it — which is correct, and which until
 * now left an administrator with a badge reading "Verify in Salesforce" and
 * nothing to do about what they found.
 *
 * These tests pin the properties that make a manual exit safe rather than a
 * back door:
 *
 *   - it is the ONLY exit, and automatic retry still cannot reach UNCERTAIN
 *   - it is per item, revision-bound, and cannot be won twice
 *   - "not applied" does NOT secretly retry the write
 *   - the audit trail distinguishes a HUMAN ATTESTATION from an observed API
 *     result, because conflating them would corrupt the one record the system
 *     offers as evidence of what happened
 */

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => vi.restoreAllMocks());

/** An UNCERTAIN item whose recipient had answered, as the write being attested always is. */
async function anAnsweredUncertainItem(extra: { syncedAt?: Date } = {}) {
  const { campaignId, item } = await anUncertainItem();
  const answered = await prisma.checkInOpportunity.update({
    where: { id: item.id },
    data: { updatedStatus: "NEGOTIATION", ...extra },
  });
  return { campaignId, item: answered };
}

/** An attestation carries the same account, rep and stage transition as every other SYNC_* event. */
async function expectFullAuditContext(
  type: string,
  item: { id: string; previousStatus: string; updatedStatus: string | null },
) {
  const { opportunity } = await prisma.checkInOpportunity.findUniqueOrThrow({
    where: { id: item.id },
    select: { opportunity: { select: { accountId: true, internalRepId: true } } },
  });
  const event = await prisma.auditEvent.findFirstOrThrow({ where: { type } });
  expect(item.updatedStatus).toBe("NEGOTIATION");
  expect(event).toMatchObject({
    accountId: opportunity.accountId,
    repId: opportunity.internalRepId,
    fromStatus: item.previousStatus,
    toStatus: "NEGOTIATION",
  });
}

describe("the only exit from UNCERTAIN", () => {
  it("is not reachable by automatic retry — before or after this feature", async () => {
    const { campaignId, item } = await anUncertainItem();

    await retryFailedSyncs(campaignId, "test");

    const after = await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: item.id },
      select: { syncStatus: true },
    });
    // Still waiting for a person. A bulk retry must never silently decide this.
    expect(after.syncStatus).toBe("UNCERTAIN");
  });

  it("surfaces the item so it cannot sit unnoticed", async () => {
    const { campaignId, item } = await anUncertainItem();

    const waiting = await listUncertainWrites(campaignId);
    expect(waiting.map((row) => row.id)).toContain(item.id);

    // And scoped: another campaign's queue does not show it.
    const elsewhere = await listUncertainWrites("some-other-campaign-id");
    expect(elsewhere).toHaveLength(0);
  });
});

describe("reporting that the write DID land", () => {
  it("marks it synced, clears the error, and stamps syncedAt", async () => {
    const { campaignId, item } = await anUncertainItem();

    const result = await reconcileUncertainWrite({
      campaignId,
      itemId: item.id,
      revision: item.updatedAt.toISOString(),
      observed: "APPLIED",
      actor: "admin@idsculpture.test",
    });
    expect(result).toMatchObject({ ok: true, nextStatus: "SYNCED" });

    const after = await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: item.id },
      select: { syncStatus: true, syncError: true, syncedAt: true },
    });
    expect(after.syncStatus).toBe("SYNCED");
    expect(after.syncError).toBeNull();
    expect(after.syncedAt).not.toBeNull();
  });

  it("records a HUMAN attestation, not an observed API success", async () => {
    const { campaignId, item } = await anAnsweredUncertainItem();
    await reconcileUncertainWrite({
      campaignId,
      itemId: item.id,
      revision: item.updatedAt.toISOString(),
      observed: "APPLIED",
      actor: "admin@idsculpture.test",
      note: "Stage and close date both match",
    });

    // The distinction is the point: SYNC_SUCCEEDED means Salesforce told us so.
    const attested = await prisma.auditEvent.findFirstOrThrow({
      where: { type: AUDIT_EVENTS.SYNC_RECONCILED_APPLIED, campaignId },
    });
    expect(attested.actor).toBe("admin@idsculpture.test");
    expect(attested.actorKind).toBe("ADMIN");
    expect(attested.summary).toContain("Stage and close date both match");
    await expectFullAuditContext(AUDIT_EVENTS.SYNC_RECONCILED_APPLIED, item);

    const claimedAsApiSuccess = await prisma.auditEvent.count({
      where: { type: AUDIT_EVENTS.SYNC_SUCCEEDED, campaignId },
    });
    expect(claimedAsApiSuccess).toBe(0);
  });
});

describe("reporting that the write did NOT land", () => {
  it("makes the response approvable again WITHOUT retrying the write itself", async () => {
    // A real timestamp to clear, or the null assertion below could not fail.
    const { campaignId, item } = await anAnsweredUncertainItem({ syncedAt: new Date("2026-01-01T00:00:00Z") });

    const result = await reconcileUncertainWrite({
      campaignId,
      itemId: item.id,
      revision: item.updatedAt.toISOString(),
      observed: "NOT_APPLIED",
      actor: "admin@idsculpture.test",
    });
    expect(result).toMatchObject({ ok: true, nextStatus: "FAILED" });

    const after = await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: item.id },
      select: { syncStatus: true, syncError: true, syncedAt: true },
    });
    // FAILED puts it back in the claim set, so a fresh approval can act.
    expect(after.syncStatus).toBe("FAILED");
    // But it was NOT written: reconciling what happened and deciding to try
    // again are separate decisions, and one click must not do both.
    expect(after.syncedAt).toBeNull();
    expect(after.syncError).toMatch(/did not reach Salesforce/i);
  });

  it("writes a distinct audit type from the applied case", async () => {
    const { campaignId, item } = await anAnsweredUncertainItem();
    await reconcileUncertainWrite({
      campaignId,
      itemId: item.id,
      revision: item.updatedAt.toISOString(),
      observed: "NOT_APPLIED",
      actor: "admin@idsculpture.test",
    });

    expect(
      await prisma.auditEvent.count({
        where: { type: AUDIT_EVENTS.SYNC_RECONCILED_NOT_APPLIED, campaignId },
      }),
    ).toBe(1);
    await expectFullAuditContext(AUDIT_EVENTS.SYNC_RECONCILED_NOT_APPLIED, item);
    expect(
      await prisma.auditEvent.count({
        where: { type: AUDIT_EVENTS.SYNC_RECONCILED_APPLIED, campaignId },
      }),
    ).toBe(0);
  });
});

describe("it cannot be used carelessly", () => {
  it("refuses a stale revision rather than resolving the wrong state", async () => {
    const { campaignId, item } = await anUncertainItem();

    const result = await reconcileUncertainWrite({
      campaignId,
      itemId: item.id,
      revision: new Date(item.updatedAt.getTime() - 60_000).toISOString(),
      observed: "APPLIED",
      actor: "admin@idsculpture.test",
    });
    expect(result).toEqual({ ok: false, reason: "STALE" });

    const after = await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: item.id },
      select: { syncStatus: true },
    });
    expect(after.syncStatus).toBe("UNCERTAIN");
  });

  it("refuses an item that is not UNCERTAIN", async () => {
    const { campaignId, item } = await anUncertainItem();
    const synced = await prisma.checkInOpportunity.update({
      where: { id: item.id },
      data: { syncStatus: "SYNCED" },
    });

    const result = await reconcileUncertainWrite({
      campaignId,
      itemId: synced.id,
      revision: synced.updatedAt.toISOString(),
      observed: "NOT_APPLIED",
      actor: "admin@idsculpture.test",
    });
    expect(result).toEqual({ ok: false, reason: "NOT_UNCERTAIN" });
  });

  it("refuses an item from another campaign", async () => {
    const { item } = await anUncertainItem();

    const result = await reconcileUncertainWrite({
      campaignId: "not-this-campaign",
      itemId: item.id,
      revision: item.updatedAt.toISOString(),
      observed: "APPLIED",
      actor: "admin@idsculpture.test",
    });
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("cannot be won twice when two administrators resolve at once", async () => {
    const { campaignId, item } = await anUncertainItem();
    const revision = item.updatedAt.toISOString();

    // One says it landed, the other says it did not. Exactly one may win, or
    // the audit trail would assert both at once about the same record.
    const [a, b] = await Promise.all([
      reconcileUncertainWrite({
        campaignId, itemId: item.id, revision, observed: "APPLIED", actor: "admin-a",
      }),
      reconcileUncertainWrite({
        campaignId, itemId: item.id, revision, observed: "NOT_APPLIED", actor: "admin-b",
      }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    expect(winners).toHaveLength(1);

    const events = await prisma.auditEvent.count({
      where: {
        campaignId,
        type: {
          in: [AUDIT_EVENTS.SYNC_RECONCILED_APPLIED, AUDIT_EVENTS.SYNC_RECONCILED_NOT_APPLIED],
        },
      },
    });
    expect(events).toBe(1);
  });
});

/**
 * What an attestation is allowed to change, and what must survive a failure.
 *
 * The state change and its audit record are one transaction: an audit write
 * that fails must leave the item exactly as it was, UNCERTAIN and still
 * attestable, never changed and unaudited.
 */

type Uncertain = Awaited<ReturnType<typeof anUncertainItem>>;
type Outcome = "APPLIED" | "NOT_APPLIED";

const ACTOR = "admin@idsculpture.test";
const reconcileAudits = () =>
  prisma.auditEvent.count({
    where: {
      type: { in: [AUDIT_EVENTS.SYNC_RECONCILED_APPLIED, AUDIT_EVENTS.SYNC_RECONCILED_NOT_APPLIED] },
    },
  });
const row = (id: string) => prisma.checkInOpportunity.findUniqueOrThrow({ where: { id } });

/** Attest the revision the administrator was looking at; `tamper` overrides one field of the request. */
const attest = ({ campaignId, item }: Uncertain, observed: Outcome, tamper: Record<string, unknown> = {}) =>
  reconcileUncertainWrite({
    campaignId,
    itemId: item.id,
    revision: item.updatedAt.toISOString(),
    observed,
    actor: ACTOR,
    ...tamper,
  } as Parameters<typeof reconcileUncertainWrite>[0]);

/** The whole row is as the fixture left it (revision included) and no reconcile audit exists. */
async function expectUntouched({ item }: Uncertain) {
  expect(await row(item.id)).toEqual(item);
  expect(await reconcileAudits()).toBe(0);
}

describe("a failed audit write leaves the item UNCERTAIN", () => {
  // "before": the insert itself fails. "after": the row IS inserted through the
  // client it was handed and the call then fails; the row can only disappear
  // if the audit shares the item's transaction rather than committing alone.
  it.each([
    ["APPLIED", "before"],
    ["APPLIED", "after"],
    ["NOT_APPLIED", "before"],
    ["NOT_APPLIED", "after"],
  ] as const)("%s, audit fails %s the insert", async (observed, when) => {
    const ctx = await anUncertainItem();
    const original = audit.recordAudit;
    vi.spyOn(audit, "recordAudit").mockImplementation(async (input, db) => {
      if (when === "after") await original(input, db);
      throw new Error("audit unavailable");
    });

    await expect(attest(ctx, observed)).rejects.toThrow("audit unavailable");

    await expectUntouched(ctx);

    // Nothing was half-done: the same attestation still goes through.
    vi.restoreAllMocks();
    expect(await attest(ctx, observed)).toMatchObject({ ok: true });
    expect(await reconcileAudits()).toBe(1);
  });
});

describe("a stale or foreign attestation writes nothing", () => {
  it.each([
    ["older than the item", (at: Date) => new Date(at.getTime() - 60_000).toISOString()],
    ["newer than the item", (at: Date) => new Date(at.getTime() + 60_000).toISOString()],
    ["not a date", () => "not-a-revision"],
  ])("a revision %s is STALE", async (_label, revisionFor) => {
    const ctx = await anUncertainItem();
    const result = await attest(ctx, "APPLIED", { revision: revisionFor(ctx.item.updatedAt) });
    expect(result).toEqual({ ok: false, reason: "STALE" });
    await expectUntouched(ctx);
  });

  it("the page's revision goes stale when the item moves on underneath it", async () => {
    const ctx = await anUncertainItem();
    const moved = await prisma.checkInOpportunity.update({
      where: { id: ctx.item.id },
      data: {
        syncError: "Salesforce returned HTTP 502.",
        updatedAt: new Date(ctx.item.updatedAt.getTime() + 5_000),
      },
    });
    expect(await attest(ctx, "NOT_APPLIED")).toEqual({ ok: false, reason: "STALE" });
    await expectUntouched({ ...ctx, item: moved });
  });

  it.each(["PENDING", "SYNCING", "SYNCED", "FAILED", "WITHHELD"])("an item that is %s is NOT_UNCERTAIN", async (syncStatus) => {
    const ctx = await anUncertainItem();
    const moved = await prisma.checkInOpportunity.update({ where: { id: ctx.item.id }, data: { syncStatus } });
    expect(await attest({ ...ctx, item: moved }, "APPLIED")).toEqual({ ok: false, reason: "NOT_UNCERTAIN" });
    await expectUntouched({ ...ctx, item: moved });
  });

  it("an item that belongs to another campaign is NOT_FOUND", async () => {
    const ctx = await anUncertainItem();
    const other = await prisma.campaign.create({ data: { name: "Another Campaign", period: "Test" } });
    expect(await attest(ctx, "APPLIED", { campaignId: other.id })).toEqual({ ok: false, reason: "NOT_FOUND" });
    await expectUntouched(ctx);
  });

  it("an unknown item id is NOT_FOUND", async () => {
    const ctx = await anUncertainItem();
    expect(await attest(ctx, "APPLIED", { itemId: "no-such-item" })).toEqual({ ok: false, reason: "NOT_FOUND" });
    await expectUntouched(ctx);
  });
});

describe("invalid input is rejected before any database write", () => {
  it.each([
    ["an outcome that is neither APPLIED nor NOT_APPLIED", { observed: "SYNCED" }, /valid reconciliation outcome/],
    ["a missing outcome", { observed: undefined }, /valid reconciliation outcome/],
    ["a missing item id", { itemId: undefined }, /could not be identified/],
    ["a numeric item id", { itemId: 42 }, /could not be identified/],
    ["an item id that is a query filter", { itemId: { not: "no-such-item" } }, /could not be identified/],
    ["an empty item id", { itemId: "" }, /could not be identified/],
    ["a missing campaign id", { campaignId: undefined }, /could not be identified/],
    ["a campaign id that is a query filter", { campaignId: { contains: "" } }, /could not be identified/],
    ["a missing revision", { revision: undefined }, /could not be identified/],
    ["a numeric revision", { revision: Date.now() }, /could not be identified/],
    ["a note over 500 characters", { note: "x".repeat(501) }, /500 characters/],
    ["a note that is not a string", { note: { length: 1 } }, /500 characters/],
  ])("rejects %s", async (_label, tamper, message) => {
    const ctx = await anUncertainItem();
    const transaction = vi.spyOn(prisma, "$transaction");

    await expect(attest(ctx, "APPLIED", tamper)).rejects.toThrow(message);

    expect(transaction).not.toHaveBeenCalled();
    await expectUntouched(ctx);
  });

  it("accepts a note of exactly 500 characters and records it", async () => {
    const ctx = await anUncertainItem();
    expect(await attest(ctx, "APPLIED", { note: "n".repeat(500) })).toMatchObject({ ok: true });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { type: AUDIT_EVENTS.SYNC_RECONCILED_APPLIED } });
    expect(event.summary).toContain("n".repeat(500));
  });
});

describe("two attestations racing for one item", () => {
  /**
   * Poll for the second attestation's UPDATE to be waiting on the first one's
   * row lock, so the interleaving is forced rather than hoped for. Kept well
   * inside Prisma's 5s interactive-transaction timeout, which the first
   * attestation is still running under.
   */
  async function waitForBlockedUpdate() {
    for (let attempt = 0; attempt < 60; attempt++) {
      const [{ blocked }] = await prisma.$queryRaw<{ blocked: number }[]>`
        SELECT count(*)::int AS blocked FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE '%UPDATE%CheckInOpportunity%'`;
      if (blocked > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The second attestation never reached the first one's row lock.");
  }

  it.each([
    ["APPLIED", "APPLIED"],
    ["NOT_APPLIED", "NOT_APPLIED"],
    ["APPLIED", "NOT_APPLIED"],
    ["NOT_APPLIED", "APPLIED"],
  ] as const)("%s racing %s: the first to hold the row wins, the second is refused as STALE", async (firstOutcome, secondOutcome) => {
    const ctx = await anUncertainItem();
    const original = audit.recordAudit;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(audit, "recordAudit").mockImplementation(async (input, db) => {
      entered();
      await gate;
      return original(input, db);
    });

    // The first has updated the row and is paused before its audit insert. The
    // second reads the same UNCERTAIN revision, then blocks on the first's lock.
    const first = attest(ctx, firstOutcome, { actor: "admin-a" });
    await ready;
    const second = attest(ctx, secondOutcome, { actor: "admin-b" });
    try {
      await waitForBlockedUpdate();
    } finally {
      release();
    }
    const [a, b] = await Promise.all([first, second]);

    expect(a).toMatchObject({ ok: true, outcome: firstOutcome });
    expect(b).toEqual({ ok: false, reason: "STALE" });
    const events = await prisma.auditEvent.findMany({
      where: { type: { in: [AUDIT_EVENTS.SYNC_RECONCILED_APPLIED, AUDIT_EVENTS.SYNC_RECONCILED_NOT_APPLIED] } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "admin-a", type: `SYNC_RECONCILED_${firstOutcome}` });
    expect((await row(ctx.item.id)).syncStatus).toBe(firstOutcome === "APPLIED" ? "SYNCED" : "FAILED");
  });
});

describe("a repeated attestation", () => {
  it.each([
    ["APPLIED", "APPLIED"],
    ["APPLIED", "NOT_APPLIED"],
    ["NOT_APPLIED", "NOT_APPLIED"],
    ["NOT_APPLIED", "APPLIED"],
  ] as const)("%s then %s: the second is NOT_UNCERTAIN and changes nothing", async (first, second) => {
    const ctx = await anUncertainItem();
    expect(await attest(ctx, first)).toMatchObject({ ok: true });
    const settled = await row(ctx.item.id);

    expect(await attest(ctx, second)).toEqual({ ok: false, reason: "NOT_UNCERTAIN" });

    expect(await row(ctx.item.id)).toEqual(settled);
    expect(await reconcileAudits()).toBe(1);
  });
});

describe("reconciling never reaches Salesforce or email", () => {
  /** A spy on every method a provider exposes, so a call to any of them is caught. */
  function spyOnEveryMethod(service: object) {
    const proto = Object.getPrototypeOf(service) as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== "constructor" && typeof proto[name] === "function")
      .map((name) => vi.spyOn(service as Record<string, (...args: never[]) => unknown>, name));
  }

  it.each([
    ["APPLIED", false],
    ["NOT_APPLIED", false],
    ["APPLIED", true],
    ["NOT_APPLIED", true],
  ] as const)("%s, audit failing: %s", async (observed, auditFails) => {
    const ctx = await anUncertainItem();
    const salesforce = getSalesforceService();
    const email = getEmailService();
    const providerSpies = [...spyOnEveryMethod(salesforce), ...spyOnEveryMethod(email)];
    // Guard against a vacuous pass: the write and the send are definitely watched.
    expect(vi.isMockFunction(salesforce.applyUpdate) && vi.isMockFunction(email.send)).toBe(true);
    const crm = () => prisma.mockSalesforceOpportunity.findMany({ orderBy: { externalId: "asc" } });
    const [crmBefore, emailsBefore] = [await crm(), await prisma.emailMessage.count()];
    if (auditFails) vi.spyOn(audit, "recordAudit").mockRejectedValue(new Error("audit unavailable"));

    const attempt = attest(ctx, observed);
    if (auditFails) await expect(attempt).rejects.toThrow("audit unavailable");
    else await expect(attempt).resolves.toMatchObject({ ok: true });

    for (const spy of providerSpies) expect(spy).not.toHaveBeenCalled();
    expect(await crm()).toEqual(crmBefore);
    expect(await prisma.emailMessage.count()).toBe(emailsBefore);
  });

  it("the service imports no integration at all, so the live provider is unreachable too", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    expect(readFileSync(`${root}src/server/services/reconcile-service.ts`, "utf8")).not.toMatch(/integrations|fetch\(/);
  });
});
