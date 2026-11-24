import { prisma } from "@/lib/db";
import { isClosedStage, OPEN_PIPELINE_STAGES } from "@/lib/stages";

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
  /** Moved to another open stage. Closed Lost is counted in closedOut instead. */
  stageMovedCount: number;
  stageMovedValue: number;
  /** The contact said the project is over (Closed Lost). */
  closedOutCount: number;
  closedOutValue: number;
  closeDateMovedCount: number;
  closeDateMovedValue: number;
  confirmedNoChangeCount: number;
  confirmedNoChangeValue: number;
  withheldCount: number;
  movements: MovementRow[];
};

type Tally = { count: number; value: number };

/**
 * What check-ins achieved across every sent campaign (Josh, 2026-11-24). Only
 * what contacts told us: Closed Won happens when IDS receives an order, so it
 * is never a campaign result. An opportunity reached by more than one campaign
 * counts once, by its latest answer.
 */
export type CampaignResults = {
  campaignCount: number;
  emailed: Tally;
  responded: Tally;
  movedForward: Tally;
  movedBack: Tally;
  /** The contact said the project is over (Closed Lost). */
  closedOut: Tally;
  closeDateUpdated: Tally;
  /** Answered with the same stage and close date. */
  confirmedNoChange: Tally;
  /** Answers the app wrote back to Salesforce. */
  writtenToSalesforce: number;
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
  const closedOut = responded.filter((item) => isClosedStage(item.updatedStatus));
  const stageMoved = responded.filter(
    (item) => item.updatedStatus !== null && item.updatedStatus !== item.previousStatus && !isClosedStage(item.updatedStatus),
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
    closedOutCount: closedOut.length,
    closedOutValue: sum(closedOut),
    closeDateMovedCount: closeDateMoved.length,
    closeDateMovedValue: sum(closeDateMoved),
    confirmedNoChangeCount: responded.length - stageMoved.length - closedOut.length,
    confirmedNoChangeValue: sum(responded) - sum(stageMoved) - sum(closedOut),
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
export async function getCampaignResults(): Promise<CampaignResults> {
  const [campaignCount, items] = await Promise.all([
    prisma.campaign.count({ where: { status: { not: "DRAFT" } } }),
    prisma.checkInOpportunity.findMany({
      where: { recipient: { sentAt: { not: null }, campaign: { status: { not: "DRAFT" } } } },
      select: {
        opportunityId: true, amount: true, submittedAt: true, syncStatus: true,
        previousStatus: true, updatedStatus: true, previousCloseDate: true, updatedCloseDate: true,
      },
    }),
  ]);

  // One row per opportunity: its latest answer, else any unanswered invitation.
  const latest = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    const kept = latest.get(item.opportunityId);
    if (!kept || (item.submittedAt && (!kept.submittedAt || item.submittedAt > kept.submittedAt))) {
      latest.set(item.opportunityId, item);
    }
  }
  const rows = [...latest.values()];
  const answered = rows.filter((row) => row.submittedAt !== null);

  const order = (stage: string | null) => OPEN_PIPELINE_STAGES.findIndex((s) => s.value === stage);
  const closed = (row: (typeof rows)[number]) => isClosedStage(row.updatedStatus);
  const stageChanged = (row: (typeof rows)[number]) => row.updatedStatus !== null && row.updatedStatus !== row.previousStatus;
  const dateChanged = (row: (typeof rows)[number]) =>
    row.updatedCloseDate !== null && row.updatedCloseDate.getTime() !== (row.previousCloseDate?.getTime() ?? NaN);
  const tally = (list: typeof rows): Tally => ({ count: list.length, value: list.reduce((total, row) => total + row.amount, 0) });
  const open = answered.filter((row) => !closed(row));

  return {
    campaignCount,
    emailed: tally(rows),
    responded: tally(answered),
    movedForward: tally(open.filter((row) => stageChanged(row) && order(row.updatedStatus) > order(row.previousStatus) && order(row.previousStatus) >= 0)),
    movedBack: tally(open.filter((row) => stageChanged(row) && order(row.updatedStatus) >= 0 && order(row.updatedStatus) < order(row.previousStatus))),
    closedOut: tally(answered.filter(closed)),
    closeDateUpdated: tally(open.filter(dateChanged)),
    confirmedNoChange: tally(open.filter((row) => !stageChanged(row) && !dateChanged(row))),
    writtenToSalesforce: answered.filter((row) => row.syncStatus === "SYNCED").length,
  };
}
