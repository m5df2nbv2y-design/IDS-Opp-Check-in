import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import {
  listOpenOpportunitiesForAccount,
  listSignals,
  markSignalReviewed,
  refreshSmartsheetSignals,
  saveSignalDraftResponse,
} from "@/server/services/smartsheet-signal-service";
import { resetDatabase } from "./fixtures";

/**
 * Integration coverage for the Smartsheet vertical slice: ingest the fixed
 * mock signals against a real (mock) Salesforce-backed catalog, and confirm
 * each of the five seeded signals lands in the match state the fixture data
 * was built to demonstrate — plus idempotency and the review/draft workflow.
 */
describe("smartsheet signal ingestion", () => {
  beforeAll(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("fetches the mock signals and matches each against the opportunity catalog", async () => {
    const result = await refreshSmartsheetSignals("test");

    expect(result.fetched).toBe(5);
    expect(result.matched).toBe(3);
    expect(result.ambiguous).toBe(1);
    expect(result.unmatched).toBe(1);

    const signals = await listSignals();
    expect(signals).toHaveLength(5);
  });

  it("matches a signal that names a Salesforce Opportunity Id directly", async () => {
    const signal = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4471" },
      include: { opportunity: true },
    });

    expect(signal.matchStatus).toBe("MATCHED");
    expect(signal.matchReason).toBe("OPPORTUNITY_ID");
    expect(signal.opportunity?.opportunityName).toBe("MRI Suite Renovation");
    expect(signal.opportunity?.customerName).toBe("Memorial Hospital");
  });

  it("matches a signal by account and project name with no id column", async () => {
    const signal = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4483" },
      include: { opportunity: { include: { account: true } } },
    });

    expect(signal.matchStatus).toBe("MATCHED");
    expect(signal.matchReason).toBe("ACCOUNT_AND_PROJECT");
    expect(signal.opportunity?.opportunityName).toBe("Cardiac Cath Lab Modernization");
    expect(signal.opportunity?.account.name).toBe("XYZ Agency");
  });

  it("flags a signal AMBIGUOUS when the account has multiple open opportunities and no project name", async () => {
    const signal = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4502" },
      include: { account: true },
    });

    expect(signal.matchStatus).toBe("AMBIGUOUS");
    expect(signal.opportunityId).toBeNull();
    expect(signal.account?.name).toBe("Cornerstone Health Partners");

    const candidates = await listOpenOpportunitiesForAccount(signal.accountId!);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.map((c) => c.opportunityName)).toContain("Research Imaging Core Lab");
    expect(candidates.map((c) => c.opportunityName)).toContain("Specimen Radiography Install");
  });

  it("flags a signal UNMATCHED when the account isn't in the catalog", async () => {
    const signal = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4519" },
    });

    expect(signal.matchStatus).toBe("UNMATCHED");
    expect(signal.opportunityId).toBeNull();
    expect(signal.accountId).toBeNull();
    expect(signal.rawAccountName).toBe("Meridian Referral Partners");
  });

  it("is idempotent — re-ingesting the same fixed signals does not duplicate rows", async () => {
    const before = await prisma.opportunitySignal.count();

    const result = await refreshSmartsheetSignals("test");
    const after = await prisma.opportunitySignal.count();

    expect(result.fetched).toBe(5);
    expect(after).toBe(before);
  });

  it("re-ingestion never clobbers a PM's existing review/draft state", async () => {
    const signal = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4471" },
    });
    await markSignalReviewed(signal.id, "test-admin");

    await refreshSmartsheetSignals("test");

    const reReviewed = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4471" },
    });
    expect(reReviewed.status).toBe("REVIEWED");
    expect(reReviewed.reviewedBy).toBe("test-admin");
  });

  it("marks a signal reviewed and logs it once", async () => {
    const signal = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4483" },
    });
    expect(signal.status).toBe("NEW");

    await markSignalReviewed(signal.id, "pm@ids.example.com");

    const updated = await prisma.opportunitySignal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("REVIEWED");
    expect(updated.reviewedAt).not.toBeNull();
    expect(updated.reviewedBy).toBe("pm@ids.example.com");

    // Scoped to this signal's opportunity — an earlier test already reviewed a
    // different signal, so a global count would double-count across tests.
    const events = await prisma.auditEvent.findMany({
      where: { type: "SIGNAL_REVIEWED", opportunityId: updated.opportunityId },
    });
    expect(events).toHaveLength(1);
  });

  it("saves a local draft response without sending anything, and it survives re-ingestion", async () => {
    const signal = await prisma.opportunitySignal.findUniqueOrThrow({
      where: { externalId: "ss-row-4460" },
    });

    await saveSignalDraftResponse(signal.id, "Following up with the architect today.", "pm@ids.example.com");

    const drafted = await prisma.opportunitySignal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(drafted.status).toBe("DRAFTED");
    expect(drafted.draftResponse).toBe("Following up with the architect today.");
    expect(drafted.draftedAt).not.toBeNull();

    await refreshSmartsheetSignals("test");
    const afterReingest = await prisma.opportunitySignal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(afterReingest.draftResponse).toBe("Following up with the architect today.");
    expect(afterReingest.status).toBe("DRAFTED");
  });

  it("never touches Salesforce — no opportunity stage or sync fields change from ingestion", async () => {
    const before = await prisma.opportunity.findMany({
      select: { id: true, currentStage: true, lastSyncedAt: true },
      orderBy: { id: "asc" },
    });

    await refreshSmartsheetSignals("test");

    const after = await prisma.opportunity.findMany({
      select: { id: true, currentStage: true, lastSyncedAt: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);

    const mockOrgWrites = await prisma.mockSalesforceOpportunity.count({
      where: { description: { not: null } },
    });
    expect(mockOrgWrites).toBe(0);
  });
});
