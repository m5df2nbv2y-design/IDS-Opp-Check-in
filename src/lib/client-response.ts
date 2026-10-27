import type { OpportunityStage } from "./stages";

export const WIN_PROBABILITIES = [
  { stage: "QUALIFICATION", label: "10%" },
  { stage: "PROPOSAL", label: "50%" },
  { stage: "SPECIFIED", label: "75%" },
  { stage: "NEGOTIATION", label: "90%" },
] as const;

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
