import { renderExecutiveBrief } from "@/server/reports/executive-brief-pdf";
import { authorizeExport } from "@/server/reports/authorize-export";
import { buildPipelineReport } from "@/server/services/report-service";

// pdf-lib and the Prisma client both need the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authorizeExport("Executive Pipeline Brief");
  if (!guard.ok) return guard.response;

  const report = await buildPipelineReport();
  const pdf = await renderExecutiveBrief(report);

  return new Response(pdf as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition":
        'attachment; filename="IDS-Opportunity-Check-In-Executive-Pipeline-Brief.pdf"',
      "Cache-Control": "no-store",
    },
  });
}
