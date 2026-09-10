import { prisma } from "@/lib/db";
import { OPPORTUNITY_STAGES, stageLabel } from "@/lib/stages";
import { RESOLUTION_REASONS, type ResolutionReason } from "./recipient-resolution-service";
import { getCampaignAnalytics, getSnapshotEvidence } from "./analytics-service";
import { listCampaigns } from "./campaign-service";

/**
 * The single reporting snapshot. Both the PDF brief and the Excel workbook are
 * rendered from this one structure, so the two exports can never disagree and
 * there is exactly one place where a reporting number is computed.
 *
 * Four kinds of fact are kept deliberately separate and are never merged into a
 * single "before/after" figure:
 *
 *   current state       what Salesforce says now (Opportunity.*)
 *   historical state    what we observed earlier (OpportunitySnapshot)
 *   intervention state  what it looked like when chosen (CampaignSelection.*AtSelection)
 *   outcome             what we later observed (Opportunity.isWon/finalAmount)
 *
 * No attribution is computed anywhere in this file. A movement recorded after
 * an intervention is reported as an observed movement and nothing more.
 */

export type ReportSummary = {
  openCount: number;
  openValue: number;
  pastDueCount: number;
  pastDueValue: number;
  /** Null when no campaign has been sent — rendered as "—", never as zero. */
  selectedCount: number | null;
  selectedValue: number | null;
  contactedCount: number | null;
  contactedValue: number | null;
  responseCount: number | null;
  responseValue: number | null;
  /** Responses ÷ contacted, as a fraction. Null when nothing was contacted. */
  responseRate: number | null;
  stageMovementCount: number | null;
  closeDateChangeCount: number | null;
};

export type StageRow = { stage: string; label: string; count: number; value: number };
export type RepRow = { rep: string; count: number; value: number };

export type AttentionRow = {
  account: string;
  opportunity: string;
  amount: number;
  stage: string;
  closeDate: Date | null;
  reason: string;
};

export type OpportunityRow = {
  externalId: string;
  opportunityName: string;
  account: string;
  amount: number;
  stage: string;
  closeDate: Date | null;
  owner: string;
  isOpen: boolean;
  isWon: boolean | null;
  finalStage: string | null;
  finalAmount: number | null;
  closedAt: Date | null;
  outcomeObservedAt: Date | null;
};

export type EngagementRow = {
  campaign: string;
  opportunity: string;
  account: string;
  rep: string;
  amountAtSelection: number | null;
  stageAtSelection: string | null;
  closeDateAtSelection: Date | null;
  selectedAt: Date;
  selectedBy: string | null;
  contactedAt: Date | null;
  responseStage: string | null;
  submittedAt: Date | null;
  updatedCloseDate: Date | null;
  syncStatus: string | null;
};

export type PipelineReport = {
  generatedAt: Date;
  /** The campaign the engagement figures describe, if any has been sent. */
  campaignName: string | null;
  summary: ReportSummary;
  byStage: StageRow[];
  byRep: RepRow[];
  attention: AttentionRow[];
  opportunities: OpportunityRow[];
  engagement: EngagementRow[];
};

/** Executive tables stay readable; the workbook carries the full list. */
const ATTENTION_LIMIT = 15;

/**
 * Compact forms of the resolution reasons, for the narrow report column. The
 * full sentences live in RESOLUTION_REASON_LABELS and are used in the UI.
 */
const SHORT_REASONS: Record<ResolutionReason, string> = {
  [RESOLUTION_REASONS.PRIMARY_CONTACT_ROLE]: "Resolved",
  [RESOLUTION_REASONS.NO_PRIMARY_CONTACT_ROLE]: "No contact role",
  [RESOLUTION_REASONS.PRIMARY_CONTACT_NO_EMAIL]: "Contact has no email",
  [RESOLUTION_REASONS.PRIMARY_CONTACT_NOT_FOUND]: "Contact not found",
};

/** Sales progression, not alphabetical. Taken from the controlled stage list. */
const STAGE_ORDER = OPPORTUNITY_STAGES.map((stage) => stage.value);

export async function buildPipelineReport(): Promise<PipelineReport> {
  const campaigns = await listCampaigns();
  const sent = campaigns.filter((campaign) => campaign.status !== "DRAFT");

  const [analytics, evidence, open, allOpportunities, selections] = await Promise.all([
    sent[0] ? getCampaignAnalytics(sent[0].id) : Promise.resolve(null),
    getSnapshotEvidence(),
    prisma.opportunity.findMany({
      where: { isOpen: true },
      include: { account: true, internalRep: true },
      orderBy: { amount: "desc" },
    }),
    prisma.opportunity.findMany({
      include: { account: true, internalRep: true },
      orderBy: { amount: "desc" },
    }),
    prisma.campaignSelection.findMany({
      include: {
        campaign: true,
        opportunity: { include: { account: true, internalRep: true } },
      },
      orderBy: { selectedAt: "desc" },
    }),
  ]);

  // "Past due" is a plain reading of the current record: still open, but the
  // close date Salesforce holds has already passed.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const pastDue = open.filter(
    (opportunity) => opportunity.closeDate !== null && opportunity.closeDate < startOfToday,
  );

  const total = (rows: { amount: number }[]) => rows.reduce((sum, row) => sum + row.amount, 0);

  const summary: ReportSummary = {
    openCount: open.length,
    openValue: total(open),
    pastDueCount: pastDue.length,
    pastDueValue: total(pastDue),
    selectedCount: analytics?.selectedCount ?? null,
    selectedValue: analytics?.selectedValue ?? null,
    contactedCount: analytics?.contactedCount ?? null,
    contactedValue: analytics?.contactedValue ?? null,
    responseCount: analytics?.respondedCount ?? null,
    responseValue: analytics?.respondedValue ?? null,
    responseRate:
      analytics && analytics.contactedCount > 0
        ? analytics.respondedCount / analytics.contactedCount
        : null,
    stageMovementCount: analytics?.stageMovedCount ?? null,
    closeDateChangeCount: analytics?.closeDateMovedCount ?? null,
  };

  // Reuses the same by-stage figures the Measurement page shows, ordered by
  // sales progression rather than by value.
  const byStage: StageRow[] = [...evidence.pipelineByStage]
    .map((row) => ({ ...row, label: stageLabel(row.stage) }))
    .sort((a, b) => {
      const left = STAGE_ORDER.indexOf(a.stage as (typeof STAGE_ORDER)[number]);
      const right = STAGE_ORDER.indexOf(b.stage as (typeof STAGE_ORDER)[number]);
      // Anything outside the controlled list sorts last rather than being hidden.
      return (left === -1 ? STAGE_ORDER.length : left) - (right === -1 ? STAGE_ORDER.length : right);
    });

  const repTotals = new Map<string, { count: number; value: number }>();
  for (const opportunity of open) {
    const entry = repTotals.get(opportunity.internalRep.name) ?? { count: 0, value: 0 };
    entry.count += 1;
    entry.value += opportunity.amount;
    repTotals.set(opportunity.internalRep.name, entry);
  }
  const byRep: RepRow[] = [...repTotals.entries()]
    .map(([rep, entry]) => ({ rep, ...entry }))
    .sort((a, b) => b.value - a.value);

  const attention: AttentionRow[] = open
    .filter((opportunity) => opportunity.resolutionStatus !== "RESOLVED")
    .slice(0, ATTENTION_LIMIT)
    .map((opportunity) => ({
      account: opportunity.account.name,
      opportunity: opportunity.projectName ?? opportunity.opportunityName,
      amount: opportunity.amount,
      stage: stageLabel(opportunity.currentStage),
      closeDate: opportunity.closeDate,
      reason: SHORT_REASONS[opportunity.resolutionReason as ResolutionReason] ?? "No recipient",
    }));

  const opportunities: OpportunityRow[] = allOpportunities.map((opportunity) => ({
    externalId: opportunity.externalId,
    opportunityName: opportunity.opportunityName,
    account: opportunity.account.name,
    amount: opportunity.amount,
    stage: stageLabel(opportunity.currentStage),
    closeDate: opportunity.closeDate,
    owner: opportunity.internalRep.name,
    isOpen: opportunity.isOpen,
    isWon: opportunity.isWon,
    finalStage: opportunity.finalStage ? stageLabel(opportunity.finalStage) : null,
    finalAmount: opportunity.finalAmount,
    closedAt: opportunity.closedAt,
    outcomeObservedAt: opportunity.outcomeObservedAt,
  }));

  // The check-in row is what turns a selection into an engagement record. It is
  // looked up per selection rather than joined, because a selection can exist
  // without ever having been sent.
  const checkInItems = await prisma.checkInOpportunity.findMany({
    include: { recipient: true },
  });
  const checkInByKey = new Map(
    checkInItems.map((item) => [`${item.recipient.campaignId}:${item.opportunityId}`, item]),
  );

  const engagement: EngagementRow[] = selections.map((selection) => {
    const item = checkInByKey.get(`${selection.campaignId}:${selection.opportunityId}`);
    return {
      campaign: selection.campaign.name,
      opportunity: selection.opportunity.projectName ?? selection.opportunity.opportunityName,
      account: selection.opportunity.account.name,
      rep: selection.opportunity.internalRep.name,
      amountAtSelection: selection.amountAtSelection,
      stageAtSelection: selection.stageAtSelection ? stageLabel(selection.stageAtSelection) : null,
      closeDateAtSelection: selection.closeDateAtSelection,
      selectedAt: selection.selectedAt,
      selectedBy: selection.selectedBy,
      contactedAt: item?.recipient.sentAt ?? null,
      responseStage: item?.updatedStatus ? stageLabel(item.updatedStatus) : null,
      submittedAt: item?.submittedAt ?? null,
      updatedCloseDate: item?.updatedCloseDate ?? null,
      syncStatus: item?.syncStatus ?? null,
    };
  });

  return {
    generatedAt: new Date(),
    campaignName: analytics?.campaignName ?? null,
    summary,
    byStage,
    byRep,
    attention,
    opportunities,
    engagement,
  };
}
