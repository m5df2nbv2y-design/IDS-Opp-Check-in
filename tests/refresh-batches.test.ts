import { describe, expect, it } from "vitest";
import { inBatches } from "@/lib/batches";
import { prisma } from "@/lib/db";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

describe("inBatches", () => {
  it("runs every item, never more than `size` at once", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await inBatches([...Array(25).keys()], 10, async (n) => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      done.push(n); running -= 1;
    });
    expect(done.sort((a, b) => a - b)).toEqual([...Array(25).keys()]);
    expect(peak).toBeLessThanOrEqual(10);
    expect(peak).toBeGreaterThan(1);
  });

  it("finishes the whole batch before reporting a failure", async () => {
    const finished: number[] = [];
    await expect(inBatches([1, 2, 3, 4], 2, async (n) => {
      if (n === 1) throw new Error("boom");
      await new Promise((r) => setTimeout(r, 5));
      finished.push(n);
    })).rejects.toThrow("boom");
    expect(finished).toEqual([2]); // the batch-mate finished; the next batch never started
  });
});

describe("catalog refresh after batching", () => {
  it("stores the same catalogue on a second refresh and records no new snapshots", async () => {
    await resetDatabase();
    await prisma.opportunitySnapshot.deleteMany();
    const first = await refreshCatalogFromSalesforce("test");
    // Counters stay right under concurrency: one snapshot per recorded change.
    expect(await prisma.opportunitySnapshot.count({ where: { source: "CATALOG_REFRESH" } })).toBe(first.snapshotsRecorded);
    // Every opportunity the refresh saw is still open (none dropped from the seen list).
    expect(await prisma.opportunity.count({ where: { isOpen: true } })).toBe(first.opportunities);
    const counts = async () => Promise.all([prisma.salesRep.count(), prisma.account.count(), prisma.externalContact.count(), prisma.opportunity.count({ where: { isOpen: true } })]);
    const before = await counts();
    const second = await refreshCatalogFromSalesforce("test");
    expect(await counts()).toEqual(before);
    expect(second.opportunities).toBe(first.opportunities);
    expect(second.snapshotsRecorded).toBe(0);
  });
});
