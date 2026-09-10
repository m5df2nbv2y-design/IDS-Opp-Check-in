import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  getSnapshotHistory,
  recordSnapshot,
  SNAPSHOT_SOURCES,
} from "@/server/services/snapshot-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import {
  getOrCreateDraft,
  sendDraft,
  setSelection,
} from "@/server/services/campaign-draft-service";
import { resetDatabase } from "./fixtures";

/**
 * The durable history behind CFO reporting.
 *
 * The governing property: once an observation is made it must survive both the
 * mutable local cache AND Salesforce overwriting its own history. These tests
 * simulate Salesforce changing underneath us and assert the record still holds.
 */

async function tracked(name: string) {
  return prisma.opportunity.findFirstOrThrow({
    where: { opportunityName: name },
    include: { account: true, internalRep: true },
  });
}

describe("opportunity snapshot history", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("records a baseline observation for every opportunity on first refresh", async () => {
    const opportunities = await prisma.opportunity.count({ where: { isOpen: true } });
    const snapshots = await prisma.opportunitySnapshot.count({
      where: { source: SNAPSHOT_SOURCES.CATALOG_REFRESH },
    });

    expect(opportunities).toBeGreaterThan(0);
    expect(snapshots).toBe(opportunities);
  });

  it("is a change log, not a fact dump — an unchanged refresh writes nothing", async () => {
    const before = await prisma.opportunitySnapshot.count();

    const result = await refreshCatalogFromSalesforce("test");

    expect(result.snapshotsRecorded).toBe(0);
    expect(await prisma.opportunitySnapshot.count()).toBe(before);
  });

  it("records a new observation when the stage moves in Salesforce", async () => {
    const opportunity = await tracked("MRI Suite Renovation");
    expect(opportunity.currentStage).toBe("PROPOSAL");

    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: { stageName: "Negotiation" },
    });
    const result = await refreshCatalogFromSalesforce("test");

    expect(result.snapshotsRecorded).toBe(1);

    const history = await getSnapshotHistory(opportunity.externalId);
    expect(history).toHaveLength(2);
    expect(history[0].stage).toBe("PROPOSAL");
    expect(history[1].stage).toBe("NEGOTIATION");
    // Movement we did NOT cause is still observed — the point of polling.
    expect(history[1].source).toBe(SNAPSHOT_SOURCES.CATALOG_REFRESH);
  });

  it("records amount and close-date movement", async () => {
    const opportunity = await tracked("CT Scanner Replacement");

    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: { amount: 999_000, closeDate: new Date("2028-01-31T00:00:00.000Z") },
    });
    await refreshCatalogFromSalesforce("test");

    const history = await getSnapshotHistory(opportunity.externalId);
    expect(history).toHaveLength(2);
    expect(history[1].amount).toBe(999_000);
    expect(history[1].closeDate?.toISOString().slice(0, 10)).toBe("2028-01-31");
    // The earlier value survives — this is the whole point.
    expect(history[0].amount).toBe(opportunity.amount);
  });

  it("keeps account and rep names on the row so history stays readable", async () => {
    const snapshot = await prisma.opportunitySnapshot.findFirstOrThrow();
    expect(snapshot.accountName).not.toBe("");
    expect(snapshot.internalRepName).not.toBe("");
  });
});

describe("terminal outcome capture", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("captures Closed WON after the opportunity leaves the open set", async () => {
    const opportunity = await tracked("MRI Suite Renovation");

    // Salesforce closes it. It will never appear in the open query again.
    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: {
        isClosed: true,
        stageName: "Closed Won",
        amount: 480_000,
        closeDate: new Date("2026-11-15T00:00:00.000Z"),
      },
    });

    const result = await refreshCatalogFromSalesforce("test");
    expect(result.outcomesObserved).toBe(1);

    const closed = await prisma.opportunity.findUniqueOrThrow({
      where: { externalId: opportunity.externalId },
    });
    expect(closed.isOpen).toBe(false);
    expect(closed.isWon).toBe(true);
    expect(closed.finalStage).toBe("Closed Won");
    expect(closed.finalAmount).toBe(480_000);
    expect(closed.closedAt?.toISOString().slice(0, 10)).toBe("2026-11-15");
    // When WE learned it, which is not when it happened.
    expect(closed.outcomeObservedAt).not.toBeNull();
  });

  it("captures Closed LOST distinctly from won", async () => {
    const opportunity = await tracked("CT Scanner Replacement");
    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: { isClosed: true, stageName: "Closed Lost", amount: 0 },
    });

    await refreshCatalogFromSalesforce("test");

    const closed = await prisma.opportunity.findUniqueOrThrow({
      where: { externalId: opportunity.externalId },
    });
    expect(closed.isWon).toBe(false);
    expect(closed.finalStage).toBe("Closed Lost");
  });

  it("writes an OUTCOME_OBSERVED snapshot terminating the timeline", async () => {
    const opportunity = await tracked("Surgical Imaging Upgrade");
    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: { isClosed: true, stageName: "Closed Won", amount: 220_000 },
    });
    await refreshCatalogFromSalesforce("test");

    const history = await getSnapshotHistory(opportunity.externalId);
    const last = history[history.length - 1];
    expect(last.source).toBe(SNAPSHOT_SOURCES.OUTCOME_OBSERVED);
    expect(last.isOpen).toBe(false);
    expect(last.isWon).toBe(true);
    expect(last.stage).toBe("Closed Won");
    // Raw Salesforce stage, NOT forced into the four controlled values.
    expect(["QUALIFICATION", "PROPOSAL", "SPECIFIED", "NEGOTIATION"]).not.toContain(last.stage);
  });

  it("audits the close with the stage transition", async () => {
    const opportunity = await tracked("Mobile MRI Pad & Utilities");
    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: { isClosed: true, stageName: "Closed Won", amount: 150_000 },
    });
    await refreshCatalogFromSalesforce("test");

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { type: "OPPORTUNITY_CLOSED", opportunityId: opportunity.id },
    });
    expect(event.toStatus).toBe("Closed Won");
    expect(event.fromStatus).toBe(opportunity.currentStage);
  });

  it("does not freeze a guess when the outcome cannot be read", async () => {
    const opportunity = await tracked("Nuclear Medicine Shielding Retrofit");
    // Vanishes entirely — deleted, or no longer visible to the integration user.
    await prisma.mockSalesforceOpportunity.delete({
      where: { externalId: opportunity.externalId },
    });

    const result = await refreshCatalogFromSalesforce("test");
    expect(result.outcomesObserved).toBe(0);

    const stale = await prisma.opportunity.findUniqueOrThrow({
      where: { externalId: opportunity.externalId },
    });
    expect(stale.isOpen).toBe(false);
    // Left null so a later refresh can try again rather than recording a lie.
    expect(stale.outcomeObservedAt).toBeNull();
    expect(stale.isWon).toBeNull();
  });

  it("does not re-observe an outcome it already captured", async () => {
    const opportunity = await tracked("Interventional Radiology Buildout");
    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: { isClosed: true, stageName: "Closed Won", amount: 1_275_000 },
    });

    expect((await refreshCatalogFromSalesforce("test")).outcomesObserved).toBe(1);
    expect((await refreshCatalogFromSalesforce("test")).outcomesObserved).toBe(0);
  });
});

describe("intervention history", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("freezes the pipeline value at the moment of selection", async () => {
    const draft = await getOrCreateDraft("test");
    const opportunity = await tracked("Cardiac Cath Lab Modernization");

    await setSelection({
      campaignId: draft.id,
      opportunityIds: [opportunity.id],
      selected: true,
      actor: "analyst@ids.example.com",
    });

    // Salesforce moves the number afterwards.
    await prisma.opportunity.update({
      where: { id: opportunity.id },
      data: { amount: 1 },
    });

    const selection = await prisma.campaignSelection.findFirstOrThrow({
      where: { campaignId: draft.id, opportunityId: opportunity.id },
    });
    expect(selection.amountAtSelection).toBe(opportunity.amount);
    expect(selection.stageAtSelection).toBe(opportunity.currentStage);
    expect(selection.selectedBy).toBe("analyst@ids.example.com");
    expect(selection.selectedAt).toBeInstanceOf(Date);
  });

  it("marks the intervention point on the observation timeline", async () => {
    const draft = await getOrCreateDraft("test");
    const opportunity = await tracked("PET/CT Suite Addition");

    await setSelection({ campaignId: draft.id, opportunityIds: [opportunity.id], selected: true });
    await sendDraft(draft.id, "test");

    const history = await getSnapshotHistory(opportunity.externalId);
    const launch = history.find((row) => row.source === SNAPSHOT_SOURCES.CAMPAIGN_LAUNCH);
    expect(launch).toBeDefined();
    expect(launch?.amount).toBe(opportunity.amount);
    expect(launch?.stage).toBe(opportunity.currentStage);
  });

  it("keeps intervention and outcome as SEPARATE facts with no attribution", async () => {
    const draft = await getOrCreateDraft("test");
    const opportunity = await tracked("Women's Imaging Expansion");

    await setSelection({ campaignId: draft.id, opportunityIds: [opportunity.id], selected: true });
    await sendDraft(draft.id, "test");

    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: opportunity.externalId },
      data: { isClosed: true, stageName: "Closed Won", amount: 520_000 },
    });
    await refreshCatalogFromSalesforce("test");

    const history = await getSnapshotHistory(opportunity.externalId);
    const sources = history.map((row) => row.source);
    expect(sources).toContain(SNAPSHOT_SOURCES.CAMPAIGN_LAUNCH);
    expect(sources).toContain(SNAPSHOT_SOURCES.OUTCOME_OBSERVED);

    // Both facts are timestamped and ordered, so ANY attribution window can be
    // computed later — but nothing in the schema claims the outreach caused the
    // outcome. No influenced/attributed field exists to be wrong about.
    const launch = history.find((r) => r.source === SNAPSHOT_SOURCES.CAMPAIGN_LAUNCH)!;
    const outcome = history.find((r) => r.source === SNAPSHOT_SOURCES.OUTCOME_OBSERVED)!;
    expect(outcome.observedAt.getTime()).toBeGreaterThanOrEqual(launch.observedAt.getTime());

    const columns = Object.keys(outcome);
    for (const forbidden of ["influencedBy", "attributedTo", "causedBy", "attribution"]) {
      expect(columns).not.toContain(forbidden);
    }
  });
});

describe("snapshot service", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("always records event-marking sources even when nothing changed", async () => {
    const opportunity = await tracked("Linear Accelerator Vault");
    const base = {
      opportunityId: opportunity.id,
      externalId: opportunity.externalId,
      amount: opportunity.amount,
      stage: opportunity.currentStage,
      closeDate: opportunity.closeDate,
      isOpen: true,
      accountId: opportunity.accountId,
      accountName: opportunity.account.name,
      internalRepId: opportunity.internalRepId,
      internalRepName: opportunity.internalRep.name,
    };

    // Identical values: routine polling is suppressed…
    expect(await recordSnapshot({ ...base, source: SNAPSHOT_SOURCES.CATALOG_REFRESH })).toBe(false);
    // …but an event is always worth a row on the timeline.
    expect(await recordSnapshot({ ...base, source: SNAPSHOT_SOURCES.CAMPAIGN_LAUNCH })).toBe(true);
  });
});
