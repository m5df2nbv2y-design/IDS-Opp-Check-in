import type { OpportunityStage } from "./stages";

export const WIN_PROBABILITIES = [
  { stage: "QUALIFICATION", label: "10%" },
  { stage: "PROPOSAL", label: "50%" },
  { stage: "SPECIFIED", label: "75%" },
  { stage: "NEGOTIATION", label: "90%" },
] as const;

/**
 * The numeric win probability the recipient was shown for a stage.
 *
 * Parsed from the same table the UI renders, so the number written to
 * Salesforce is by construction the number the person actually saw. Keeping a
 * second hardcoded mapping here would be a silent way for the two to drift.
 *
 * Returns null for stages with no probability shown — the closed stages, where
 * Salesforce sets 100 or 0 from the stage itself and our opinion is not wanted.
 */
export function probabilityForStage(stage: string): number | null {
  const entry = WIN_PROBABILITIES.find((row) => row.stage === stage);
  if (!entry) return null;
  const parsed = Number.parseInt(entry.label, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export type LossReasonOption = { value: string; label: string };
/** Deliberately excludes amount and the Salesforce current stage. */
export type RecipientOpportunity = {
  id: string;
  projectName: string;
  createdDate: string | null;
  selectedStage: OpportunityStage | null;
  selectedCloseDate: string | null;
  currentCloseDate: string | null;
  selectedLossReason: string | null;
  comment: string;
};
export function validResponseDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Object Describe isn't record-type scoped. Refuse ambiguous, dependent, or
 * custom-record-type choices until a record-scoped metadata path is available. */
export function lossReasonOptionsFromDescribe(metadata: {
  fields?: { label: string; type: string; dependentPicklist?: boolean; picklistValues?: { active: boolean; value: string; label: string }[] }[];
  recordTypeInfos?: { available: boolean; master: boolean }[];
}): LossReasonOption[] {
  const fields = metadata.fields?.filter((field) => field.label === "Loss Reason") ?? [];
  if (fields.length !== 1 || fields[0].type !== "picklist" || fields[0].dependentPicklist ||
    metadata.recordTypeInfos?.some((type) => type.available && !type.master)) return [];
  return fields[0].picklistValues?.filter((option) => option.active)
    .map(({ value, label }) => ({ value, label })) ?? [];
}
