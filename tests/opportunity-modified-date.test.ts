import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  getDraftSummary,
  getOrCreateDraft,
  listDraftAccounts,
  setSelection,
  toDayRange,
} from "@/server/services/campaign-draft-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

/**
 * "Date last modified" on every opportunity, so administrators can work by
 * recency.
 *
 * Three things have to stay true, and each is easy to get subtly wrong:
 *
 *   1. The value is SALESFORCE's modification stamp. Our import time and our
 *      own row's updatedAt are different facts, and substituting either would
 *      silently invent Salesforce history.
 *   2. An unknown date stays unknown. It is not "very old", and it must not be
 *      quietly dropped from a filtered view by default.
 *   3. Filtering and sorting change the VIEW only. A campaign's selected
 *      opportunities are not touched by narrowing what is on screen.
 */

async function rows(campaignId: string, filters = {}) {
  const groups = await listDraftAccounts(campaignId, filters);
  return groups.flatMap((group) => group.opportunities);
}

describe("inclusive whole-day filter bounds", () => {
  it("covers the whole of both boundary days", () => {
    const range = toDayRange("2026-03-01", "2026-03-31");
    expect(range.gte?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    // Must include the last moment of the 31st, not stop at its first.
    expect(range.lte?.toISOString()).toBe("2026-03-31T23:59:59.999Z");
  });

  it("allows an open-ended window at either end", () => {
    expect(toDayRange("2026-03-01", undefined).lte).toBeUndefined();
    expect(toDayRange(undefined, "2026-03-31").gte).toBeUndefined();
  });

  it("ignores malformed input rather than inventing a bound", () => {
    expect(toDayRange("march", "2026-13-45")).toEqual({});
    expect(toDayRange("", "")).toEqual({});
  });
});

describe("the modification date on each opportunity", () => {
  let campaignId: string;
  let ids: { recent: string; old: string; unknown: string };

  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    campaignId = (await getOrCreateDraft("test")).id;

    const open = await prisma.opportunity.findMany({
      where: { isOpen: true }, orderBy: { externalId: "asc" }, take: 3, select: { id: true },
    });
    ids = { recent: open[0].id, old: open[1].id, unknown: open[2].id };

    // The mock org stamps every record, so clear them first: otherwise the
    // three under test are not the only ones with a date.
    await prisma.opportunity.updateMany({ data: { salesforceLastModifiedAt: null } });
    await prisma.opportunity.update({
      where: { id: ids.recent },
      data: { salesforceLastModifiedAt: new Date("2026-03-20T10:00:00.000Z") },
    });
    await prisma.opportunity.update({
      where: { id: ids.old },
      data: { salesforceLastModifiedAt: new Date("2025-01-05T10:00:00.000Z") },
    });
    await prisma.opportunity.update({
      where: { id: ids.unknown },
      data: { salesforceLastModifiedAt: null },
    });
  });

  it("is carried through to the dashboard rows", async () => {
    const all = await rows(campaignId);
    const recent = all.find((row) => row.id === ids.recent)!;
    expect(recent.lastModifiedAt?.toISOString()).toBe("2026-03-20T10:00:00.000Z");
    expect(all.find((row) => row.id === ids.unknown)!.lastModifiedAt).toBeNull();
  });

  it("is NOT the import time or our own row timestamp", async () => {
    const stored = await prisma.opportunity.findUniqueOrThrow({
      where: { id: ids.recent },
      select: { salesforceLastModifiedAt: true, lastSyncedAt: true, updatedAt: true },
    });
    // The import just ran, so both local stamps are "now" — a substituted value
    // would be indistinguishable from them.
    expect(stored.salesforceLastModifiedAt?.toISOString()).toBe("2026-03-20T10:00:00.000Z");
    expect(stored.salesforceLastModifiedAt).not.toEqual(stored.lastSyncedAt);
    expect(stored.salesforceLastModifiedAt).not.toEqual(stored.updatedAt);
  });

  it("orders newest and oldest first, keeping unknowns last BOTH ways", async () => {
    const newest = await rows(campaignId, { sort: "modified_desc" });
    const known = newest.filter((row) => row.lastModifiedAt);
    expect(known[0].id).toBe(ids.recent);
    expect(newest[newest.length - 1].lastModifiedAt).toBeNull();

    const oldest = await rows(campaignId, { sort: "modified_asc" });
    expect(oldest.filter((row) => row.lastModifiedAt)[0].id).toBe(ids.old);
    // An unknown date is not "oldest" — it is unknown, so it stays at the end.
    expect(oldest[oldest.length - 1].lastModifiedAt).toBeNull();
  });
});

describe("the date window", () => {
  let campaignId: string;
  let recent: string;
  let old: string;
  let unknown: string;

  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    campaignId = (await getOrCreateDraft("test")).id;
    const open = await prisma.opportunity.findMany({
      where: { isOpen: true }, orderBy: { externalId: "asc" }, take: 3, select: { id: true },
    });
    [recent, old, unknown] = open.map((o) => o.id);
    await prisma.opportunity.updateMany({ data: { salesforceLastModifiedAt: null } });
    await prisma.opportunity.update({ where: { id: recent }, data: { salesforceLastModifiedAt: new Date("2026-03-20T10:00:00.000Z") } });
    await prisma.opportunity.update({ where: { id: old }, data: { salesforceLastModifiedAt: new Date("2025-01-05T10:00:00.000Z") } });
  });

  it("keeps only what falls inside it, plus unknowns by default", async () => {
    const found = await rows(campaignId, { modifiedFrom: "2026-03-01", modifiedTo: "2026-03-31" });
    const ids = found.map((row) => row.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
    // Unknowns are kept unless explicitly excluded: a date filter should narrow
    // by what is known, not hide records whose date was never imported.
    expect(ids).toContain(unknown);
  });

  it("excludes unknowns only when explicitly asked", async () => {
    const found = await rows(campaignId, {
      modifiedFrom: "2026-03-01", modifiedTo: "2026-03-31", includeUnknownModified: false,
    });
    const ids = found.map((row) => row.id);
    expect(ids).toContain(recent);
    expect(ids).not.toContain(unknown);
  });

  it("includes a record modified on the LAST day of the window", async () => {
    await prisma.opportunity.update({
      where: { id: recent },
      data: { salesforceLastModifiedAt: new Date("2026-03-31T23:30:00.000Z") },
    });
    const found = await rows(campaignId, {
      modifiedFrom: "2026-03-01", modifiedTo: "2026-03-31", includeUnknownModified: false,
    });
    expect(found.map((row) => row.id)).toContain(recent);
  });
});

describe("filtering never changes what is selected", () => {
  it("preserves selections outside the filtered view, and the reported total", async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    const campaignId = (await getOrCreateDraft("test")).id;

    const open = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
      orderBy: { externalId: "asc" }, take: 2, select: { id: true },
    });
    await prisma.opportunity.updateMany({ data: { salesforceLastModifiedAt: null } });
    await prisma.opportunity.update({ where: { id: open[0].id }, data: { salesforceLastModifiedAt: new Date("2026-03-20T10:00:00.000Z") } });
    await prisma.opportunity.update({ where: { id: open[1].id }, data: { salesforceLastModifiedAt: new Date("2020-01-01T10:00:00.000Z") } });

    await setSelection({ campaignId, opportunityIds: [open[0].id, open[1].id], selected: true, actor: "test" });
    const before = await getDraftSummary(campaignId);
    expect(before.selectedOpportunities).toBe(2);

    // A window that can only show one of them.
    const narrowed = await rows(campaignId, {
      modifiedFrom: "2026-03-01", modifiedTo: "2026-03-31", includeUnknownModified: false,
    });
    expect(narrowed.map((row) => row.id)).toContain(open[0].id);
    expect(narrowed.map((row) => row.id)).not.toContain(open[1].id);

    // The hidden one is still selected, and the count still says two — the
    // campaign is not quietly shrunk by what happens to be on screen.
    const after = await getDraftSummary(campaignId);
    expect(after.selectedOpportunities).toBe(2);
    const stillSelected = await prisma.campaignSelection.count({
      where: { campaignId, opportunityId: open[1].id },
    });
    expect(stillSelected).toBe(1);
  });
});
