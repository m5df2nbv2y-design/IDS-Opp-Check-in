import { prisma } from "@/lib/db";

/**
 * The durable observation history behind CFO reporting.
 *
 * The `Opportunity` row is a mutable cache — every catalog refresh overwrites
 * amount, stage and close date. This service writes the append-only record of
 * what was true and when, so pipeline over time, stage movement, and realised
 * outcomes stay answerable without re-reading Salesforce (which overwrites its
 * own history too).
 *
 * Two principles hold this together:
 *
 *   1. **Change log, not a fact dump.** A row is written only when a tracked
 *      value actually differs from the last observation, so a daily refresh of
 *      an unchanging pipeline costs nothing.
 *
 *   2. **No attribution.** Interventions and outcomes are recorded as
 *      independent timestamped facts. Whether one influenced the other is a
 *      query-time methodology that can be defined and revised later; encoding a
 *      causal claim here would make it permanent and unreviewable.
 */

export const SNAPSHOT_SOURCES = {
  /** Routine observation during a Salesforce catalog refresh. */
  CATALOG_REFRESH: "CATALOG_REFRESH",
  /** State at the moment an intervention was sent. */
  CAMPAIGN_LAUNCH: "CAMPAIGN_LAUNCH",
  /** Terminal state, captured once the opportunity left the open set. */
  OUTCOME_OBSERVED: "OUTCOME_OBSERVED",
} as const;

export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[keyof typeof SNAPSHOT_SOURCES];

export type SnapshotInput = {
  opportunityId: string;
  externalId: string;
  source: SnapshotSource;
  amount: number;
  stage: string;
  closeDate: Date | null;
  isOpen: boolean;
  isWon?: boolean | null;
  accountId?: string | null;
  accountName: string;
  internalRepId?: string | null;
  internalRepName: string;
};

/** Values whose change is worth a new row. Names/ids are context, not signal. */
function materiallyDiffers(
  previous: {
    amount: number;
    stage: string;
    closeDate: Date | null;
    isOpen: boolean;
    isWon: boolean | null;
  },
  next: SnapshotInput,
): boolean {
  return (
    previous.amount !== next.amount ||
    previous.stage !== next.stage ||
    previous.closeDate?.getTime() !== next.closeDate?.getTime() ||
    previous.isOpen !== next.isOpen ||
    (previous.isWon ?? null) !== (next.isWon ?? null)
  );
}

/**
 * Record an observation if it differs from the last one for this opportunity.
 * Returns true when a row was written.
 *
 * CAMPAIGN_LAUNCH and OUTCOME_OBSERVED always write: they mark events, not
 * routine polling, and the timeline should show them even when nothing changed.
 */
export async function recordSnapshot(input: SnapshotInput): Promise<boolean> {
  const alwaysRecord =
    input.source === SNAPSHOT_SOURCES.CAMPAIGN_LAUNCH ||
    input.source === SNAPSHOT_SOURCES.OUTCOME_OBSERVED;

  if (!alwaysRecord) {
    const previous = await prisma.opportunitySnapshot.findFirst({
      where: { externalId: input.externalId },
      orderBy: { observedAt: "desc" },
      select: { amount: true, stage: true, closeDate: true, isOpen: true, isWon: true },
    });

    if (previous && !materiallyDiffers(previous, input)) return false;
  }

  await prisma.opportunitySnapshot.create({
    data: {
      opportunityId: input.opportunityId,
      externalId: input.externalId,
      source: input.source,
      amount: input.amount,
      stage: input.stage,
      closeDate: input.closeDate,
      isOpen: input.isOpen,
      isWon: input.isWon ?? null,
      accountId: input.accountId ?? null,
      accountName: input.accountName,
      internalRepId: input.internalRepId ?? null,
      internalRepName: input.internalRepName,
    },
  });

  return true;
}

/** Record many observations, returning how many were material enough to store. */
export async function recordSnapshots(inputs: SnapshotInput[]): Promise<number> {
  let written = 0;
  for (const input of inputs) {
    if (await recordSnapshot(input)) written += 1;
  }
  return written;
}

/** Full observation history for one opportunity, oldest first. */
export async function getSnapshotHistory(externalId: string) {
  return prisma.opportunitySnapshot.findMany({
    where: { externalId },
    orderBy: { observedAt: "asc" },
  });
}
