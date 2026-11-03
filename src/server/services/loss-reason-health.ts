import {
  LOSS_REASON_REFUSAL_DETAIL,
  type LossReasonRefusal,
} from "@/lib/client-response";
import { getSalesforceService } from "@/server/integrations/salesforce";

/**
 * Why the Closed Lost choices are missing, in terms an administrator can act on.
 *
 * Without this the failure is silent in both directions: the recipient is told
 * the reasons are "currently unavailable", and the administrator sees nothing
 * at all unless they happen to read the deployment logs. The person who can
 * actually fix it is the one with the least information.
 *
 * Each refusal gets a REMEDY rather than only an explanation, because the
 * explanation alone still leaves "so what do I change?" unanswered.
 */

export type LossReasonHealth =
  | { ok: true; count: number }
  | { ok: false; refusal: LossReasonRefusal; detail: string; remedy: string };

const REMEDY: Record<LossReasonRefusal, string> = {
  FIELD_NOT_FOUND:
    "Most often this is field-level security, not a missing field: Salesforce omits fields the " +
    "integration user cannot read, so the field disappears from the response entirely. Check that " +
    "the integration user has Read access to the Loss Reason field, and that its label is still " +
    "exactly \"Loss Reason\" — the match is on label, not API name.",
  AMBIGUOUS_FIELD_LABEL:
    "Two or more Opportunity fields share the label \"Loss Reason\". Rename or retire one so the " +
    "intended field is unambiguous.",
  NOT_A_PICKLIST:
    "The field is not a picklist, so it has no choices to offer. Confirm the intended field is the " +
    "picklist one.",
  DEPENDENT_PICKLIST:
    "The field depends on a controlling field, so its valid choices vary per record and Object " +
    "Describe cannot say which apply. Reading these safely needs a record-type-scoped call — tell " +
    "the development team rather than changing the field.",
  RECORD_TYPE_SCOPED:
    "Opportunity now has an active record type beyond Master. Object Describe is not record-type " +
    "scoped, so its list may not match what a given record permits. This needs a record-type-scoped " +
    "call — tell the development team.",
  NO_ACTIVE_VALUES:
    "The picklist exists but every value is inactive. Activate the reasons recipients should be " +
    "able to choose.",
};

/**
 * Returns null when there is nothing to report — either the provider cannot
 * refuse (the mock org's choices are fixed), or the read is working.
 *
 * Deliberately swallows its own errors: a diagnostic that can break the page
 * it is diagnosing is worse than no diagnostic.
 */
export async function lossReasonHealth(): Promise<LossReasonHealth | null> {
  const salesforce = getSalesforceService();
  if (!salesforce.describeLossReasons) return null;

  try {
    const { options, refusal } = await salesforce.describeLossReasons();
    if (!refusal) return { ok: true, count: options.length };
    return {
      ok: false,
      refusal,
      detail: LOSS_REASON_REFUSAL_DETAIL[refusal],
      remedy: REMEDY[refusal],
    };
  } catch {
    // A transport failure is transient and already logged by the provider.
    // Reporting it here as a configuration problem would send an administrator
    // to change settings that are not wrong.
    return null;
  }
}
