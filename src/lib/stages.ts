/**
 * Controlled opportunity stage values for the MVP.
 *
 * These are the only values the rep can choose and the only values we will push
 * back to Salesforce. `salesforceValue` is the picklist API value written to
 * Opportunity.StageName — keep this map in sync with the org's picklist rather
 * than scattering string literals through the app.
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
] as const;

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
