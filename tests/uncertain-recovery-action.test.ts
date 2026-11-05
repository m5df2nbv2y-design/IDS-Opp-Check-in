import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileUncertainAction, type ReconcileActionResult } from "@/app/admin/actions";
import { prisma } from "@/lib/db";
import { ForbiddenError, UnauthorizedError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { anUncertainItem, resetDatabase } from "./fixtures";

/**
 * The action boundary of the only exit from UNCERTAIN.
 *
 * A server action is an individually addressable HTTP endpoint: the /admin
 * layout guard does not protect it, and its arguments are whatever the client
 * posts. These tests drive the real action with a session the test controls,
 * against a real database, and pin that an attestation is made only by an
 * authorized admin, is attributed to the identity the SERVER derived, and
 * changes nothing when it is refused.
 */

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};
// Typed loosely on purpose: the point is what happens when a client sends more or less than the signature says.
const call = reconcileUncertainAction as (...args: unknown[]) => Promise<ReconcileActionResult>;
type Uncertain = Awaited<ReturnType<typeof anUncertainItem>>;

const reconcileAudits = () =>
  prisma.auditEvent.count({
    where: {
      type: { in: [AUDIT_EVENTS.SYNC_RECONCILED_APPLIED, AUDIT_EVENTS.SYNC_RECONCILED_NOT_APPLIED] },
    },
  });

async function expectUntouched({ item }: Uncertain) {
  expect(await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: item.id } })).toEqual(item);
  expect(await reconcileAudits()).toBe(0);
  expect(session.revalidated).toEqual([]);
}

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
  session.current = null;
  session.revalidated.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a caller without an authorized admin session", () => {
  it.each([
    ["no session", null, UnauthorizedError],
    ["a session that carries no user", { expires: "soon" }, UnauthorizedError],
    ["a signed-in user holding no role", { user: { id: "u9", email: "someone.else@idsculpture.com", roles: [] } }, ForbiddenError],
    ["a signed-in user holding a different role", { user: { id: "u9", email: "reader@idsculpture.com", roles: ["Reader.Only"] } }, ForbiddenError],
  ])("is rejected, with %s", async (_label, current, expected) => {
    const ctx = await anUncertainItem();
    session.current = current;

    for (const observed of ["APPLIED", "NOT_APPLIED"]) {
      await expect(call(ctx.campaignId, ctx.item.id, ctx.item.updatedAt.toISOString(), observed)).rejects.toThrow(expected);
    }

    await expectUntouched(ctx);
  });

  it("is rejected for everyone when no authorization policy is configured", async () => {
    const ctx = await anUncertainItem();
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "");
    session.current = ADMIN;

    await expect(call(ctx.campaignId, ctx.item.id, ctx.item.updatedAt.toISOString(), "APPLIED")).rejects.toThrow(ForbiddenError);

    await expectUntouched(ctx);
  });
});

describe("an authorized admin", () => {
  it("is recorded as the identity the server derived, whatever the client sends", async () => {
    const ctx = await anUncertainItem();
    session.current = ADMIN;

    // A fifth argument is an attempt to name the actor; there is no such parameter.
    const result = await call(ctx.campaignId, ctx.item.id, ctx.item.updatedAt.toISOString(), "APPLIED", "attacker@evil.invalid");

    expect(result).toEqual({ ok: true });

    const after = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: ctx.item.id } });
    expect(after.syncStatus).toBe("SYNCED");
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { type: AUDIT_EVENTS.SYNC_RECONCILED_APPLIED } });
    expect(event).toMatchObject({ actor: "josh@idsculpture.com", actorKind: "ADMIN" });
    expect(event.summary).not.toContain("attacker");
    expect(session.revalidated).toContain(`/admin/campaigns/${ctx.campaignId}`);
  });

  it.each([
    ["a stale page", "STALE", /changed since the page was loaded/, (c: Uncertain) => call(c.campaignId, c.item.id, new Date(c.item.updatedAt.getTime() - 60_000).toISOString(), "APPLIED")],
    ["an unknown response", "NOT_FOUND", /no longer part of the campaign/, (c: Uncertain) => call(c.campaignId, "no-such-item", c.item.updatedAt.toISOString(), "APPLIED")],
  ])("is returned, not thrown, a readable refusal for %s, and nothing is written", async (_label, reason, message, attempt) => {
    const ctx = await anUncertainItem();
    session.current = ADMIN;

    const result = await attempt(ctx);

    expect(result).toEqual({ ok: false, reason, message: expect.stringMatching(message) });
    await expectUntouched(ctx);
  });

  it.each([
    ["a forged outcome", /valid reconciliation outcome/, (c: Uncertain) => call(c.campaignId, c.item.id, c.item.updatedAt.toISOString(), "SYNCED")],
    ["a non-string revision", /could not be identified/, (c: Uncertain) => call(c.campaignId, c.item.id, 123, "APPLIED")],
  ])("still rejects %s, and nothing is written", async (_label, message, attempt) => {
    const ctx = await anUncertainItem();
    session.current = ADMIN;

    await expect(attempt(ctx)).rejects.toThrow(message);

    await expectUntouched(ctx);
  });

  it("is returned NOT_UNCERTAIN when attesting twice, and nothing more is written", async () => {
    const ctx = await anUncertainItem();
    session.current = ADMIN;
    const revision = ctx.item.updatedAt.toISOString();
    expect(await call(ctx.campaignId, ctx.item.id, revision, "NOT_APPLIED")).toEqual({ ok: true });
    const settled = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: ctx.item.id } });
    const revalidated = [...session.revalidated];

    const second = await call(ctx.campaignId, ctx.item.id, revision, "APPLIED");

    expect(second).toEqual({ ok: false, reason: "NOT_UNCERTAIN", message: expect.stringMatching(/no longer awaiting reconciliation/) });
    expect(await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: ctx.item.id } })).toEqual(settled);
    expect(await reconcileAudits()).toBe(1);
    expect(session.revalidated).toEqual(revalidated); // a refusal revalidates nothing
  });
});
