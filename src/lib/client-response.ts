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

/**
 * Why a Describe was refused, when it was.
 *
 * The guards below are deliberately strict, and an empty list is the safe
 * outcome. But empty is also indistinguishable from "the field has no active
 * values", and the consequence reaches a customer: with no options, every
 * Closed Lost answer is rejected as INVALID_LOSS_REASON and the recipient
 * simply cannot complete their check-in. A refusal must therefore say WHY, so
 * it can be fixed rather than puzzled over.
 */
export type LossReasonRefusal =
  | "FIELD_NOT_FOUND"
  | "AMBIGUOUS_FIELD_LABEL"
  | "NOT_A_PICKLIST"
  | "DEPENDENT_PICKLIST"
  | "RECORD_TYPE_SCOPED"
  | "NO_ACTIVE_VALUES";

export const LOSS_REASON_REFUSAL_DETAIL: Record<LossReasonRefusal, string> = {
  FIELD_NOT_FOUND:
    'No field labelled exactly "Loss Reason" was returned by Describe. The match is on LABEL, not API name.',
  AMBIGUOUS_FIELD_LABEL:
    'More than one field is labelled "Loss Reason". Which one is meant cannot be guessed.',
  NOT_A_PICKLIST: "The field is not a picklist, so it has no choices to offer.",
  DEPENDENT_PICKLIST:
    "The field is a dependent picklist. Its valid choices vary with a controlling field, and Object Describe cannot say which apply.",
  RECORD_TYPE_SCOPED:
    "Opportunity has record types in use. Object Describe is not record-type scoped, so its list may not match what any given record actually allows.",
  NO_ACTIVE_VALUES: "The picklist exists but has no active values.",
};

type DescribeMetadata = {
  fields?: { label: string; type: string; dependentPicklist?: boolean; picklistValues?: { active: boolean; value: string; label: string }[] }[];
  recordTypeInfos?: { available: boolean; master: boolean }[];
};

/**
 * The same guards as `lossReasonOptionsFromDescribe`, but reporting the reason.
 *
 * Kept as a separate entry point so the strict mapper's contract — and the
 * tests pinning it — stay exactly as they were.
 */
export function diagnoseLossReasonDescribe(
  metadata: DescribeMetadata,
): { options: LossReasonOption[]; refusal: LossReasonRefusal | null } {
  const fields = metadata.fields?.filter((field) => field.label === "Loss Reason") ?? [];

  if (fields.length === 0) return { options: [], refusal: "FIELD_NOT_FOUND" };
  if (fields.length > 1) return { options: [], refusal: "AMBIGUOUS_FIELD_LABEL" };
  if (fields[0].type !== "picklist") return { options: [], refusal: "NOT_A_PICKLIST" };
  if (fields[0].dependentPicklist) return { options: [], refusal: "DEPENDENT_PICKLIST" };
  if (metadata.recordTypeInfos?.some((type) => type.available && !type.master)) {
    return { options: [], refusal: "RECORD_TYPE_SCOPED" };
  }

  const options = fields[0].picklistValues?.filter((option) => option.active)
    .map(({ value, label }) => ({ value, label })) ?? [];

  return options.length === 0
    ? { options: [], refusal: "NO_ACTIVE_VALUES" }
    : { options, refusal: null };
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
