import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { brand } from "@/lib/brand";
import { formatReportAmount } from "@/lib/format";
import type { PipelineReport } from "@/server/services/report-service";

/**
 * The Executive Pipeline Brief.
 *
 * Rendered with pdf-lib rather than a HTML-to-PDF pipeline: it has no native
 * dependencies and no headless browser, and it uses the PDF standard fonts, so
 * nothing has to be read off disk at runtime. That matters here because the
 * route runs inside the Next.js server bundle, where font-file loading is the
 * usual reason PDF generation breaks in production.
 *
 * Layout is deliberately plain — typography and tables, no graphics.
 */

const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const BOTTOM_LIMIT = 72;

const hex = (value: string) =>
  rgb(
    parseInt(value.slice(1, 3), 16) / 255,
    parseInt(value.slice(3, 5), 16) / 255,
    parseInt(value.slice(5, 7), 16) / 255,
  );

// Reuses the design tokens in src/lib/brand.ts so the report matches the UI.
const COLOR = {
  ink: hex(brand.colors.ink),
  body: hex(brand.colors.body),
  muted: hex(brand.colors.muted),
  line: hex(brand.colors.line),
  primary: hex(brand.colors.primary),
  canvas: hex(brand.colors.canvas),
};

type Column = {
  header: string;
  width: number;
  align?: "left" | "right";
};

class Brief {
  private readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;

  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  private newPage() {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.y = PAGE.height - MARGIN;
  }

  /** Starts a new page when the next block would cross the footer. */
  private ensure(space: number) {
    if (this.y - space < BOTTOM_LIMIT) this.newPage();
  }

  private text(
    value: string,
    options: {
      x?: number;
      size?: number;
      font?: PDFFont;
      color?: ReturnType<typeof rgb>;
      maxWidth?: number;
      align?: "left" | "right";
    } = {},
  ) {
    const font = options.font ?? this.regular;
    const size = options.size ?? 10;
    const x = options.x ?? MARGIN;
    const shown = options.maxWidth ? truncate(value, font, size, options.maxWidth) : value;
    const width = font.widthOfTextAtSize(shown, size);
    this.page.drawText(shown, {
      x: options.align === "right" ? x + (options.maxWidth ?? 0) - width : x,
      y: this.y,
      size,
      font,
      color: options.color ?? COLOR.body,
    });
  }

  titleBlock(report: PipelineReport) {
    this.y -= 4;
    this.text(brand.companyName.toUpperCase(), {
      size: 9,
      font: this.bold,
      color: COLOR.primary,
    });
    this.y -= 22;
    this.text("Opportunity Check-In — Executive Pipeline Brief", {
      size: 18,
      font: this.bold,
      color: COLOR.ink,
    });
    this.y -= 15;
    this.text(`Generated ${formatTimestamp(report.generatedAt)}`, {
      size: 9,
      color: COLOR.muted,
    });
    this.y -= 10;
    this.rule(COLOR.primary, 1.5);
    this.y -= 18;
  }

  heading(value: string) {
    this.y -= 6;
    this.ensure(46);
    this.text(value.toUpperCase(), { size: 9, font: this.bold, color: COLOR.primary });
    this.y -= 6;
    this.rule(COLOR.line, 0.75);
    this.y -= 16;
  }

  note(value: string) {
    for (const line of wrap(value, this.regular, 8.5, CONTENT_WIDTH)) {
      this.ensure(14);
      this.text(line, { size: 8.5, color: COLOR.muted });
      this.y -= 11;
    }
    this.y -= 4;
  }

  /** Two-column metric grid used by the summary sections. */
  metrics(rows: { label: string; value: string }[]) {
    const columnWidth = CONTENT_WIDTH / 2;
    for (let index = 0; index < rows.length; index += 2) {
      this.ensure(20);
      const pair = rows.slice(index, index + 2);
      pair.forEach((row, offset) => {
        const x = MARGIN + offset * columnWidth;
        this.text(row.label, { x, size: 9, color: COLOR.muted, maxWidth: columnWidth - 90 });
        this.text(row.value, {
          x,
          size: 10.5,
          font: this.bold,
          color: COLOR.ink,
          maxWidth: columnWidth - 12,
          align: "right",
        });
      });
      this.y -= 17;
    }
    this.y -= 6;
  }

  table(
    columns: Column[],
    rows: string[][],
    options: { totalRow?: string[]; size?: number } = {},
  ) {
    const size = options.size ?? 9;
    const drawHeader = () => {
      this.ensure(30);
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y - 5,
        width: CONTENT_WIDTH,
        height: 18,
        color: COLOR.canvas,
      });
      let x = MARGIN + 6;
      for (const column of columns) {
        this.text(column.header, {
          x,
          size: 8,
          font: this.bold,
          color: COLOR.ink,
          maxWidth: column.width - 12,
          align: column.align,
        });
        x += column.width;
      }
      this.y -= 20;
    };

    drawHeader();

    for (const row of rows) {
      if (this.y - 16 < BOTTOM_LIMIT) {
        this.newPage();
        drawHeader();
      }
      let x = MARGIN + 6;
      row.forEach((cell, index) => {
        const column = columns[index];
        this.text(cell, {
          x,
          size,
          color: COLOR.body,
          maxWidth: column.width - 10,
          align: column.align,
        });
        x += column.width;
      });
      this.y -= 5;
      this.rule(COLOR.line, 0.5);
      this.y -= 11;
    }

    if (options.totalRow) {
      this.ensure(22);
      let x = MARGIN + 6;
      options.totalRow.forEach((cell, index) => {
        const column = columns[index];
        this.text(cell, {
          x,
          size: 9,
          font: this.bold,
          color: COLOR.ink,
          maxWidth: column.width - 12,
          align: column.align,
        });
        x += column.width;
      });
      this.y -= 6;
      this.rule(COLOR.ink, 0.75);
      this.y -= 12;
    }

    this.y -= 8;
  }

  private rule(color: ReturnType<typeof rgb>, thickness: number) {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + CONTENT_WIDTH, y: this.y },
      thickness,
      color,
    });
  }

  /** Footers are stamped last, once the total page count is known. */
  finish(report: PipelineReport) {
    this.pages.forEach((page, index) => {
      page.drawLine({
        start: { x: MARGIN, y: 54 },
        end: { x: MARGIN + CONTENT_WIDTH, y: 54 },
        thickness: 0.5,
        color: COLOR.line,
      });
      page.drawText(`${brand.companyName} ${brand.productName} — Executive Pipeline Brief`, {
        x: MARGIN,
        y: 40,
        size: 7.5,
        font: this.regular,
        color: COLOR.muted,
      });
      const label = `Page ${index + 1} of ${this.pages.length}`;
      page.drawText(label, {
        x: MARGIN + CONTENT_WIDTH - this.regular.widthOfTextAtSize(label, 7.5),
        y: 40,
        size: 7.5,
        font: this.regular,
        color: COLOR.muted,
      });
      page.drawText(formatTimestamp(report.generatedAt), {
        x: MARGIN + CONTENT_WIDTH / 2 - 50,
        y: 40,
        size: 7.5,
        font: this.regular,
        color: COLOR.muted,
      });
    });
  }
}

function truncate(value: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = sanitize(value);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let cut = safe;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/**
 * The PDF standard fonts are WinAnsi-encoded, so a character outside that set
 * throws at draw time. Account and project names come from Salesforce and are
 * not under our control, so they are folded rather than trusted.
 */
function sanitize(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    // En/em dash are kept: both exist in WinAnsi, and "—" is the report's
    // marker for a value that genuinely has no data.
    .replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014]/g, "");
}

function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = sanitize(value).split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function formatTimestamp(date: Date): string {
  return date.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

function formatDay(date: Date | null): string {
  if (!date) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Missing data is shown as an em dash — never as a manufactured zero. */
const orDash = (value: number | null, format: (input: number) => string) =>
  value === null ? "—" : format(value);

const count = (value: number) => value.toLocaleString("en-US");

export async function renderExecutiveBrief(report: PipelineReport): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${brand.companyName} ${brand.productName} — Executive Pipeline Brief`);
  doc.setAuthor(`${brand.companyName} ${brand.productName}`);
  doc.setCreationDate(report.generatedAt);

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const brief = new Brief(doc, regular, bold);
  const { summary } = report;

  brief.titleBlock(report);

  // Section 1 — Executive Summary
  brief.heading("1. Executive summary");
  brief.metrics([
    { label: "Open opportunities", value: count(summary.openCount) },
    { label: "Total open pipeline", value: formatReportAmount(summary.openValue) },
    { label: "Past-due opportunities", value: count(summary.pastDueCount) },
    { label: "Past-due pipeline", value: formatReportAmount(summary.pastDueValue) },
    { label: "Selected for engagement", value: orDash(summary.selectedCount, count) },
    { label: "Selected pipeline", value: orDash(summary.selectedValue, formatReportAmount) },
    { label: "Opportunities contacted", value: orDash(summary.contactedCount, count) },
    { label: "Contacted pipeline", value: orDash(summary.contactedValue, formatReportAmount) },
    { label: "Customer responses", value: orDash(summary.responseCount, count) },
    {
      label: "Response rate",
      value: orDash(summary.responseRate, (rate) => `${Math.round(rate * 100)}%`),
    },
  ]);
  brief.note(
    "Open pipeline is the current state held in Salesforce. Selected, contacted and response figures describe engagement activity and are reported separately from pipeline value. Past due means the close date on the record has passed while the opportunity is still open.",
  );

  // Section 2 — Pipeline by Stage
  brief.heading("2. Pipeline by stage");
  brief.table(
    [
      { header: "Stage", width: 240 },
      { header: "Opportunities", width: 130, align: "right" },
      { header: "Pipeline value", width: 134, align: "right" },
    ],
    report.byStage.map((row) => [row.label, count(row.count), formatReportAmount(row.value)]),
    {
      totalRow: [
        "Total open pipeline",
        count(summary.openCount),
        formatReportAmount(summary.openValue),
      ],
    },
  );

  // Section 3 — Pipeline by Sales Rep
  brief.heading("3. Pipeline by sales rep");
  brief.table(
    [
      { header: "Sales rep", width: 240 },
      { header: "Opportunities", width: 130, align: "right" },
      { header: "Pipeline value", width: 134, align: "right" },
    ],
    report.byRep.map((row) => [row.rep, count(row.count), formatReportAmount(row.value)]),
  );
  brief.note(
    "Descriptive distribution of open pipeline by opportunity owner. This is not an evaluation of individual performance.",
  );

  // Section 4 — Engagement Results
  brief.heading("4. Engagement results");
  if (report.campaignName) {
    brief.note(`Campaign: ${report.campaignName}`);
  }
  brief.metrics([
    { label: "Opportunities selected", value: orDash(summary.selectedCount, count) },
    { label: "Pipeline selected", value: orDash(summary.selectedValue, formatReportAmount) },
    { label: "Opportunities contacted", value: orDash(summary.contactedCount, count) },
    { label: "Pipeline contacted", value: orDash(summary.contactedValue, formatReportAmount) },
    { label: "Responses", value: orDash(summary.responseCount, count) },
    {
      label: "Response rate",
      value: orDash(summary.responseRate, (rate) => `${Math.round(rate * 100)}%`),
    },
    { label: "Stage movements observed", value: orDash(summary.stageMovementCount, count) },
    { label: "Close-date changes observed", value: orDash(summary.closeDateChangeCount, count) },
  ]);
  brief.note(
    "Stage movements and close-date changes are movements observed after contact, recorded as separate timestamped facts. No share of pipeline or revenue is claimed to have been caused by this outreach; an attribution methodology has not been defined.",
  );

  // Section 5 — Pipeline Requiring Attention
  brief.heading("5. Pipeline requiring attention");
  if (report.attention.length === 0) {
    brief.note("Every open opportunity has a resolved recipient. Nothing requires attention.");
  } else {
    brief.table(
      [
        { header: "Account", width: 104 },
        { header: "Opportunity", width: 116 },
        { header: "Amount", width: 58, align: "right" },
        { header: "Stage", width: 58 },
        { header: "Close date", width: 70 },
        { header: "Reason", width: 98 },
      ],
      report.attention.map((row) => [
        row.account,
        row.opportunity,
        formatReportAmount(row.amount),
        row.stage,
        formatDay(row.closeDate),
        row.reason,
      ]),
      { size: 8 },
    );
    brief.note(
      "These opportunities cannot be included in a check-in because no recipient could be resolved from the primary contact role in Salesforce. Showing the highest-value items first.",
    );
  }

  brief.finish(report);
  return doc.save();
}
