import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import {
  listUncertainWrites,
  reconcileUncertainWrite,
} from "@/server/services/reconcile-service";
import { retryFailedSyncs } from "@/server/services/sync-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

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

async function anUncertainItem() {
  const launched = await launchCampaignAndCollectTokens("Reconcile Campaign");
  const item = await prisma.checkInOpportunity.findFirstOrThrow({
    where: { recipient: { campaignId: launched.campaignId } },
  });
  const uncertain = await prisma.checkInOpportunity.update({
    where: { id: item.id },
    data: { syncStatus: "UNCERTAIN", syncError: "Salesforce returned HTTP 503." },
  });
  return { campaignId: launched.campaignId, item: uncertain };
}

beforeEach(async () => {
  await resetDatabase();
});

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
    const { campaignId, item } = await anUncertainItem();
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

    const claimedAsApiSuccess = await prisma.auditEvent.count({
      where: { type: AUDIT_EVENTS.SYNC_SUCCEEDED, campaignId },
    });
    expect(claimedAsApiSuccess).toBe(0);
  });
});

describe("reporting that the write did NOT land", () => {
  it("makes the response approvable again WITHOUT retrying the write itself", async () => {
    const { campaignId, item } = await anUncertainItem();

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
    const { campaignId, item } = await anUncertainItem();
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
