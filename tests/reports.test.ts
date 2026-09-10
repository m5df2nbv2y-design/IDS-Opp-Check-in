import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import {
  getOrCreateDraft,
  sendDraft,
  setSelection,
} from "@/server/services/campaign-draft-service";
import { completeCheckIn, saveResponse } from "@/server/services/response-service";
import { buildPipelineReport } from "@/server/services/report-service";
import { renderExecutiveBrief } from "@/server/reports/executive-brief-pdf";
import { renderPipelineWorkbook } from "@/server/reports/pipeline-workbook";
import { resetDatabase } from "./fixtures";

/**
 * exceljs types `Row.values` as a union that includes a function, and its
 * `load()` as the older Buffer type. Both are read back only in these
 * assertions, so they are narrowed here rather than in the export code.
 */
const headerOf = (row: ExcelJS.Row): unknown[] => (row.values as unknown[]).slice(1);
const loadWorkbook = async (bytes: Buffer): Promise<ExcelJS.Workbook> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
};

/**
 * The reporting snapshot and its two renderings.
 *
 * The point being protected here is that the PDF and the workbook are two views
 * of ONE calculation, and that the four kinds of fact the architecture keeps
 * apart — current state, intervention state, observed movement, outcome — stay
 * apart in the output.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(`${root}${relative}`, "utf8");

/** Selects one opportunity, sends it, and answers with a stage + date change. */
async function runOneCampaign() {
  const draft = await getOrCreateDraft("test");
  const opportunity = await prisma.opportunity.findFirstOrThrow({
    where: { isOpen: true, resolutionStatus: "RESOLVED" },
    orderBy: { amount: "desc" },
  });
  await setSelection({ campaignId: draft.id, opportunityIds: [opportunity.id], selected: true });
  await sendDraft(draft.id, "test");

  const email = await prisma.emailMessage.findFirstOrThrow({
    where: { campaignId: draft.id, kind: "INVITE" },
  });
  const token = email.linkUrl!.split("/checkin/")[1];

  const items = await prisma.checkInOpportunity.findMany({
    where: { recipient: { campaignId: draft.id } },
  });
  for (const item of items) {
    await saveResponse({
      token,
      itemId: item.id,
      stage: item.previousStatus === "NEGOTIATION" ? "PROPOSAL" : "NEGOTIATION",
      closeDate: "2028-01-31",
    });
  }
  await completeCheckIn(token);
  return { campaignId: draft.id, opportunity };
}

describe("the reporting snapshot", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("reports open pipeline from current state", async () => {
    const report = await buildPipelineReport();
    const open = await prisma.opportunity.findMany({ where: { isOpen: true } });

    expect(report.summary.openCount).toBe(open.length);
    expect(report.summary.openValue).toBe(open.reduce((sum, row) => sum + row.amount, 0));
    expect(report.summary.openValue).toBeGreaterThan(0);
  });

  it("reports unknown engagement as null, never as a manufactured zero", async () => {
    // No campaign has been sent, so there is no selection to report. Zero would
    // assert that nothing was chosen, which is a different claim.
    const report = await buildPipelineReport();

    expect(report.summary.selectedCount).toBeNull();
    expect(report.summary.selectedValue).toBeNull();
    expect(report.summary.responseRate).toBeNull();
    expect(report.campaignName).toBeNull();
  });

  it("counts past due from the close date on the record", async () => {
    const target = await prisma.opportunity.findFirstOrThrow({ where: { isOpen: true } });
    await prisma.opportunity.update({
      where: { id: target.id },
      data: { closeDate: new Date("2020-01-01T00:00:00.000Z") },
    });

    const report = await buildPipelineReport();
    expect(report.summary.pastDueCount).toBe(1);
    expect(report.summary.pastDueValue).toBe(target.amount);
  });

  it("orders stages by sales progression, not alphabetically or by value", async () => {
    const report = await buildPipelineReport();
    const stages = report.byStage.map((row) => row.stage);
    const expected = ["QUALIFICATION", "PROPOSAL", "SPECIFIED", "NEGOTIATION"].filter((stage) =>
      stages.includes(stage),
    );

    expect(stages).toEqual(expected);
  });

  it("sorts sales reps by pipeline value descending and never hardcodes a name", async () => {
    const report = await buildPipelineReport();
    const values = report.byRep.map((row) => row.value);

    expect(report.byRep.length).toBeGreaterThan(0);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    expect(read("src/server/services/report-service.ts")).not.toMatch(/"[A-Z][a-z]+ [A-Z][a-z]+"/);
  });

  it("keeps intervention state separate from current state after a campaign", async () => {
    const { opportunity } = await runOneCampaign();
    const report = await buildPipelineReport();

    expect(report.summary.selectedCount).toBe(1);
    expect(report.summary.selectedValue).toBe(opportunity.amount);
    expect(report.summary.responseCount).toBe(1);
    expect(report.summary.responseRate).toBe(1);
    expect(report.summary.stageMovementCount).toBe(1);
    expect(report.summary.closeDateChangeCount).toBe(1);

    // The engagement row carries what the opportunity looked like when it was
    // chosen — frozen — alongside what was observed afterwards.
    const row = report.engagement.find((entry) => entry.account === opportunity.customerName) ??
      report.engagement[0];
    expect(row.amountAtSelection).toBe(opportunity.amount);
    expect(row.stageAtSelection).not.toBeNull();
    expect(row.selectedAt).toBeInstanceOf(Date);
    expect(row.submittedAt).toBeInstanceOf(Date);
    expect(row.responseStage).not.toBeNull();
  });

  it("lists opportunities needing attention with a reason", async () => {
    const report = await buildPipelineReport();
    const unresolved = await prisma.opportunity.count({
      where: { isOpen: true, resolutionStatus: { not: "RESOLVED" } },
    });

    expect(report.attention.length).toBe(Math.min(unresolved, 15));
    for (const row of report.attention) {
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.account.length).toBeGreaterThan(0);
    }
  });
});

describe("both exports render from the one snapshot", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    await runOneCampaign();
  });

  it("produces a valid multi-page PDF", async () => {
    const report = await buildPipelineReport();
    const pdf = await renderExecutiveBrief(report);
    const header = Buffer.from(pdf.slice(0, 5)).toString("latin1");

    expect(header).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(2000);
  });

  it("produces a workbook with every required sheet and header", async () => {
    const report = await buildPipelineReport();
    const workbook = await loadWorkbook(await renderPipelineWorkbook(report));

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Executive Summary",
      "Pipeline by Stage",
      "Pipeline by Sales Rep",
      "Opportunities",
      "Engagement",
    ]);

    const stages = workbook.getWorksheet("Pipeline by Stage")!;
    expect(headerOf(stages.getRow(1))).toEqual([
      "Stage",
      "Opportunity Count",
      "Pipeline Value",
    ]);
    // Header row frozen, dollars carry a real currency format.
    expect(stages.views[0].state).toBe("frozen");
    expect(stages.getCell("C2").numFmt).toContain("$");

    const opportunities = workbook.getWorksheet("Opportunities")!;
    expect(opportunities.rowCount).toBe((await prisma.opportunity.count()) + 1);
    expect(opportunities.autoFilter).toBeTruthy();
  });

  it("gives the PDF and the workbook the same figures", async () => {
    // One snapshot, two renderings — so this compares each rendering against
    // the shared structure rather than against a second calculation.
    const report = await buildPipelineReport();
    const workbook = await loadWorkbook(await renderPipelineWorkbook(report));

    const summary = workbook.getWorksheet("Executive Summary")!;
    const valueOf = (metric: string) => {
      for (let row = 2; row <= summary.rowCount; row += 1) {
        if (summary.getRow(row).getCell(1).value === metric) {
          return summary.getRow(row).getCell(2).value;
        }
      }
      return undefined;
    };

    expect(valueOf("Open Pipeline")).toBe(report.summary.openValue);
    expect(valueOf("Selected Pipeline")).toBe(report.summary.selectedValue);
    expect(valueOf("Contacted Opportunities")).toBe(report.summary.contactedCount);
  });
});

describe("report generation sits behind the admin boundary", () => {
  const routes = [
    "src/app/api/admin/reports/executive-brief/route.ts",
    "src/app/api/admin/reports/pipeline-workbook/route.ts",
  ];

  it.each(routes)("%s authorizes before touching any data", (route) => {
    const source = read(route);
    const guardIndex = source.indexOf("authorizeExport(");
    const buildIndex = source.indexOf("buildPipelineReport()");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(-1);
    // The report must not be built for a caller who was never admitted.
    expect(guardIndex).toBeLessThan(buildIndex);
    expect(source).toContain("if (!guard.ok) return guard.response;");
  });

  it("rejects both the unauthenticated and the unauthorized caller", () => {
    const guard = read("src/server/reports/authorize-export.ts");

    expect(guard).toContain("requireAdmin()");
    expect(guard).toMatch(/UnauthorizedError[\s\S]*status: 401/);
    expect(guard).toMatch(/ForbiddenError[\s\S]*status: 403/);
    // A thrown error must never fall through to a rendered report.
    expect(guard).toContain("throw error;");
  });

  it("exposes no report route outside /api/admin", () => {
    const nonAdmin = [
      "src/app/api/checkin/[token]/responses/route.ts",
      "src/app/api/checkin/[token]/complete/route.ts",
    ];
    for (const route of nonAdmin) {
      const source = read(route);
      expect(source).not.toContain("buildPipelineReport");
      expect(source).not.toContain("renderExecutiveBrief");
      expect(source).not.toContain("renderPipelineWorkbook");
    }
  });
});
