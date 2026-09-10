import { renderPipelineWorkbook } from "@/server/reports/pipeline-workbook";
import { authorizeExport } from "@/server/reports/authorize-export";
import { buildPipelineReport } from "@/server/services/report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authorizeExport("Pipeline Data Export");
  if (!guard.ok) return guard.response;

  const report = await buildPipelineReport();
  const workbook = await renderPipelineWorkbook(report);

  return new Response(workbook as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="IDS-Opportunity-Check-In-Pipeline-Report.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
