import { prisma } from "@/lib/db";
import { deriveSendState, type SendState } from "@/lib/send-states";
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
    select: { id: true },
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

/** Owners with open opportunities — populates the owner filter. */
export async function listOwnersWithOpenOpportunities() {
  const reps = await prisma.salesRep.findMany({
    where: { opportunities: { some: { isOpen: true } } },
    orderBy: { name: "asc" },
    include: { _count: { select: { opportunities: { where: { isOpen: true } } } } },
  });
  return reps.map((rep) => ({ id: rep.id, name: rep.name, count: rep._count.opportunities }));
}
