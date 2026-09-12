import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  OPEN_PIPELINE_STAGES,
  OPPORTUNITY_STAGES,
  isOpportunityStage,
  stageToSalesforce,
} from "@/lib/stages";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { saveResponse } from "@/server/services/response-service";
import { buildPipelineReport } from "@/server/services/report-service";
import { itemsForContact, launchCampaignAndCollectTokens } from "./fixtures";
import { resetDatabase } from "./fixtures";

/**
 * Letting a customer close a dead project.
 *
 * A customer telling us a project is dead is better data than it sitting open
 * for another six months, so Closed Lost is offered. Closed Won deliberately is
 * NOT: a customer may retire an opportunity, but must never be able to book
 * revenue on it. That asymmetry is the whole point of this file.
 *
 * Closing something is a heavier claim than nudging a stage, so it is the one
 * answer that requires a reason in the customer's own words. That text is also
 * what a future write-back will have available for Salesforce's Loss Reason
 * field, which the opportunity form marks as required information.
 */

describe("the controlled stage list", () => {
  it("offers Closed Lost to the recipient", () => {
    const values = OPPORTUNITY_STAGES.map((s) => s.value);
    expect(values).toContain("CLOSED_LOST");
    expect(isOpportunityStage("CLOSED_LOST")).toBe(true);
  });

  it("NEVER offers Closed Won", () => {
    const values = OPPORTUNITY_STAGES.map((s) => s.value);
    expect(values).not.toContain("CLOSED_WON");
    expect(isOpportunityStage("CLOSED_WON")).toBe(false);

    // Nor anything else that would let a customer mark a deal as won.
    for (const s of OPPORTUNITY_STAGES) {
      expect(s.salesforceValue.toLowerCase()).not.toContain("won");
    }
  });

  it("maps Closed Lost to the exact Salesforce picklist value", () => {
    expect(stageToSalesforce("CLOSED_LOST")).toBe("Closed Lost");
  });

  it("keeps the open pipeline stages separate from the terminal one", () => {
    // Pipeline-by-stage describes OPEN pipeline. A closed stage in that table
    // would be a category error, so the two lists are distinct.
    const open = OPEN_PIPELINE_STAGES.map((s) => s.value);
    expect(open).toEqual(["QUALIFICATION", "PROPOSAL", "SPECIFIED", "NEGOTIATION"]);
    expect(open).not.toContain("CLOSED_LOST");
  });
});

describe("closing a project requires a reason", () => {
  let campaignId: string;
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    const launched = await launchCampaignAndCollectTokens("Closed Lost Test");
    campaignId = launched.campaignId;
    token = launched.tokens.get("Jane Doe")!;
  });

  it("REFUSES Closed Lost with no reason", async () => {
    const item = (await itemsForContact(campaignId, "Jane Doe"))[0];
    const result = await saveResponse({ token, itemId: item.id, stage: "CLOSED_LOST" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("REASON_REQUIRED");

    // Nothing was recorded — a refused answer must not half-save.
    const after = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.updatedStatus).toBeNull();
    expect(after.submittedAt).toBeNull();
  });

  it("REFUSES Closed Lost with a whitespace-only reason", async () => {
    const item = (await itemsForContact(campaignId, "Jane Doe"))[0];
    const result = await saveResponse({
      token,
      itemId: item.id,
      stage: "CLOSED_LOST",
      comment: "   \n  ",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("REASON_REQUIRED");
  });

  it("ACCEPTS Closed Lost with a reason and stores it", async () => {
    const item = (await itemsForContact(campaignId, "Jane Doe"))[0];
    const result = await saveResponse({
      token,
      itemId: item.id,
      stage: "CLOSED_LOST",
      comment: "Hospital cancelled the capital project after the budget review.",
    });

    expect(result.ok).toBe(true);

    const after = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.updatedStatus).toBe("CLOSED_LOST");
    expect(after.repComment).toContain("cancelled the capital project");
    expect(after.submittedAt).toBeInstanceOf(Date);
  });

  it("does NOT require a reason for any other stage", async () => {
    const items = await itemsForContact(campaignId, "Jane Doe");
    for (const stage of ["QUALIFICATION", "PROPOSAL", "SPECIFIED", "NEGOTIATION"] as const) {
      const result = await saveResponse({ token, itemId: items[0].id, stage });
      expect(result.ok, `${stage} must not require a reason`).toBe(true);
    }
  });

  it("still refuses Closed Won, reason or not", async () => {
    const item = (await itemsForContact(campaignId, "Jane Doe"))[0];
    const result = await saveResponse({
      token,
      itemId: item.id,
      stage: "CLOSED_WON",
      comment: "We won it",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_STAGE");
  });
});

describe("a Closed Lost response does not close the opportunity locally", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("leaves isOpen to Salesforce, as every other response does", async () => {
    // Decision: record only. The app does not become a second source of truth
    // for whether an opportunity is open - Salesforce decides that, and the
    // response is evidence for a human to act on in SFX.
    const { campaignId, tokens } = await launchCampaignAndCollectTokens("Record Only Test");
    const token = tokens.get("Jane Doe")!;
    const item = (await itemsForContact(campaignId, "Jane Doe"))[0];

    const before = await prisma.opportunity.findUniqueOrThrow({
      where: { id: item.opportunityId },
    });

    const result = await saveResponse({
      token,
      itemId: item.id,
      stage: "CLOSED_LOST",
      comment: "Project shelved indefinitely.",
    });
    expect(result.ok).toBe(true);

    const after = await prisma.opportunity.findUniqueOrThrow({
      where: { id: item.opportunityId },
    });
    expect(after.isOpen).toBe(before.isOpen);
    expect(after.currentStage).toBe(before.currentStage);
    expect(after.isWon).toBeNull();
  });
});

describe("reporting treats the terminal stage correctly", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("never shows a closed stage in the open pipeline breakdown", async () => {
    const report = await buildPipelineReport();
    const stages = report.byStage.map((row) => row.stage);
    expect(stages).not.toContain("CLOSED_LOST");
  });
});
