import type { AccountType } from "@/lib/account-types";
import type { OpportunityStage } from "@/lib/stages";

/**
 * The contract between IDS Opportunity Check-In and Salesforce/SFX.
 *
 * The rest of the application only ever talks to `SalesforceService`. Swapping
 * the mock provider for the real one is a factory change (see ./index.ts) — no
 * UI, service, or database code changes.
 *
 * Salesforce → IDS mapping:
 *   Account      → Organization (agency / distributor / direct client)
 *   Contact      → External contact (the check-in recipient)
 *   User         → Internal IDS sales rep
 *   Opportunity  → Opportunity
 */

/** Internal IDS employee. Never a recipient. */
export type SalesforceRep = {
  externalId: string;
  name: string;
  email: string;
  active: boolean;
};

/** External organization. */
export type SalesforceAccount = {
  externalId: string;
  name: string;
  type: AccountType;
  active: boolean;
};

/** A person at an external organization — the check-in recipient. */
export type SalesforceContact = {
  externalId: string;
  accountExternalId: string;
  name: string;
  email: string;
  /** The account's designated check-in contact, when the org marks one. */
  isPrimary: boolean;
  active: boolean;
};

export type SalesforceOpportunity = {
  externalId: string;
  /** Salesforce Opportunity.Name. */
  opportunityName: string;
  /** The project, when captured separately from the opportunity name. */
  projectName: string | null;
  /** End customer / project site shown to the recipient. */
  customerName: string;
  amount: number;
  stage: OpportunityStage;
  closeDate: Date | null;
  url: string;
  /** OwnerId — the internal IDS rep. */
  ownerExternalId: string;
  /** Standard Opportunity.AccountId. IDS has no separate partner account. */
  accountExternalId: string;
  /**
   * The contact on the opportunity's PRIMARY OpportunityContactRole — the
   * confirmed check-in recipient. Null when no primary role is set, which
   * makes the opportunity unresolved; there is deliberately no fallback.
   * See services/recipient-resolution-service.ts.
   */
  primaryContactExternalId: string | null;
};

export type OpportunityStatusUpdate = {
  externalId: string;
  stage: OpportunityStage;
  comment?: string | null;
  /** Context written alongside the note, e.g. "Fall 2026 Check-In". */
  source?: string;
};

export type SalesforceProviderInfo = {
  id: string;
  label: string;
  simulated: boolean;
  description: string;
};

export interface SalesforceService {
  readonly info: SalesforceProviderInfo;

  /** Internal IDS employees who can own opportunities. */
  getSalesReps(): Promise<SalesforceRep[]>;

  /** External organizations. */
  getAccounts(): Promise<SalesforceAccount[]>;

  /** External people, optionally limited to specific accounts. */
  getExternalContacts(options?: { accountExternalIds?: string[] }): Promise<SalesforceContact[]>;

  /** All open (not Closed Won / Closed Lost) opportunities. */
  getOpenOpportunities(options?: { ownerExternalIds?: string[] }): Promise<SalesforceOpportunity[]>;

  getOpportunity(externalId: string): Promise<SalesforceOpportunity | null>;

  /** Push a stage change. Throws SalesforceSyncError when the org rejects it. */
  updateOpportunityStatus(externalId: string, stage: OpportunityStage): Promise<void>;

  /** Push a recipient note. Throws SalesforceSyncError when the org rejects it. */
  updateOpportunityComment(externalId: string, comment: string, source?: string): Promise<void>;

  /** Convenience: stage + comment as a single logical write. */
  applyUpdate(update: OpportunityStatusUpdate): Promise<void>;
}

/** Error type every provider throws for org-side rejections. */
export class SalesforceSyncError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options?: { code?: string; retryable?: boolean }) {
    super(message);
    this.name = "SalesforceSyncError";
    this.code = options?.code ?? "UNKNOWN_ERROR";
    this.retryable = options?.retryable ?? true;
  }
}
