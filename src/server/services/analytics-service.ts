import { prisma } from "@/lib/db";

/**
 * The minimum evidence needed to show that the system measures intervention and
 * outcome. Deliberately small: counts and movements read straight from the
 * facts already recorded, not an analytics platform.
 *
 * Nothing here claims causation. Interventions and outcomes are reported as
 * separate timestamped facts, and a movement observed after an intervention is
 * labelled exactly that — "changed after contact", never "caused by contact".
 * Attribution stays a query-time methodology to be defined later.
 */

export type MovementRow = {
  opportunityName: string;
  accountName: string;
  contactName: string;
  ownerName: string;
  amount: number;
  fromStage: string;
  toStage: string | null;
  fromCloseDate: Date | null;
  toCloseDate: Date | null;
  respondedAt: Date | null;
  syncStatus: string;
};

export type CampaignAnalytics = {
  campaignId: string;
  campaignName: string;
  /**
   * Whether selection was actually recorded for this campaign. False for a
   * campaign launched before selections were tracked — its selected figures are
   * unknown, which is not the same as zero and must not be reported as zero.
   */
  selectionRecorded: boolean;
  /** Explicitly chosen by an admin. Null when selection was never recorded. */
  selectedCount: number | null;
  selectedValue: number | null;
  /** Actually sent — selection minus anything that drifted. */
  contactedCount: number;
  contactedValue: number;
  recipientCount: number;
  /** Recipients who opened their link. */
  openedCount: number;
  /** Opportunities a contact answered. */
  respondedCount: number;
  respondedValue: number;
  stageMovedCount: number;
  stageMovedValue: number;
  closeDateMovedCount: number;
  closeDateMovedValue: number;
  confirmedNoChangeCount: number;
  confirmedNoChangeValue: number;
  withheldCount: number;
  movements: MovementRow[];
};

export type OutcomeTotals = {
  wonCount: number;
  wonValue: number;
  lostCount: number;
  lostValue: number;
  openCount: number;
  openValue: number;
};

/** Everything the campaign story needs, in one pass. */
export async function getCampaignAnalytics(campaignId: string): Promise<CampaignAnalytics | null> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return null;

  const selections = await prisma.campaignSelection.findMany({
    where: { campaignId },
    select: { amountAtSelection: true },
  });

  const items = await prisma.checkInOpportunity.findMany({
    where: { recipient: { campaignId } },
    include: { recipient: { include: { contact: { include: { account: true } } } } },
    orderBy: { amount: "desc" },
  });

  const recipients = await prisma.checkInRecipient.findMany({
    where: { campaignId },
    select: { openedAt: true },
  });

  const responded = items.filter((item) => item.submittedAt !== null);
  const stageMoved = responded.filter(
    (item) => item.updatedStatus !== null && item.updatedStatus !== item.previousStatus,
  );
  const closeDateMoved = responded.filter(
    (item) =>
      item.updatedCloseDate !== null &&
      item.updatedCloseDate.getTime() !== (item.previousCloseDate?.getTime() ?? NaN),
  );

  const sum = (rows: { amount: number }[]) => rows.reduce((total, row) => total + row.amount, 0);

  return {
    campaignId,
    campaignName: campaign.name,
    selectionRecorded: selections.length > 0,
    selectedCount: selections.length > 0 ? selections.length : null,
    selectedValue:
      selections.length > 0
        ? selections.reduce((total, row) => total + (row.amountAtSelection ?? 0), 0)
        : null,
    contactedCount: items.length,
    contactedValue: sum(items),
    recipientCount: recipients.length,
    openedCount: recipients.filter((recipient) => recipient.openedAt !== null).length,
    respondedCount: responded.length,
    respondedValue: sum(responded),
    stageMovedCount: stageMoved.length,
    stageMovedValue: sum(stageMoved),
    closeDateMovedCount: closeDateMoved.length,
    closeDateMovedValue: sum(closeDateMoved),
    confirmedNoChangeCount: responded.length - stageMoved.length,
    confirmedNoChangeValue: sum(responded) - sum(stageMoved),
    withheldCount: items.filter((item) => item.syncStatus === "WITHHELD").length,
    movements: responded.map((item) => ({
      opportunityName: item.projectName ?? item.opportunityName,
      accountName: item.accountName,
      contactName: item.recipient.contact.name,
      ownerName: item.internalRepName,
      amount: item.amount,
      fromStage: item.previousStatus,
      toStage: item.updatedStatus,
      fromCloseDate: item.previousCloseDate,
      toCloseDate: item.updatedCloseDate,
      respondedAt: item.submittedAt,
      syncStatus: item.syncStatus,
    })),
  };
}

export type SnapshotEvidence = {
  totalObservations: number;
  bySource: { source: string; count: number }[];
  pipelineByStage: { stage: string; count: number; value: number }[];
  /** A single opportunity's timeline, as proof the history is real. */
  sampleTimeline: {
    opportunityName: string;
    rows: { observedAt: Date; source: string; stage: string; amount: number; closeDate: Date | null }[];
  } | null;
};

/**
 * Proof that the observation history exists and is queryable — the point being
 * that this survives Salesforce overwriting its own values.
 */
export async function getSnapshotEvidence(): Promise<SnapshotEvidence> {
  const [total, sources, latest] = await Promise.all([
    prisma.opportunitySnapshot.count(),
    prisma.opportunitySnapshot.groupBy({ by: ["source"], _count: { _all: true } }),
    prisma.opportunity.findMany({
      where: { isOpen: true },
      select: { currentStage: true, amount: true },
    }),
  ]);

  const byStage = new Map<string, { count: number; value: number }>();
  for (const opportunity of latest) {
    const entry = byStage.get(opportunity.currentStage) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += opportunity.amount;
    byStage.set(opportunity.currentStage, entry);
  }

  // Prefer an opportunity that actually has a story — more than one observation.
  const candidates = await prisma.opportunitySnapshot.groupBy({
    by: ["externalId"],
    _count: { _all: true },
    orderBy: { _count: { externalId: "desc" } },
    take: 1,
  });

  let sampleTimeline: SnapshotEvidence["sampleTimeline"] = null;
  const externalId = candidates[0]?.externalId;
  if (externalId) {
    const rows = await prisma.opportunitySnapshot.findMany({
      where: { externalId },
      orderBy: { observedAt: "asc" },
    });
    const opportunity = await prisma.opportunity.findUnique({ where: { externalId } });
    if (rows.length > 0) {
      sampleTimeline = {
        opportunityName:
          opportunity?.projectName ?? opportunity?.opportunityName ?? rows[0].externalId,
        rows: rows.map((row) => ({
          observedAt: row.observedAt,
          source: row.source,
          stage: row.stage,
          amount: row.amount,
          closeDate: row.closeDate,
        })),
      };
    }
  }

  return {
    totalObservations: total,
    bySource: sources
      .map((entry) => ({ source: entry.source, count: entry._count._all }))
      .sort((a, b) => b.count - a.count),
    pipelineByStage: [...byStage.entries()]
      .map(([stage, entry]) => ({ stage, ...entry }))
      .sort((a, b) => b.value - a.value),
    sampleTimeline,
  };
}

/**
 * Realised outcomes in dollars. Reported straight from the terminal state we
 * captured when each opportunity left the open set — no attribution to any
 * campaign is implied or calculated.
 */
export async function getOutcomeTotals(): Promise<OutcomeTotals> {
  const [closed, open] = await Promise.all([
    prisma.opportunity.findMany({
      where: { outcomeObservedAt: { not: null } },
      select: { isWon: true, finalAmount: true, amount: true },
    }),
    prisma.opportunity.findMany({ where: { isOpen: true }, select: { amount: true } }),
  ]);

  const value = (row: { finalAmount: number | null; amount: number }) => row.finalAmount ?? row.amount;
  const won = closed.filter((row) => row.isWon === true);
  const lost = closed.filter((row) => row.isWon === false);

  return {
    wonCount: won.length,
    wonValue: won.reduce((total, row) => total + value(row), 0),
    lostCount: lost.length,
    lostValue: lost.reduce((total, row) => total + value(row), 0),
    openCount: open.length,
    openValue: open.reduce((total, row) => total + row.amount, 0),
  };
}
