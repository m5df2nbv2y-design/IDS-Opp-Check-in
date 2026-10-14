import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  OPEN_PIPELINE_STAGES,
  OPPORTUNITY_STAGES,
  isOpportunityStage,
  stageToSalesforce,
} from "@/lib/stages";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { completeCheckIn, saveResponse } from "@/server/services/response-service";
import { buildPipelineReport } from "@/server/services/report-service";
import { getSnapshotEvidence } from "@/server/services/analytics-service";
import { MockSalesforceService } from "@/server/integrations/salesforce/mock/mock-salesforce-service";
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

/**
 * REGRESSION — a reported closure must actually leave the open pipeline.
 *
 * The block above only proves a clean org has no closed stage in it, which it
 * never would. These tests drive the whole path a real answer takes:
 *
 *   recipient answers CLOSED_LOST  →  completeCheckIn  →  sync writes to the
 *   mock org  →  catalogue refresh re-reads the org  →  reporting
 *
 * The original defect lived at the write: the mock set stageName and left
 * isClosed alone, so the next refresh read the record back as OPEN while it
 * carried a terminal stage. It then reached pipeline-by-stage, because
 * report-service sorts an unrecognised stage LAST rather than hiding it — so a
 * "Closed Lost" row could appear in the Executive Pipeline Brief's open
 * pipeline. Of the nine tests added here, SEVEN fail against that defect. The
 * other two pass either way by design and are labelled as such: one preserves
 * the recipient's reason, which the defect never touched but write-back will
 * need, and one guards the opposite direction — that the value drop comes from
 * the closure rather than from quietly losing its neighbours.
 *
 * completeCheckIn only syncs once every one of a recipient's items is
 * answered, so the rest of Jane Doe's opportunities are confirmed at their
 * existing stage. They double as the control group: one closure must not
 * disturb them.
 */
describe("a reported closure leaves the open pipeline", () => {
  const CLOSED_EXTERNAL_ID = "006Ab00000Opp05AAA"; // "Surgical Imaging Upgrade", Negotiation

  let opportunityId: string;
  let survivingOpportunityIds: string[];
  /** Open pipeline value BEFORE the closure — the baseline to subtract from. */
  let baselineTotal: number;
  /** The closed opportunity's amount, read from the record rather than hardcoded. */
  let closedAmount: number;

  beforeEach(async () => {
    await resetDatabase();

    const { campaignId, tokens } = await launchCampaignAndCollectTokens("Closure Round Trip");
    const token = tokens.get("Jane Doe")!;
    const items = await itemsForContact(campaignId, "Jane Doe");

    // Jane holds several opportunities, and completeCheckIn only syncs once
    // EVERY item is answered — so the others are confirmed at their current
    // stage. That also keeps them in play as the control group: exactly one
    // opportunity is being closed here.
    const withOpportunity = await prisma.checkInOpportunity.findMany({
      where: { id: { in: items.map((item) => item.id) } },
      include: { opportunity: { select: { id: true, externalId: true, currentStage: true } } },
    });

    const closing = withOpportunity.find(
      (item) => item.opportunity.externalId === CLOSED_EXTERNAL_ID,
    );
    expect(closing, `${CLOSED_EXTERNAL_ID} must be one of Jane Doe's opportunities`).toBeDefined();
    opportunityId = closing!.opportunity.id;
    survivingOpportunityIds = withOpportunity
      .filter((item) => item.opportunity.externalId !== CLOSED_EXTERNAL_ID)
      .map((item) => item.opportunity.id);
    expect(survivingOpportunityIds.length).toBeGreaterThan(0);

    // Measured BEFORE anything is answered. Proving the closed amount left the
    // open pipeline needs a before-and-after comparison; asserting that no
    // bucket happens to equal the amount only catches accidental equality.
    const baseline = await buildPipelineReport();
    baselineTotal = baseline.byStage.reduce((sum, row) => sum + row.value, 0);
    closedAmount = (
      await prisma.opportunity.findUniqueOrThrow({
        where: { id: opportunityId },
        select: { amount: true },
      })
    ).amount;
    expect(closedAmount).toBeGreaterThan(0);
    expect(baselineTotal).toBeGreaterThan(closedAmount);

    for (const item of withOpportunity) {
      const isClosing = item.opportunity.externalId === CLOSED_EXTERNAL_ID;
      const saved = await saveResponse({
        token,
        itemId: item.id,
        stage: isClosing ? "CLOSED_LOST" : item.opportunity.currentStage,
        comment: isClosing ? "Capital project cancelled; the wing is not being built." : null,
      });
      expect(saved.ok, `answering ${item.opportunity.externalId}`).toBe(true);
    }

    // Pushes the answers into the mock org, which is where the defect was.
    const completed = await completeCheckIn(token);
    expect(completed.ok).toBe(true);

    await refreshCatalogFromSalesforce("test");
  });

  it("marks the record closed IN THE MOCK ORG, not merely restaged", async () => {
    const record = await prisma.mockSalesforceOpportunity.findUniqueOrThrow({
      where: { externalId: CLOSED_EXTERNAL_ID },
    });

    expect(record.stageName).toBe("Closed Lost");
    // The defect: stageName moved and this did not.
    expect(record.isClosed).toBe(true);
  });

  it("drops the opportunity from open discovery", async () => {
    const open = await new MockSalesforceService().getOpenOpportunities();
    expect(open.map((o) => o.externalId)).not.toContain(CLOSED_EXTERNAL_ID);
  });

  it("records the outcome locally instead of leaving it open", async () => {
    const stored = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });

    expect(stored.isOpen).toBe(false);
    expect(stored.isWon).toBe(false);
    expect(stored.finalStage).toBe("Closed Lost");
    expect(stored.outcomeObservedAt).toBeInstanceOf(Date);
  });

  it("NEVER lets the terminal stage into open pipeline-by-stage", async () => {
    const evidence = await getSnapshotEvidence();
    const report = await buildPipelineReport();

    // The analytics grouping is the origin of the row...
    expect(evidence.pipelineByStage.map((row) => row.stage)).not.toContain("CLOSED_LOST");
    // ...and the Executive Pipeline Brief reads from it.
    expect(report.byStage.map((row) => row.stage)).not.toContain("CLOSED_LOST");

    // Every surviving row must be a genuinely open stage, so this cannot pass
    // by accident if another terminal stage is added later.
    const openValues = OPEN_PIPELINE_STAGES.map((stage) => stage.value);
    for (const row of report.byStage) {
      expect(openValues, `${row.stage} is not an open stage`).toContain(row.stage);
    }
  });

  it("subtracts EXACTLY the closed amount from open pipeline value", async () => {
    const report = await buildPipelineReport();
    const total = report.byStage.reduce((sum, row) => sum + row.value, 0);

    // The only record that changed is the one that closed: the other answers
    // confirm an unchanged stage, which syncs as SKIPPED and writes nothing.
    // So the open pipeline must have fallen by precisely that one amount —
    // not merely "not contain a bucket equal to it", which a wrong total can
    // satisfy whenever the amount is pooled with other records.
    expect(total).toBe(baselineTotal - closedAmount);

    // And the drop must be real, not the whole table emptying.
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(baselineTotal);
  });

  it("keeps the surviving opportunities' value intact", async () => {
    // Guards the other direction: the subtraction above must come from the
    // closure, not from quietly losing the opportunities answered alongside it.
    const surviving = await prisma.opportunity.findMany({
      where: { id: { in: survivingOpportunityIds } },
      select: { amount: true, isOpen: true },
    });

    expect(surviving).toHaveLength(survivingOpportunityIds.length);
    for (const opportunity of surviving) {
      expect(opportunity.isOpen).toBe(true);
      expect(opportunity.amount).toBeGreaterThan(0);
    }
  });

  it("leaves every other open opportunity untouched", async () => {
    const open = await prisma.opportunity.findMany({ where: { isOpen: true } });
    const openIds = new Set(open.map((opportunity) => opportunity.id));

    // The sample org is not emptied by one closure.
    expect(open.length).toBeGreaterThan(10);
    expect(open.map((o) => o.externalId)).not.toContain(CLOSED_EXTERNAL_ID);

    // Jane's OTHER opportunities answered in the same check-in stay open.
    for (const id of survivingOpportunityIds) {
      expect(openIds.has(id), `${id} must still be open`).toBe(true);
    }

    for (const opportunity of open) {
      expect(opportunity.currentStage).not.toBe("CLOSED_LOST");
    }
  });

  it("keeps the recipient's reason, which write-back will need", async () => {
    const item = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { opportunityId },
    });

    expect(item.updatedStatus).toBe("CLOSED_LOST");
    expect(item.repComment).toContain("Capital project cancelled");
  });
});

describe("the mock org refuses to re-close an already closed record", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("rejects a write to a closed opportunity, as Salesforce would", async () => {
    const salesforce = new MockSalesforceService();
    const externalId = "006Ab00000Opp05AAA";

    await salesforce.updateOpportunityStatus(externalId, "CLOSED_LOST");

    // The existing guard only engages once isClosed is actually set, which is
    // the other half of what the fix restores.
    await expect(salesforce.updateOpportunityStatus(externalId, "PROPOSAL")).rejects.toThrow(
      /closed and can no longer be edited/i,
    );
  });
});
