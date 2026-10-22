import { describe, expect, it } from "vitest";
import { lossReasonOptionsFromDescribe, validResponseDate, WIN_PROBABILITIES } from "@/lib/client-response";

describe("client response rules", () => {
  it("keeps the requested probabilities mapped to the existing Salesforce stages", () => {
    expect(WIN_PROBABILITIES).toEqual([
      { stage: "QUALIFICATION", label: "10%" }, { stage: "PROPOSAL", label: "50%" },
      { stage: "SPECIFIED", label: "75%" }, { stage: "NEGOTIATION", label: "90%" },
    ]);
  });
  it("rejects impossible dates instead of allowing Date to roll them forward", () => {
    expect(validResponseDate("2026-02-30")).toBe(false);
    expect(validResponseDate("2026-13-01")).toBe(false);
    expect(validResponseDate("2028-02-29")).toBe(true);
    expect(validResponseDate(42)).toBe(false);
  });
  const field = { label: "Loss Reason", type: "picklist", picklistValues: [
    { active: true, value: "LOST_PRICE", label: "Price" },
    { active: false, value: "OLD", label: "Old reason" },
  ] };
  it("uses active Salesforce API values and display labels", () => {
    expect(lossReasonOptionsFromDescribe({ fields: [field] })).toEqual([{ value: "LOST_PRICE", label: "Price" }]);
  });
  it("refuses ambiguous, dependent, and record-type-scoped options", () => {
    expect(lossReasonOptionsFromDescribe({ fields: [field, field] })).toEqual([]);
    expect(lossReasonOptionsFromDescribe({ fields: [{ ...field, dependentPicklist: true }] })).toEqual([]);
    expect(lossReasonOptionsFromDescribe({ fields: [field], recordTypeInfos: [{ available: true, master: false }] })).toEqual([]);
    expect(lossReasonOptionsFromDescribe({ fields: [] })).toEqual([]);
  });
});
