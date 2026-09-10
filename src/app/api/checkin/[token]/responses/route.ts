import { NextResponse } from "next/server";
import { saveResponse } from "@/server/services/response-service";

/** Saves one opportunity answer as the rep advances through their check-in. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/checkin/[token]/responses">,
) {
  const { token } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    itemId?: string;
    stage?: string;
    comment?: string | null;
    closeDate?: string | null;
  } | null;

  if (!body?.itemId || !body?.stage) {
    return NextResponse.json({ error: "itemId and stage are required." }, { status: 400 });
  }

  const result = await saveResponse({
    token,
    itemId: body.itemId,
    stage: body.stage,
    comment: body.comment ?? null,
    closeDate: body.closeDate ?? null,
  });

  if (result.ok) {
    return NextResponse.json({ ok: true, revised: result.revised });
  }

  const status = { NOT_FOUND: 404, ALREADY_COMPLETED: 409, INVALID_STAGE: 400 }[result.reason];
  return NextResponse.json({ ok: false, reason: result.reason }, { status });
}
