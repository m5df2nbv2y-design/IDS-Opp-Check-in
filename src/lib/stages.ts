/**
 * Controlled opportunity stage values for the MVP.
 *
 * These are the only values a recipient can choose and the only values we will
 * push back to Salesforce. `salesforceValue` is the picklist API value written
 * to Opportunity.StageName — keep this map in sync with the org's picklist
 * rather than scattering string literals through the app.
 *
 * ---------------------------------------------------------------------------
 * Why Closed Lost is here and Closed Won is not
 * ---------------------------------------------------------------------------
 * The org's picklist also contains "Closed Won". It is deliberately absent from
 * this list, which is what makes it unselectable: a customer may tell us a
 * project is dead, but must never be able to book revenue on it. The asymmetry
 * is the point, not an oversight.
 *
 * Closed Lost is offered because a customer retiring a dead project is better
 * data than that project sitting open for another six months. Because it is a
 * heavier claim than nudging a stage, saveResponse() requires a reason with it.
 */

export const OPPORTUNITY_STAGES = [
  {
    value: "QUALIFICATION",
    label: "Qualification",
    salesforceValue: "Qualification",
  },
  {
    value: "PROPOSAL",
    label: "Proposal",
    salesforceValue: "Proposal",
  },
  {
    value: "SPECIFIED",
    label: "Specified",
    salesforceValue: "Specified",
  },
  {
    value: "NEGOTIATION",
    label: "Negotiation",
    salesforceValue: "Negotiation",
  },
  {
    value: "CLOSED_LOST",
    label: "Closed Lost",
    salesforceValue: "Closed Lost",
    /** Terminal: the project is over. Excluded from open-pipeline reporting. */
    closed: true,
  },
] as const;

/**
 * The stages that describe OPEN pipeline.
 *
 * Pipeline-by-stage reporting is a picture of what is still live, so a
 * terminal stage in that table would be a category error. Derived rather than
 * hand-listed, so adding a stage above cannot leave the two out of step.
 */
export const OPEN_PIPELINE_STAGES = OPPORTUNITY_STAGES.filter(
  (stage) => !("closed" in stage && stage.closed),
);

/** Whether a controlled stage means the opportunity is over. */
export function isClosedStage(value: string | null | undefined): boolean {
  return OPPORTUNITY_STAGES.some(
    (stage) => stage.value === value && "closed" in stage && stage.closed,
  );
}

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number]["value"];

const BY_VALUE = new Map(OPPORTUNITY_STAGES.map((s) => [s.value, s]));
const BY_SALESFORCE_VALUE = new Map(
  OPPORTUNITY_STAGES.map((s) => [s.salesforceValue.toLowerCase(), s]),
);

export function isOpportunityStage(value: unknown): value is OpportunityStage {
  return typeof value === "string" && BY_VALUE.has(value as OpportunityStage);
}

export function stageLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return BY_VALUE.get(value as OpportunityStage)?.label ?? value;
}

/** Map an inbound Salesforce picklist value onto our controlled value. */
export function stageFromSalesforce(salesforceValue: string): OpportunityStage | null {
  return BY_SALESFORCE_VALUE.get(salesforceValue.trim().toLowerCase())?.value ?? null;
}

/** Map our controlled value onto the Salesforce picklist value. */
export function stageToSalesforce(stage: OpportunityStage): string {
  const match = BY_VALUE.get(stage);
  if (!match) throw new Error(`Unknown opportunity stage: ${stage}`);
  return match.salesforceValue;
}
