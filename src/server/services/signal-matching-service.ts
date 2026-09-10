import type { SmartsheetSignal } from "@/server/integrations/smartsheet";

/**
 * Answers one question, in one place: "which opportunity is this Smartsheet
 * signal about?" Pure — no database access, no I/O — so it is fully unit
 * testable and never duplicated in the ingestion service or the UI. Mirrors
 * the shape of recipient-resolution-service.ts.
 *
 * Candidates are whatever the caller already has cached (the existing
 * Opportunity/Account rows from the last Salesforce refresh) — this function
 * never talks to Salesforce or Smartsheet itself.
 */

export const SIGNAL_MATCH_REASONS = {
  /** The signal named a Salesforce Opportunity Id and it exists in the catalog. */
  OPPORTUNITY_ID: "OPPORTUNITY_ID",
  /** Account name and project name both matched one opportunity. */
  ACCOUNT_AND_PROJECT: "ACCOUNT_AND_PROJECT",
  /** Account matched and it has exactly one open opportunity. */
  SOLE_OPEN_OPPORTUNITY: "SOLE_OPEN_OPPORTUNITY",
  /** Account matched but has several open opportunities and no project name narrowed it. */
  MULTIPLE_OPEN_OPPORTUNITIES: "MULTIPLE_OPEN_OPPORTUNITIES",
  /** The signal's account name doesn't match anything IDS has on file. */
  UNKNOWN_ACCOUNT: "UNKNOWN_ACCOUNT",
  /** The signal carried no usable identifying information at all. */
  NO_IDENTIFYING_INFO: "NO_IDENTIFYING_INFO",
} as const;

export type SignalMatchReason = (typeof SIGNAL_MATCH_REASONS)[keyof typeof SIGNAL_MATCH_REASONS];

export const SIGNAL_MATCH_REASON_LABELS: Record<SignalMatchReason, string> = {
  OPPORTUNITY_ID: "Matched by Salesforce Opportunity Id on the row",
  ACCOUNT_AND_PROJECT: "Matched by account and project name",
  SOLE_OPEN_OPPORTUNITY: "Only open opportunity at this account",
  MULTIPLE_OPEN_OPPORTUNITIES: "Multiple open opportunities at this account — project name didn't narrow it down",
  UNKNOWN_ACCOUNT: "Account name on the signal isn't in the catalog",
  NO_IDENTIFYING_INFO: "Signal carried no account or opportunity reference",
};

/** The subset of a cached Opportunity this function needs to consider. */
export type OpportunityCandidate = {
  id: string;
  externalId: string;
  accountId: string;
  accountName: string;
  opportunityName: string;
  projectName: string | null;
  customerName: string;
};

export type SignalMatchResult =
  | {
      status: "MATCHED";
      reason: SignalMatchReason;
      opportunityId: string;
      accountId: string;
    }
  | {
      status: "AMBIGUOUS";
      reason: SignalMatchReason;
      accountId: string;
      /** Every open opportunity at the account, so a PM can pick manually. */
      candidateOpportunityIds: string[];
    }
  | {
      status: "UNMATCHED";
      reason: SignalMatchReason;
    };

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** Resolve one signal against the currently cached opportunity catalog. */
export function matchSignalToOpportunity(
  signal: SmartsheetSignal,
  candidates: OpportunityCandidate[],
): SignalMatchResult {
  // 1. An explicit Opportunity Id is the strongest possible signal — the
  //    sheet is naming a specific Salesforce record, not describing one.
  if (signal.relatedOpportunityExternalId) {
    const byId = candidates.find(
      (candidate) => candidate.externalId === signal.relatedOpportunityExternalId,
    );
    if (byId) {
      return {
        status: "MATCHED",
        reason: SIGNAL_MATCH_REASONS.OPPORTUNITY_ID,
        opportunityId: byId.id,
        accountId: byId.accountId,
      };
    }
    // The id didn't resolve (closed, deleted, or from a different org) — fall
    // through to the account/project rules rather than giving up immediately.
  }

  if (!signal.relatedAccountName) {
    return { status: "UNMATCHED", reason: SIGNAL_MATCH_REASONS.NO_IDENTIFYING_INFO };
  }

  const accountMatches = candidates.filter(
    (candidate) => normalize(candidate.accountName) === normalize(signal.relatedAccountName!),
  );
  if (accountMatches.length === 0) {
    return { status: "UNMATCHED", reason: SIGNAL_MATCH_REASONS.UNKNOWN_ACCOUNT };
  }

  // 2. Account + project name together should isolate exactly one opportunity.
  if (signal.relatedProjectName) {
    const project = normalize(signal.relatedProjectName);
    const projectMatch = accountMatches.find(
      (candidate) =>
        normalize(candidate.opportunityName) === project ||
        (candidate.projectName && normalize(candidate.projectName) === project) ||
        normalize(candidate.opportunityName).includes(project) ||
        project.includes(normalize(candidate.opportunityName)),
    );
    if (projectMatch) {
      return {
        status: "MATCHED",
        reason: SIGNAL_MATCH_REASONS.ACCOUNT_AND_PROJECT,
        opportunityId: projectMatch.id,
        accountId: projectMatch.accountId,
      };
    }
  }

  // 3. No project name, or it didn't match anything — if the account has only
  //    one open opportunity, that's unambiguous even without a project name.
  if (accountMatches.length === 1) {
    return {
      status: "MATCHED",
      reason: SIGNAL_MATCH_REASONS.SOLE_OPEN_OPPORTUNITY,
      opportunityId: accountMatches[0].id,
      accountId: accountMatches[0].accountId,
    };
  }

  // 4. Several candidates and nothing to disambiguate them — flag for a human
  //    rather than guess which project the signal actually meant.
  return {
    status: "AMBIGUOUS",
    reason: SIGNAL_MATCH_REASONS.MULTIPLE_OPEN_OPPORTUNITIES,
    accountId: accountMatches[0].accountId,
    candidateOpportunityIds: accountMatches.map((candidate) => candidate.id),
  };
}
