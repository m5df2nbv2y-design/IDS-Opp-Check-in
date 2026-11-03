import { describe, expect, it } from "vitest";
import {
  diagnoseLossReasonDescribe,
  LOSS_REASON_REFUSAL_DETAIL,
  lossReasonOptionsFromDescribe,
} from "@/lib/client-response";

/**
 * Reading the Closed Lost choices from the org instead of hardcoding them.
 *
 * These choices have already been changed once in Salesforce. Reading them
 * live is what stops the next change from silently putting the application out
 * of step with the CRM — but only if the refusal cases are visible, because an
 * empty list is not a harmless outcome: with no options every Closed Lost
 * answer is rejected as INVALID_LOSS_REASON and the recipient cannot finish.
 */

/** The field as it stands in the IDS org, per the Salesforce setup screen. */
const IDS_FIELD = {
  label: "Loss Reason",
  type: "picklist",
  picklistValues: [
    { active: true, value: "Lost to Competitor", label: "Lost to Competitor" },
    { active: true, value: "Reduced Scope", label: "Reduced Scope" },
    { active: true, value: "Project Delayed Indefinitely", label: "Project Delayed Indefinitely" },
  ],
};

describe("the IDS org's current choices", () => {
  it("reads all three, carrying value and label separately", () => {
    const { options, refusal } = diagnoseLossReasonDescribe({ fields: [IDS_FIELD] });

    expect(refusal).toBeNull();
    expect(options).toEqual([
      { value: "Lost to Competitor", label: "Lost to Competitor" },
      { value: "Reduced Scope", label: "Reduced Scope" },
      { value: "Project Delayed Indefinitely", label: "Project Delayed Indefinitely" },
    ]);
  });

  it("keeps value and label distinct when the org makes them differ", () => {
    // A screenshot only ever shows labels. The VALUE is what a write puts into
    // Salesforce, so the two must not be collapsed — copying labels across
    // would write something the org does not recognise.
    const { options } = diagnoseLossReasonDescribe({
      fields: [{
        label: "Loss Reason",
        type: "picklist",
        picklistValues: [{ active: true, value: "LOST_COMPETITOR", label: "Lost to Competitor" }],
      }],
    });
    expect(options).toEqual([{ value: "LOST_COMPETITOR", label: "Lost to Competitor" }]);
  });

  it("drops inactive values rather than offering a retired choice", () => {
    const { options } = diagnoseLossReasonDescribe({
      fields: [{
        ...IDS_FIELD,
        picklistValues: [
          ...IDS_FIELD.picklistValues,
          { active: false, value: "Budget Cut", label: "Budget Cut" },
        ],
      }],
    });
    expect(options.map((o) => o.value)).not.toContain("Budget Cut");
    expect(options).toHaveLength(3);
  });
});

describe("every refusal says why", () => {
  const cases = [
    {
      name: "no field carries the label",
      metadata: { fields: [{ label: "Reason Lost", type: "picklist", picklistValues: [] }] },
      refusal: "FIELD_NOT_FOUND" as const,
    },
    {
      name: "two fields share the label",
      metadata: { fields: [IDS_FIELD, IDS_FIELD] },
      refusal: "AMBIGUOUS_FIELD_LABEL" as const,
    },
    {
      name: "the field is not a picklist",
      metadata: { fields: [{ ...IDS_FIELD, type: "string" }] },
      refusal: "NOT_A_PICKLIST" as const,
    },
    {
      name: "the picklist depends on a controlling field",
      metadata: { fields: [{ ...IDS_FIELD, dependentPicklist: true }] },
      refusal: "DEPENDENT_PICKLIST" as const,
    },
    {
      name: "record types are in use",
      metadata: { fields: [IDS_FIELD], recordTypeInfos: [{ available: true, master: false }] },
      refusal: "RECORD_TYPE_SCOPED" as const,
    },
    {
      name: "every value is inactive",
      metadata: {
        fields: [{ ...IDS_FIELD, picklistValues: [{ active: false, value: "X", label: "X" }] }],
      },
      refusal: "NO_ACTIVE_VALUES" as const,
    },
  ];

  for (const { name, metadata, refusal } of cases) {
    it(`names the reason when ${name}`, () => {
      const result = diagnoseLossReasonDescribe(metadata);
      expect(result.refusal).toBe(refusal);
      expect(result.options).toEqual([]);
      // The detail is what makes the refusal actionable rather than puzzling.
      expect(LOSS_REASON_REFUSAL_DETAIL[refusal]).toBeTruthy();
    });
  }

  it("matches on LABEL, not API name — the trap worth pinning", () => {
    // A field whose API name is Loss_Reason__c but whose label was renamed
    // will NOT be found. Recording this because it is the most likely cause
    // of an unexplained empty dropdown after someone edits the field.
    const { refusal } = diagnoseLossReasonDescribe({
      fields: [{ label: "Loss Reason (Updated)", type: "picklist", picklistValues: IDS_FIELD.picklistValues }],
    });
    expect(refusal).toBe("FIELD_NOT_FOUND");
  });
});

describe("the strict mapper still behaves exactly as before", () => {
  it("agrees with the diagnostic one on what is allowed", () => {
    for (const metadata of [
      { fields: [IDS_FIELD] },
      { fields: [IDS_FIELD, IDS_FIELD] },
      { fields: [{ ...IDS_FIELD, dependentPicklist: true }] },
      { fields: [IDS_FIELD], recordTypeInfos: [{ available: true, master: false }] },
      { fields: [] },
    ]) {
      expect(lossReasonOptionsFromDescribe(metadata)).toEqual(
        diagnoseLossReasonDescribe(metadata).options,
      );
    }
  });

  it("still allows a master-only record type setup", () => {
    const { options, refusal } = diagnoseLossReasonDescribe({
      fields: [IDS_FIELD],
      recordTypeInfos: [{ available: true, master: true }],
    });
    expect(refusal).toBeNull();
    expect(options).toHaveLength(3);
  });
});
