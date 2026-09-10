import { describe, expect, it } from "vitest";
import {
  matchSignalToOpportunity,
  SIGNAL_MATCH_REASONS,
  type OpportunityCandidate,
} from "@/server/services/signal-matching-service";
import type { SmartsheetSignal } from "@/server/integrations/smartsheet";

/**
 * Pure unit tests — no database, no fixtures beyond what's constructed here.
 * Mirrors tests/recipient-resolution.test.ts in shape.
 */

function signal(overrides: Partial<SmartsheetSignal>): SmartsheetSignal {
  return {
    externalId: "ss-test",
    sheetName: "Test Sheet",
    signalType: "REMINDER",
    title: "Test signal",
    message: "Test message",
    assignedToName: null,
    dueDate: null,
    occurredAt: new Date("2026-09-08T00:00:00Z"),
    sourceUrl: null,
    relatedOpportunityExternalId: null,
    relatedAccountName: null,
    relatedProjectName: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<OpportunityCandidate>): OpportunityCandidate {
  return {
    id: "opp-1",
    externalId: "006-test-1",
    accountId: "acct-1",
    accountName: "Test Account",
    opportunityName: "Test Opportunity",
    projectName: null,
    customerName: "Test Site",
    ...overrides,
  };
}

describe("matchSignalToOpportunity", () => {
  it("matches by an explicit Salesforce Opportunity Id", () => {
    const candidates = [
      candidate({ id: "opp-1", externalId: "006-A", accountId: "acct-1" }),
      candidate({ id: "opp-2", externalId: "006-B", accountId: "acct-2" }),
    ];
    const result = matchSignalToOpportunity(
      signal({ relatedOpportunityExternalId: "006-B" }),
      candidates,
    );

    expect(result).toEqual({
      status: "MATCHED",
      reason: SIGNAL_MATCH_REASONS.OPPORTUNITY_ID,
      opportunityId: "opp-2",
      accountId: "acct-2",
    });
  });

  it("falls through to name matching when the Opportunity Id doesn't resolve", () => {
    const candidates = [
      candidate({ id: "opp-1", externalId: "006-A", accountId: "acct-1", accountName: "Acme" }),
    ];
    const result = matchSignalToOpportunity(
      signal({ relatedOpportunityExternalId: "006-does-not-exist", relatedAccountName: "Acme" }),
      candidates,
    );

    expect(result.status).toBe("MATCHED");
    if (result.status !== "MATCHED") return;
    expect(result.reason).toBe(SIGNAL_MATCH_REASONS.SOLE_OPEN_OPPORTUNITY);
  });

  it("matches by account name and project name together", () => {
    const candidates = [
      candidate({ id: "opp-1", accountId: "acct-1", accountName: "XYZ Agency", opportunityName: "Cardiac Cath Lab Modernization" }),
      candidate({ id: "opp-2", accountId: "acct-1", accountName: "XYZ Agency", opportunityName: "Hybrid OR — Design Assist" }),
    ];
    const result = matchSignalToOpportunity(
      signal({ relatedAccountName: "XYZ Agency", relatedProjectName: "Hybrid OR — Design Assist" }),
      candidates,
    );

    expect(result.status).toBe("MATCHED");
    if (result.status !== "MATCHED") return;
    expect(result.opportunityId).toBe("opp-2");
    expect(result.reason).toBe(SIGNAL_MATCH_REASONS.ACCOUNT_AND_PROJECT);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    const candidates = [candidate({ id: "opp-1", accountId: "acct-1", accountName: "ABC Distribution" })];
    const result = matchSignalToOpportunity(
      signal({ relatedAccountName: "  abc distribution  " }),
      candidates,
    );

    expect(result.status).toBe("MATCHED");
  });

  it("matches on account alone when it is the only open opportunity there", () => {
    const candidates = [candidate({ id: "opp-1", accountId: "acct-1", accountName: "Beacon Surgical Group" })];
    const result = matchSignalToOpportunity(
      signal({ relatedAccountName: "Beacon Surgical Group" }),
      candidates,
    );

    expect(result).toEqual({
      status: "MATCHED",
      reason: SIGNAL_MATCH_REASONS.SOLE_OPEN_OPPORTUNITY,
      opportunityId: "opp-1",
      accountId: "acct-1",
    });
  });

  it("flags AMBIGUOUS when the account has several open opportunities and no project name narrows it", () => {
    const candidates = [
      candidate({ id: "opp-1", accountId: "acct-1", accountName: "Cornerstone Health Partners", opportunityName: "Research Imaging Core Lab" }),
      candidate({ id: "opp-2", accountId: "acct-1", accountName: "Cornerstone Health Partners", opportunityName: "Specimen Radiography Install" }),
    ];
    const result = matchSignalToOpportunity(
      signal({ relatedAccountName: "Cornerstone Health Partners" }),
      candidates,
    );

    expect(result.status).toBe("AMBIGUOUS");
    if (result.status !== "AMBIGUOUS") return;
    expect(result.reason).toBe(SIGNAL_MATCH_REASONS.MULTIPLE_OPEN_OPPORTUNITIES);
    expect(result.candidateOpportunityIds.sort()).toEqual(["opp-1", "opp-2"]);
  });

  it("flags AMBIGUOUS rather than guessing when a project name is given but matches nothing", () => {
    const candidates = [
      candidate({ id: "opp-1", accountId: "acct-1", accountName: "Cornerstone Health Partners", opportunityName: "Research Imaging Core Lab" }),
      candidate({ id: "opp-2", accountId: "acct-1", accountName: "Cornerstone Health Partners", opportunityName: "Specimen Radiography Install" }),
    ];
    const result = matchSignalToOpportunity(
      signal({ relatedAccountName: "Cornerstone Health Partners", relatedProjectName: "Something Unrelated" }),
      candidates,
    );

    expect(result.status).toBe("AMBIGUOUS");
  });

  it("flags UNMATCHED when the account isn't in the catalog at all", () => {
    const candidates = [candidate({ id: "opp-1", accountId: "acct-1", accountName: "Known Org" })];
    const result = matchSignalToOpportunity(
      signal({ relatedAccountName: "Meridian Referral Partners" }),
      candidates,
    );

    expect(result).toEqual({ status: "UNMATCHED", reason: SIGNAL_MATCH_REASONS.UNKNOWN_ACCOUNT });
  });

  it("flags UNMATCHED when the signal carries no identifying information", () => {
    const result = matchSignalToOpportunity(signal({}), [candidate({})]);

    expect(result).toEqual({ status: "UNMATCHED", reason: SIGNAL_MATCH_REASONS.NO_IDENTIFYING_INFO });
  });

  it("never matches across accounts even when a project name happens to collide", () => {
    const candidates = [
      candidate({ id: "opp-1", accountId: "acct-1", accountName: "Account A", opportunityName: "Shared Project Name" }),
      candidate({ id: "opp-2", accountId: "acct-2", accountName: "Account B", opportunityName: "Shared Project Name" }),
    ];
    const result = matchSignalToOpportunity(
      signal({ relatedAccountName: "Account B", relatedProjectName: "Shared Project Name" }),
      candidates,
    );

    expect(result.status).toBe("MATCHED");
    if (result.status !== "MATCHED") return;
    expect(result.opportunityId).toBe("opp-2");
  });
});
