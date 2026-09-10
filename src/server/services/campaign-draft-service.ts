import { prisma } from "@/lib/db";
import { deriveSendState, type SendState } from "@/lib/send-states";
import { launchCampaign } from "./campaign-service";
import { currentPeriod } from "./campaign-service";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";

/**
 * The human-in-the-loop selection queue.
 *
 * An admin reviews discovered opportunities and explicitly chooses which ones
 * to contact. Those choices are persisted against a DRAFT campaign so a refresh
 * or navigating away never loses them, and are keyed by OPPORTUNITY — never by
 * account — so "select this account" can only ever be shorthand for the
 * specific opportunities that were on screen at the time.
 *
 * Nothing here sends anything or touches Salesforce.
 */

export type SelectionFilters = {
  /** Free-text across account, opportunity, contact name and contact email. */
  search?: string;
  /** Internal IDS rep id. */
  ownerId?: string;
  /** "all" | "eligible" | "needs_attention" | "selected" */
  status?: string;
};

export type DraftOpportunityRow = {
  id: string;
  opportunityName: string;
  projectName: string | null;
  customerName: string;
  amount: number;
  currentStage: string;
  closeDate: Date | null;
  salesforceUrl: string;
  ownerName: string;
  contactName: string | null;
  contactEmail: string | null;
  resolutionReason: string | null;
  state: SendState;
  selected: boolean;
  selectable: boolean;
};

export type DraftAccountGroup = {
  accountId: string;
  accountName: string;
  accountType: string;
  opportunities: DraftOpportunityRow[];
  selectableCount: number;
  selectedCount: number;
  needsAttentionCount: number;
  /** Three-state checkbox for the account header. */
  checkboxState: "unchecked" | "indeterminate" | "checked";
};

export type DraftSummary = {
  campaignId: string;
  campaignName: string;
  /** Selected opportunities, distinct contacts, distinct accounts. */
  selectedOpportunities: number;
  selectedContacts: number;
  selectedAccounts: number;
};

/**
 * The single open draft. One at a time by design — a second concurrent draft
 * would make "what am I about to send?" ambiguous.
 */
export async function getOrCreateDraft(actor = "admin") {
  const existing = await prisma.campaign.findFirst({
    where: { status: "DRAFT" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  const period = currentPeriod();
  const campaign = await prisma.campaign.create({
    data: { name: `${period} Check-In`, period, status: "DRAFT" },
  });

  await recordAudit({
    type: AUDIT_EVENTS.CAMPAIGN_CREATED,
    summary: `Draft campaign "${campaign.name}" started`,
    actor,
    actorKind: "ADMIN",
    campaignId: campaign.id,
    detail: "Draft only — no recipients and nothing sent.",
  });

  return campaign;
}

/**
 * Account-grouped, filtered view of every open opportunity, annotated with its
 * send state and whether it is currently selected.
 */
export async function listDraftAccounts(
  campaignId: string,
  filters: SelectionFilters = {},
): Promise<DraftAccountGroup[]> {
  const search = filters.search?.trim();

  const opportunities = await prisma.opportunity.findMany({
    where: {
      isOpen: true,
      ...(filters.ownerId ? { internalRepId: filters.ownerId } : {}),
      ...(filters.status === "eligible" ? { resolutionStatus: "RESOLVED" } : {}),
      ...(filters.status === "needs_attention" ? { resolutionStatus: "UNRESOLVED" } : {}),
      ...(filters.status === "selected" ? { selections: { some: { campaignId } } } : {}),
      ...(search
        ? {
            OR: [
              { opportunityName: { contains: search } },
              { customerName: { contains: search } },
              { account: { name: { contains: search } } },
              { contact: { name: { contains: search } } },
              { contact: { email: { contains: search } } },
            ],
          }
        : {}),
    },
    include: {
      account: true,
      internalRep: true,
      contact: true,
      selections: { where: { campaignId }, select: { id: true } },
    },
    orderBy: [{ account: { name: "asc" } }, { opportunityName: "asc" }],
  });

  const groups = new Map<string, DraftAccountGroup>();

  for (const opportunity of opportunities) {
    const resolved = opportunity.resolutionStatus === "RESOLVED" && Boolean(opportunity.contact);
    const selected = opportunity.selections.length > 0;
    const state = deriveSendState({ resolved, selected });

    const row: DraftOpportunityRow = {
      id: opportunity.id,
      opportunityName: opportunity.opportunityName,
      projectName: opportunity.projectName,
      customerName: opportunity.customerName,
      amount: opportunity.amount,
      currentStage: opportunity.currentStage,
      closeDate: opportunity.closeDate,
      salesforceUrl: opportunity.salesforceUrl,
      ownerName: opportunity.internalRep.name,
      contactName: opportunity.contact?.name ?? null,
      contactEmail: opportunity.contact?.email ?? null,
      resolutionReason: opportunity.resolutionReason,
      state,
      selected,
      // NEEDS_ATTENTION rows carry no checkbox at all — there is nobody to send
      // to, so they must be structurally unselectable rather than merely
      // discouraged.
      selectable: resolved,
    };

    const group = groups.get(opportunity.accountId) ?? {
      accountId: opportunity.accountId,
      accountName: opportunity.account.name,
      accountType: opportunity.account.type,
      opportunities: [],
      selectableCount: 0,
      selectedCount: 0,
      needsAttentionCount: 0,
      checkboxState: "unchecked" as const,
    };

    group.opportunities.push(row);
    if (row.selectable) group.selectableCount += 1;
    else group.needsAttentionCount += 1;
    if (row.selected) group.selectedCount += 1;

    groups.set(opportunity.accountId, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      checkboxState:
        group.selectedCount === 0
          ? ("unchecked" as const)
          : group.selectedCount === group.selectableCount
            ? ("checked" as const)
            : ("indeterminate" as const),
    }))
    .sort((a, b) => a.accountName.localeCompare(b.accountName));
}

/** Select or deselect specific opportunities. The only way to become SELECTED. */
export async function setSelection(input: {
  campaignId: string;
  opportunityIds: string[];
  selected: boolean;
  actor?: string;
}): Promise<void> {
  const { campaignId, opportunityIds, selected } = input;
  if (opportunityIds.length === 0) return;

  if (!selected) {
    await prisma.campaignSelection.deleteMany({
      where: { campaignId, opportunityId: { in: opportunityIds } },
    });
    return;
  }

  // Only resolved opportunities may be selected. Enforced here as well as in
  // the UI, so a crafted request cannot queue an unsendable opportunity.
  const selectable = await prisma.opportunity.findMany({
    where: {
      id: { in: opportunityIds },
      isOpen: true,
      resolutionStatus: "RESOLVED",
      contactId: { not: null },
    },
    // Values are frozen onto the selection below, so "what pipeline did we
    // choose to intervene on?" stays exact even after the cache is overwritten.
    select: { id: true, amount: true, currentStage: true, closeDate: true },
  });

  // Skip anything already selected. Selecting a whole account while some of its
  // opportunities are already chosen is the normal indeterminate → checked path,
  // so it must be idempotent rather than a unique-constraint error.
  const alreadySelected = new Set(
    (
      await prisma.campaignSelection.findMany({
        where: { campaignId, opportunityId: { in: selectable.map((o) => o.id) } },
        select: { opportunityId: true },
      })
    ).map((selection) => selection.opportunityId),
  );

  const toCreate = selectable.filter((opportunity) => !alreadySelected.has(opportunity.id));
  if (toCreate.length === 0) return;

  await prisma.campaignSelection.createMany({
    data: toCreate.map((opportunity) => ({
      campaignId,
      opportunityId: opportunity.id,
      selectedBy: input.actor ?? "admin",
      amountAtSelection: opportunity.amount,
      stageAtSelection: opportunity.currentStage,
      closeDateAtSelection: opportunity.closeDate,
    })),
  });
}

export async function clearSelections(campaignId: string): Promise<void> {
  await prisma.campaignSelection.deleteMany({ where: { campaignId } });
}

/** Exactly what would be sent, for the action label and the review screen. */
export async function getDraftSummary(campaignId: string): Promise<DraftSummary> {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });

  const selections = await prisma.campaignSelection.findMany({
    where: { campaignId },
    include: { opportunity: { select: { contactId: true, accountId: true } } },
  });

  return {
    campaignId,
    campaignName: campaign.name,
    selectedOpportunities: selections.length,
    selectedContacts: new Set(selections.map((s) => s.opportunity.contactId)).size,
    selectedAccounts: new Set(selections.map((s) => s.opportunity.accountId)).size,
  };
}

export type ReviewRecipient = {
  contactId: string;
  contactName: string;
  contactEmail: string;
  accountName: string;
  opportunities: { id: string; name: string; stage: string; amount: number }[];
};

/**
 * The final review: grouped by the person who would actually receive an email,
 * because that is the unit of the send — one contact, one message, every
 * opportunity they were selected for.
 */
export async function getReviewRecipients(campaignId: string): Promise<ReviewRecipient[]> {
  const selections = await prisma.campaignSelection.findMany({
    where: { campaignId },
    include: {
      opportunity: { include: { contact: { include: { account: true } } } },
    },
  });

  const byContact = new Map<string, ReviewRecipient>();

  for (const selection of selections) {
    const contact = selection.opportunity.contact;
    if (!contact) continue;

    const entry = byContact.get(contact.id) ?? {
      contactId: contact.id,
      contactName: contact.name,
      contactEmail: contact.email,
      accountName: contact.account.name,
      opportunities: [],
    };
    entry.opportunities.push({
      id: selection.opportunity.id,
      name: selection.opportunity.opportunityName,
      stage: selection.opportunity.currentStage,
      amount: selection.opportunity.amount,
    });
    byContact.set(contact.id, entry);
  }

  return [...byContact.values()].sort((a, b) => a.contactName.localeCompare(b.contactName));
}

// ---------------------------------------------------------------------------
// Selection drift
// ---------------------------------------------------------------------------

/**
 * Salesforce changes between the moment an admin selects an opportunity and the
 * moment they confirm the send. Every selection is therefore re-validated from
 * server state before anything is created — the client's selection is never
 * trusted on its own.
 */
export const DRIFT_REASONS = {
  OPPORTUNITY_CLOSED: "OPPORTUNITY_CLOSED",
  NO_PRIMARY_CONTACT_ROLE: "NO_PRIMARY_CONTACT_ROLE",
  PRIMARY_CONTACT_NO_EMAIL: "PRIMARY_CONTACT_NO_EMAIL",
  PRIMARY_CONTACT_NOT_FOUND: "PRIMARY_CONTACT_NOT_FOUND",
} as const;

export type DriftReason = (typeof DRIFT_REASONS)[keyof typeof DRIFT_REASONS];

export const DRIFT_REASON_LABELS: Record<DriftReason, string> = {
  OPPORTUNITY_CLOSED: "Closed in Salesforce since it was selected",
  NO_PRIMARY_CONTACT_ROLE: "Primary contact role removed since it was selected",
  PRIMARY_CONTACT_NO_EMAIL: "Primary contact no longer has an email address",
  PRIMARY_CONTACT_NOT_FOUND: "Primary contact record can no longer be read",
};

export type DriftedSelection = {
  opportunityId: string;
  opportunityName: string;
  accountName: string;
  reason: DriftReason;
};

export type ValidatedSelection = {
  /** Opportunity ids that still resolve and may be sent. */
  sendableOpportunityIds: string[];
  /** Selections that no longer qualify. Excluded from the send, never sent. */
  drifted: DriftedSelection[];
};

/**
 * Re-resolve every selected opportunity from current server state.
 *
 * The Primary Opportunity Contact Role remains authoritative and there is no
 * fallback: anything that has become unresolved since selection is excluded and
 * reported, never quietly substituted with another contact.
 */
export async function validateSelection(campaignId: string): Promise<ValidatedSelection> {
  const selections = await prisma.campaignSelection.findMany({
    where: { campaignId },
    include: { opportunity: { include: { contact: true, account: true } } },
  });

  const sendableOpportunityIds: string[] = [];
  const drifted: DriftedSelection[] = [];

  for (const selection of selections) {
    const opportunity = selection.opportunity;
    const base = {
      opportunityId: opportunity.id,
      opportunityName: opportunity.opportunityName,
      accountName: opportunity.account.name,
    };

    if (!opportunity.isOpen) {
      drifted.push({ ...base, reason: DRIFT_REASONS.OPPORTUNITY_CLOSED });
      continue;
    }
    if (opportunity.resolutionStatus !== "RESOLVED" || !opportunity.contactId) {
      const reason =
        opportunity.resolutionReason === DRIFT_REASONS.PRIMARY_CONTACT_NO_EMAIL
          ? DRIFT_REASONS.PRIMARY_CONTACT_NO_EMAIL
          : opportunity.resolutionReason === DRIFT_REASONS.PRIMARY_CONTACT_NOT_FOUND
            ? DRIFT_REASONS.PRIMARY_CONTACT_NOT_FOUND
            : DRIFT_REASONS.NO_PRIMARY_CONTACT_ROLE;
      drifted.push({ ...base, reason });
      continue;
    }
    if (!opportunity.contact) {
      drifted.push({ ...base, reason: DRIFT_REASONS.PRIMARY_CONTACT_NOT_FOUND });
      continue;
    }
    if (!opportunity.contact.email?.trim()) {
      drifted.push({ ...base, reason: DRIFT_REASONS.PRIMARY_CONTACT_NO_EMAIL });
      continue;
    }

    sendableOpportunityIds.push(opportunity.id);
  }

  return { sendableOpportunityIds, drifted };
}

export type SendDraftResult = {
  campaignId: string;
  sent: number;
  recipients: number;
  emailsFailed: number;
  drifted: DriftedSelection[];
};

/**
 * Convert the draft into a real campaign and send to the selected recipients.
 *
 * The client's selection is never trusted: every selection is re-resolved from
 * server state first, and anything that drifted is excluded and reported rather
 * than sent. With EMAIL_PROVIDER=mock the messages land in the in-app outbox.
 * Salesforce is not touched — no stage or close date is written here.
 */
export async function sendDraft(campaignId: string, actor = "admin"): Promise<SendDraftResult> {
  const { sendableOpportunityIds, drifted } = await validateSelection(campaignId);

  if (sendableOpportunityIds.length === 0) {
    return { campaignId, sent: 0, recipients: 0, emailsFailed: 0, drifted };
  }

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const result = await launchCampaign({
    campaignId,
    name: campaign.name,
    period: campaign.period,
    actor,
    opportunityIds: sendableOpportunityIds,
  });

  if (drifted.length > 0) {
    await recordAudit({
      type: AUDIT_EVENTS.CAMPAIGN_CREATED,
      summary: `${drifted.length} selected ${drifted.length === 1 ? "opportunity was" : "opportunities were"} excluded at send — no longer resolvable`,
      actor,
      actorKind: "ADMIN",
      campaignId,
      detail: drifted
        .map((entry) => `${entry.accountName} — ${entry.opportunityName}: ${DRIFT_REASON_LABELS[entry.reason]}`)
        .join("; "),
    });
  }

  return {
    campaignId,
    sent: result.opportunities,
    recipients: result.recipients,
    emailsFailed: result.emailsFailed,
    drifted,
  };
}

/** Owners with open opportunities — populates the owner filter. */
export async function listOwnersWithOpenOpportunities() {
  const reps = await prisma.salesRep.findMany({
    where: { opportunities: { some: { isOpen: true } } },
    orderBy: { name: "asc" },
    include: { _count: { select: { opportunities: { where: { isOpen: true } } } } },
  });
  return reps.map((rep) => ({ id: rep.id, name: rep.name, count: rep._count.opportunities }));
}
