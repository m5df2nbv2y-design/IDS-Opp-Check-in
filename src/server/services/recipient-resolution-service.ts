import type {
  SalesforceAccount,
  SalesforceContact,
  SalesforceOpportunity,
} from "@/server/integrations/salesforce";

/**
 * Answers one question, in one place:
 *
 *   "Who should receive the check-in for this opportunity?"
 *
 * This is the biggest real-world dependency in the product — Salesforce contact
 * data is never as tidy as the model suggests — so the logic is deliberately
 * pure, exhaustively enumerated, and never duplicated in the UI or the campaign
 * service. Everything here is a pure function of the records passed in, which
 * makes every branch directly testable.
 *
 * See RECIPIENT-RESOLUTION.md for the rules in prose.
 */

export const RESOLUTION_REASONS = {
  /** A contact is named on the opportunity itself (contact role / lookup). */
  OPPORTUNITY_CONTACT: "OPPORTUNITY_CONTACT",
  /** The account's flagged primary check-in contact. */
  ACCOUNT_PRIMARY: "ACCOUNT_PRIMARY",
  /** The account has exactly one active contact. */
  ONLY_ACTIVE_CONTACT: "ONLY_ACTIVE_CONTACT",
  /** Several active contacts, none flagged primary — deterministic pick. */
  AMBIGUOUS_ACTIVE_CONTACTS: "AMBIGUOUS_ACTIVE_CONTACTS",

  /** The opportunity has no partner account at all. */
  NO_ACCOUNT: "NO_ACCOUNT",
  /** The account exists but has no contact records. */
  NO_CONTACTS: "NO_CONTACTS",
  /** The account has contacts, but every one of them is inactive. */
  ALL_CONTACTS_INACTIVE: "ALL_CONTACTS_INACTIVE",
} as const;

export type ResolutionReason = (typeof RESOLUTION_REASONS)[keyof typeof RESOLUTION_REASONS];

export const RESOLUTION_REASON_LABELS: Record<ResolutionReason, string> = {
  OPPORTUNITY_CONTACT: "Named on the opportunity",
  ACCOUNT_PRIMARY: "Account's primary contact",
  ONLY_ACTIVE_CONTACT: "Only active contact at the account",
  AMBIGUOUS_ACTIVE_CONTACTS: "Several active contacts, none marked primary",
  NO_ACCOUNT: "Opportunity has no partner account",
  NO_CONTACTS: "Account has no contacts",
  ALL_CONTACTS_INACTIVE: "Every contact at the account is inactive",
};

export type Resolution =
  | {
      status: "RESOLVED";
      contactExternalId: string;
      reason: ResolutionReason;
      /** Set when resolution succeeded but a human should still glance at it. */
      warning?: string;
    }
  | {
      status: "UNRESOLVED";
      reason: ResolutionReason;
      /** Plain-English explanation shown on the admin "needs attention" list. */
      warning: string;
    };

/**
 * Salesforce routinely holds several Contact records for one human. Collapse
 * them per account by normalized email so nobody is emailed twice, preferring
 * the record most likely to be the real one.
 */
export function dedupeContacts(contacts: SalesforceContact[]): {
  canonical: SalesforceContact[];
  /** Every duplicate external id → the canonical external id it maps onto. */
  aliases: Map<string, string>;
} {
  const groups = new Map<string, SalesforceContact[]>();
  for (const contact of contacts) {
    const key = `${contact.accountExternalId}::${contact.email.trim().toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(contact);
    else groups.set(key, [contact]);
  }

  const canonical: SalesforceContact[] = [];
  const aliases = new Map<string, string>();

  for (const group of groups.values()) {
    const winner = [...group].sort(rankContact)[0];
    canonical.push(winner);
    for (const contact of group) {
      if (contact.externalId !== winner.externalId) aliases.set(contact.externalId, winner.externalId);
    }
  }

  return { canonical, aliases };
}

/** Active beats inactive, primary beats not, then oldest id wins — stable. */
function rankContact(a: SalesforceContact, b: SalesforceContact): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
  return a.externalId.localeCompare(b.externalId);
}

export type ResolutionInput = {
  opportunity: SalesforceOpportunity;
  account: SalesforceAccount | undefined;
  /** Deduped contacts belonging to that account. */
  accountContacts: SalesforceContact[];
  /** Duplicate → canonical map from `dedupeContacts`. */
  aliases: Map<string, string>;
};

/**
 * Resolve one opportunity to one recipient.
 *
 * Order of preference:
 *   1. The contact named on the opportunity, if active.
 *   2. The account's flagged primary contact, if active.
 *   3. The account's only active contact.
 *   4. Several active contacts and no primary — take the first deterministically
 *      and warn, because guessing beats dropping the opportunity.
 *
 * If none of those yield an active contact the opportunity is UNRESOLVED and
 * goes to the admin "needs attention" list. It is never silently dropped.
 */
export function resolveRecipient(input: ResolutionInput): Resolution {
  const { opportunity, account, accountContacts, aliases } = input;

  if (!account || !opportunity.accountExternalId) {
    return {
      status: "UNRESOLVED",
      reason: RESOLUTION_REASONS.NO_ACCOUNT,
      warning: "This opportunity is not linked to a partner organization in Salesforce.",
    };
  }

  const active = accountContacts.filter((contact) => contact.active);

  // 1. A contact named on the opportunity wins, after mapping any duplicate
  //    record onto its canonical one.
  if (opportunity.contactExternalId) {
    const namedId = aliases.get(opportunity.contactExternalId) ?? opportunity.contactExternalId;
    const named = accountContacts.find((contact) => contact.externalId === namedId);

    if (named?.active) {
      return {
        status: "RESOLVED",
        contactExternalId: named.externalId,
        reason: RESOLUTION_REASONS.OPPORTUNITY_CONTACT,
      };
    }
    // Named but unusable — fall through to the account, and say why.
    if (named && !named.active) {
      const fallback = pickFromAccount(active);
      if (fallback) {
        return {
          status: "RESOLVED",
          contactExternalId: fallback.contact.externalId,
          reason: fallback.reason,
          warning: `${named.name} is named on this opportunity but is no longer active; sent to ${fallback.contact.name} instead.`,
        };
      }
    }
  }

  if (active.length === 0) {
    return accountContacts.length === 0
      ? {
          status: "UNRESOLVED",
          reason: RESOLUTION_REASONS.NO_CONTACTS,
          warning: `${account.name} has no contact records in Salesforce.`,
        }
      : {
          status: "UNRESOLVED",
          reason: RESOLUTION_REASONS.ALL_CONTACTS_INACTIVE,
          warning: `Every contact at ${account.name} is marked inactive.`,
        };
  }

  const picked = pickFromAccount(active)!;
  return {
    status: "RESOLVED",
    contactExternalId: picked.contact.externalId,
    reason: picked.reason,
    warning:
      picked.reason === RESOLUTION_REASONS.AMBIGUOUS_ACTIVE_CONTACTS
        ? `${account.name} has ${active.length} active contacts and none is marked primary; defaulted to ${picked.contact.name}.`
        : undefined,
  };
}

function pickFromAccount(
  active: SalesforceContact[],
): { contact: SalesforceContact; reason: ResolutionReason } | null {
  if (active.length === 0) return null;

  const primary = active.filter((contact) => contact.isPrimary).sort(rankContact)[0];
  if (primary) return { contact: primary, reason: RESOLUTION_REASONS.ACCOUNT_PRIMARY };

  if (active.length === 1) {
    return { contact: active[0], reason: RESOLUTION_REASONS.ONLY_ACTIVE_CONTACT };
  }

  return {
    contact: [...active].sort(rankContact)[0],
    reason: RESOLUTION_REASONS.AMBIGUOUS_ACTIVE_CONTACTS,
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
  /** Canonical contacts that will actually receive an email. */
  recipientExternalIds: string[];
  /** Duplicate contact records collapsed away. */
  duplicatesCollapsed: number;
};

/** Resolve a whole campaign's worth of opportunities in one pass. */
export function resolveRecipients(input: {
  opportunities: SalesforceOpportunity[];
  accounts: SalesforceAccount[];
  contacts: SalesforceContact[];
}): ResolutionSummary {
  const { canonical, aliases } = dedupeContacts(input.contacts);

  const accountsById = new Map(input.accounts.map((account) => [account.externalId, account]));
  const contactsByAccount = new Map<string, SalesforceContact[]>();
  for (const contact of canonical) {
    const list = contactsByAccount.get(contact.accountExternalId);
    if (list) list.push(contact);
    else contactsByAccount.set(contact.accountExternalId, [contact]);
  }

  const results = input.opportunities.map((opportunity) => ({
    opportunity,
    resolution: resolveRecipient({
      opportunity,
      account: accountsById.get(opportunity.accountExternalId),
      accountContacts: contactsByAccount.get(opportunity.accountExternalId) ?? [],
      aliases,
    }),
  }));

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
    recipientExternalIds,
    duplicatesCollapsed: aliases.size,
  };
}
