/**
 * Controlled organization types. `salesforceValue` is the Account.Type picklist
 * value in the org — keep this map in sync rather than scattering literals.
 */
export const ACCOUNT_TYPES = [
  { value: "AGENCY", label: "Agency", pluralLabel: "Agencies", salesforceValue: "Agency" },
  { value: "DISTRIBUTOR", label: "Distributor", pluralLabel: "Distributors", salesforceValue: "Distributor" },
  { value: "DIRECT_CLIENT", label: "Direct Client", pluralLabel: "Direct clients", salesforceValue: "Direct Client" },
  { value: "OTHER", label: "Other", pluralLabel: "Other", salesforceValue: "Other" },
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number]["value"];

const BY_VALUE = new Map(ACCOUNT_TYPES.map((type) => [type.value, type]));
const BY_SALESFORCE_VALUE = new Map(
  ACCOUNT_TYPES.map((type) => [type.salesforceValue.toLowerCase(), type]),
);

export function accountTypePluralLabel(value: string | null | undefined, count: number): string {
  const type = BY_VALUE.get(value as AccountType);
  if (!type) return "organizations";
  return count === 1 ? type.label : type.pluralLabel;
}

export function accountTypeLabel(value: string | null | undefined): string {
  if (!value) return "Other";
  return BY_VALUE.get(value as AccountType)?.label ?? value;
}

/** Unknown Salesforce values fall back to OTHER rather than being dropped. */
export function accountTypeFromSalesforce(salesforceValue: string | null | undefined): AccountType {
  if (!salesforceValue) return "OTHER";
  return BY_SALESFORCE_VALUE.get(salesforceValue.trim().toLowerCase())?.value ?? "OTHER";
}
