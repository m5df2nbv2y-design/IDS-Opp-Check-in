import ExcelJS from "exceljs";
import { brand } from "@/lib/brand";
import type { PipelineReport } from "@/server/services/report-service";

/**
 * The Pipeline Data Export workbook.
 *
 * Rendered from the same PipelineReport the PDF uses, so the two exports are
 * two views of one snapshot rather than two calculations. Nothing here queries
 * the database or derives a metric of its own.
 *
 * exceljs is used because the brief asks for real workbook formatting —
 * currency and date number formats, column widths, autofilter and frozen header
 * rows — which a plain CSV or a minimal sheet writer cannot express.
 */

const CURRENCY = '"$"#,##0';
const DATE = "d mmm yyyy";
const DATETIME = "d mmm yyyy h:mm AM/PM";
const HEADER_FILL = brand.colors.primary.replace("#", "FF");

type ColumnSpec = {
  header: string;
  key: string;
  width: number;
  format?: string;
};

function addSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ColumnSpec[],
  rows: Record<string, unknown>[],
  options: { autoFilter?: boolean } = {},
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
    style: column.format ? { numFmt: column.format } : undefined,
  }));

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: "middle" };
  header.height = 20;

  for (const row of rows) sheet.addRow(row);

  // Frozen header so a long list stays readable while scrolling.
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  if (options.autoFilter && rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };
  }

  return sheet;
}

/** Missing data stays visibly missing rather than becoming a zero. */
const orDash = <T,>(value: T | null | undefined): T | string => value ?? "—";

const percent = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

export async function renderPipelineWorkbook(report: PipelineReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = `${brand.companyName} ${brand.productName}`;
  workbook.created = report.generatedAt;
  workbook.title = "Pipeline Report";

  const { summary } = report;

  // 1 — Executive Summary. Metric/value pairs, with the dollar rows carrying a
  // real currency format so they can be charted or summed in Excel.
  const summarySheet = addSheet(
    workbook,
    "Executive Summary",
    [
      { header: "Metric", key: "metric", width: 34 },
      { header: "Value", key: "value", width: 22 },
    ],
    [
      { metric: "Report generated", value: report.generatedAt },
      { metric: "Campaign", value: orDash(report.campaignName) },
      { metric: "Open Opportunities", value: summary.openCount },
      { metric: "Open Pipeline", value: summary.openValue },
      { metric: "Past-Due Opportunities", value: summary.pastDueCount },
      { metric: "Past-Due Pipeline", value: summary.pastDueValue },
      { metric: "Selected Opportunities", value: orDash(summary.selectedCount) },
      { metric: "Selected Pipeline", value: orDash(summary.selectedValue) },
      { metric: "Contacted Opportunities", value: orDash(summary.contactedCount) },
      { metric: "Contacted Pipeline", value: orDash(summary.contactedValue) },
      { metric: "Responses", value: orDash(summary.responseCount) },
      { metric: "Response Rate", value: percent(summary.responseRate) },
      { metric: "Stage Movements", value: orDash(summary.stageMovementCount) },
      { metric: "Close-Date Changes", value: orDash(summary.closeDateChangeCount) },
    ],
  );
  summarySheet.getCell("B2").numFmt = DATETIME;
  for (const cell of ["B5", "B7", "B9", "B11"]) {
    summarySheet.getCell(cell).numFmt = CURRENCY;
  }
  summarySheet.addRow([]);
  const caveat = summarySheet.addRow([
    "Note",
    "Open pipeline is current Salesforce state. Selected and contacted figures describe intervention activity. Stage movements and close-date changes are movements observed after contact — no attribution to the outreach is calculated or implied.",
  ]);
  caveat.getCell(1).font = { bold: true };
  caveat.getCell(2).alignment = { wrapText: true, vertical: "top" };
  caveat.height = 46;

  // 2 — Pipeline by Stage, in sales progression order.
  const stageSheet = addSheet(
    workbook,
    "Pipeline by Stage",
    [
      { header: "Stage", key: "stage", width: 26 },
      { header: "Opportunity Count", key: "count", width: 20 },
      { header: "Pipeline Value", key: "value", width: 20, format: CURRENCY },
    ],
    report.byStage.map((row) => ({ stage: row.label, count: row.count, value: row.value })),
  );
  const stageTotal = stageSheet.addRow({
    stage: "Total",
    count: summary.openCount,
    value: summary.openValue,
  });
  stageTotal.font = { bold: true };

  // 3 — Pipeline by Sales Rep. Descriptive distribution, not a scorecard.
  addSheet(
    workbook,
    "Pipeline by Sales Rep",
    [
      { header: "Sales Rep", key: "rep", width: 28 },
      { header: "Opportunity Count", key: "count", width: 20 },
      { header: "Pipeline Value", key: "value", width: 20, format: CURRENCY },
    ],
    report.byRep.map((row) => ({ rep: row.rep, count: row.count, value: row.value })),
    { autoFilter: true },
  );

  // 4 — Opportunities. Current state plus the frozen outcome, kept in separate
  // columns so "what it is now" is never confused with "how it ended".
  addSheet(
    workbook,
    "Opportunities",
    [
      { header: "Opportunity ID", key: "externalId", width: 22 },
      { header: "Opportunity Name", key: "opportunityName", width: 36 },
      { header: "Account", key: "account", width: 28 },
      { header: "Amount", key: "amount", width: 16, format: CURRENCY },
      { header: "Stage", key: "stage", width: 16 },
      { header: "Close Date", key: "closeDate", width: 16, format: DATE },
      { header: "Owner", key: "owner", width: 22 },
      { header: "Is Open", key: "isOpen", width: 10 },
      { header: "Is Won", key: "isWon", width: 10 },
      { header: "Final Stage", key: "finalStage", width: 16 },
      { header: "Final Amount", key: "finalAmount", width: 16, format: CURRENCY },
      { header: "Closed At", key: "closedAt", width: 16, format: DATE },
      { header: "Outcome Observed At", key: "outcomeObservedAt", width: 22, format: DATETIME },
    ],
    report.opportunities.map((row) => ({
      externalId: row.externalId,
      opportunityName: row.opportunityName,
      account: row.account,
      amount: row.amount,
      stage: row.stage,
      closeDate: row.closeDate ?? "—",
      owner: row.owner,
      isOpen: row.isOpen ? "Yes" : "No",
      isWon: row.isWon === null ? "—" : row.isWon ? "Yes" : "No",
      finalStage: orDash(row.finalStage),
      finalAmount: orDash(row.finalAmount),
      closedAt: row.closedAt ?? "—",
      outcomeObservedAt: row.outcomeObservedAt ?? "—",
    })),
    { autoFilter: true },
  );

  // 5 — Engagement. The intervention state (values frozen at selection) beside
  // what was later observed, never collapsed into one before/after number.
  addSheet(
    workbook,
    "Engagement",
    [
      { header: "Campaign", key: "campaign", width: 26 },
      { header: "Opportunity", key: "opportunity", width: 34 },
      { header: "Account", key: "account", width: 26 },
      { header: "Rep", key: "rep", width: 22 },
      { header: "Amount at Selection", key: "amountAtSelection", width: 20, format: CURRENCY },
      { header: "Stage at Selection", key: "stageAtSelection", width: 18 },
      { header: "Close Date at Selection", key: "closeDateAtSelection", width: 22, format: DATE },
      { header: "Selected At", key: "selectedAt", width: 22, format: DATETIME },
      { header: "Selected By", key: "selectedBy", width: 26 },
      { header: "Contacted At", key: "contactedAt", width: 22, format: DATETIME },
      { header: "Response / Status", key: "responseStage", width: 18 },
      { header: "Submitted At", key: "submittedAt", width: 22, format: DATETIME },
      { header: "Updated Close Date", key: "updatedCloseDate", width: 20, format: DATE },
      { header: "Sync Status", key: "syncStatus", width: 16 },
    ],
    report.engagement.map((row) => ({
      campaign: row.campaign,
      opportunity: row.opportunity,
      account: row.account,
      rep: row.rep,
      amountAtSelection: orDash(row.amountAtSelection),
      stageAtSelection: orDash(row.stageAtSelection),
      closeDateAtSelection: row.closeDateAtSelection ?? "—",
      selectedAt: row.selectedAt,
      selectedBy: orDash(row.selectedBy),
      contactedAt: row.contactedAt ?? "—",
      responseStage: orDash(row.responseStage),
      submittedAt: row.submittedAt ?? "—",
      updatedCloseDate: row.updatedCloseDate ?? "—",
      syncStatus: orDash(row.syncStatus),
    })),
    { autoFilter: true },
  );

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
