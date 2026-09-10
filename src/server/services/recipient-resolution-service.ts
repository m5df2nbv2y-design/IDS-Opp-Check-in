import type { SalesforceContact, SalesforceOpportunity } from "@/server/integrations/salesforce";

/**
 * THE CANONICAL RECIPIENT-RESOLUTION RULE.
 *
 *   Opportunity → Primary Opportunity Contact Role → Contact → Email
 *
 * IDS deliberately maintains a primary contact role on each Opportunity, and
 * that person is who the check-in is for. This service therefore does exactly
 * one thing and never improvises:
 *
 *   1. `OpportunityContactRole.IsPrimary = true` identifies the recipient.
 *   2. That contact has an email        → RESOLVED.
 *   3. That contact has no email        → UNRESOLVED, needs attention.
 *   4. No primary contact role          → UNRESOLVED, needs attention.
 *
 * Explicitly NOT done, by business decision:
 *   - No fallback to other contacts on the Account.
 *   - No selection based on Contact_Type__c.
 *   - No substituting a different person, ever.
 *   - No collapsing of duplicate contact records — a different record is a
 *     different person as far as this service is concerned.
 *
 * An earlier version cascaded through Account contacts. Measured against the
 * real org that reached ~80% coverage versus ~78% for the primary role alone,
 * but the extra 2% was guesswork: it emailed whoever happened to be attached
 * to the account. Being right matters more than being resolved, so an
 * opportunity we cannot route confidently is surfaced for a human instead.
 *
 * Pure functions — no database, no I/O — so every branch is directly testable.
 */

export const RESOLUTION_REASONS = {
  /** Resolved: the primary contact role's contact has an email address. */
  PRIMARY_CONTACT_ROLE: "PRIMARY_CONTACT_ROLE",
  /** No primary contact role is set on the opportunity. */
  NO_PRIMARY_CONTACT_ROLE: "NO_PRIMARY_CONTACT_ROLE",
  /** A primary contact role exists, but that contact has no email address. */
  PRIMARY_CONTACT_NO_EMAIL: "PRIMARY_CONTACT_NO_EMAIL",
  /** The role points at a contact that is not in the catalog (deleted, or not visible). */
  PRIMARY_CONTACT_NOT_FOUND: "PRIMARY_CONTACT_NOT_FOUND",
} as const;

export type ResolutionReason = (typeof RESOLUTION_REASONS)[keyof typeof RESOLUTION_REASONS];

export const RESOLUTION_REASON_LABELS: Record<ResolutionReason, string> = {
  PRIMARY_CONTACT_ROLE: "Primary contact role on the opportunity",
  NO_PRIMARY_CONTACT_ROLE: "No primary contact role set on the opportunity",
  PRIMARY_CONTACT_NO_EMAIL: "Primary contact has no email address",
  PRIMARY_CONTACT_NOT_FOUND: "Primary contact record could not be found",
};

export type Resolution =
  | {
      status: "RESOLVED";
      contactExternalId: string;
      reason: typeof RESOLUTION_REASONS.PRIMARY_CONTACT_ROLE;
    }
  | {
      status: "UNRESOLVED";
      reason: ResolutionReason;
      /** Plain-English explanation for the admin "needs attention" list. */
      warning: string;
    };

/** Resolve one opportunity to its intended recipient. */
export function resolveRecipient(input: {
  opportunity: SalesforceOpportunity;
  /** Contacts keyed by Salesforce Contact Id. Must include contacts with no
   *  email, so "no email" can be distinguished from "not found". */
  contactsById: Map<string, SalesforceContact>;
}): Resolution {
  const { opportunity, contactsById } = input;

  if (!opportunity.primaryContactExternalId) {
    return {
      status: "UNRESOLVED",
      reason: RESOLUTION_REASONS.NO_PRIMARY_CONTACT_ROLE,
      warning: "This opportunity has no primary contact role in Salesforce, so there is nobody to ask.",
    };
  }

  const contact = contactsById.get(opportunity.primaryContactExternalId);
  if (!contact) {
    return {
      status: "UNRESOLVED",
      reason: RESOLUTION_REASONS.PRIMARY_CONTACT_NOT_FOUND,
      warning: `The primary contact role points at contact ${opportunity.primaryContactExternalId}, which could not be read.`,
    };
  }

  if (!contact.email?.trim()) {
    return {
      status: "UNRESOLVED",
      reason: RESOLUTION_REASONS.PRIMARY_CONTACT_NO_EMAIL,
      warning: `${contact.name} is the primary contact but has no email address in Salesforce.`,
    };
  }

  return {
    status: "RESOLVED",
    contactExternalId: contact.externalId,
    reason: RESOLUTION_REASONS.PRIMARY_CONTACT_ROLE,
  };
}

export type ResolvedOpportunity = {
  opportunity: SalesforceOpportunity;
  resolution: Resolution;
};

export type ResolutionSummary = {
  results: ResolvedOpportunity[];
  resolvedCount: number;
  unresolvedCount: number;
  /** Unresolved totals per reason, for reporting. */
  unresolvedByReason: Record<ResolutionReason, number>;
  /** Distinct contacts that would receive an email. */
  recipientExternalIds: string[];
};

/** Resolve a whole campaign's worth of opportunities in one pass. */
export function resolveRecipients(input: {
  opportunities: SalesforceOpportunity[];
  contacts: SalesforceContact[];
}): ResolutionSummary {
  const contactsById = new Map(input.contacts.map((contact) => [contact.externalId, contact]));

  const results = input.opportunities.map((opportunity) => ({
    opportunity,
    resolution: resolveRecipient({ opportunity, contactsById }),
  }));

  const unresolvedByReason = {
    PRIMARY_CONTACT_ROLE: 0,
    NO_PRIMARY_CONTACT_ROLE: 0,
    PRIMARY_CONTACT_NO_EMAIL: 0,
    PRIMARY_CONTACT_NOT_FOUND: 0,
  } as Record<ResolutionReason, number>;

  for (const { resolution } of results) {
    if (resolution.status === "UNRESOLVED") unresolvedByReason[resolution.reason] += 1;
  }

  const recipientExternalIds = [
    ...new Set(
      results.flatMap((result) =>
        result.resolution.status === "RESOLVED" ? [result.resolution.contactExternalId] : [],
      ),
    ),
  ];

  return {
    results,
    resolvedCount: results.filter((r) => r.resolution.status === "RESOLVED").length,
    unresolvedCount: results.filter((r) => r.resolution.status === "UNRESOLVED").length,
    unresolvedByReason,
    recipientExternalIds,
  };
}
