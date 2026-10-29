import { NextResponse } from "next/server";
import { saveResponse } from "@/server/services/response-service";
import {
  countUnresolved,
  maybeSweep,
  rateLimit,
  reportRateLimit,
  tooManyRequests,
} from "@/server/security/rate-limit";

/** Saves one opportunity answer as the rep advances through their check-in. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/checkin/[token]/responses">,
) {
  const { token } = await context.params;

  // Counted before the body is parsed, so a flood of malformed posts is
  // bounded too rather than only the well-formed ones.
  const limit = await rateLimit("save", request.headers, token);
  reportRateLimit(limit);
  maybeSweep();
  if (!limit.allowed) return tooManyRequests(limit);

  const body = (await request.json().catch(() => null)) as {
    itemId?: string;
    stage?: string;
    comment?: string | null;
    closeDate?: string | null;
    lossReason?: string | null;
    flowVersion?: number;
  } | null;

  if (!body || typeof body.itemId !== "string" || typeof body.stage !== "string" ||
      (body.comment != null && typeof body.comment !== "string") ||
      (body.closeDate != null && typeof body.closeDate !== "string") ||
      (body.lossReason != null && typeof body.lossReason !== "string") ||
      (body.flowVersion != null && body.flowVersion !== 2)) {
    return NextResponse.json({ error: "itemId and stage are required." }, { status: 400 });
  }

  const result = await saveResponse({
    token,
    itemId: body.itemId,
    stage: body.stage,
    comment: body.comment ?? null,
    closeDate: body.closeDate ?? null,
    lossReason: body.lossReason ?? null,
    flowVersion: body.flowVersion,
  });

  if (result.ok) {
    return NextResponse.json({ ok: true, revised: result.revised });
  }

  // A token that resolved to nothing is the abuse case, and it is only
  // knowable here, after the lookup. Counted on its own tighter ceiling so
  // the save limit above can stay loose enough never to catch a real
  // recipient working quickly.
  if (result.reason === "NOT_FOUND") await countUnresolved(request.headers);

  const status = {
    NOT_FOUND: 404,
    ALREADY_COMPLETED: 409,
    INVALID_STAGE: 400,
    REASON_REQUIRED: 400,
    INVALID_CLOSE_DATE: 400,
    INVALID_LOSS_REASON: 400,
  }[result.reason];
  return NextResponse.json({ ok: false, reason: result.reason }, { status });
}
