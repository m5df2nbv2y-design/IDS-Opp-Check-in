import { NextResponse } from "next/server";
import { completeCheckIn } from "@/server/services/response-service";
import {
  countUnresolved,
  rateLimit,
  reportRateLimit,
  tooManyRequests,
} from "@/server/security/rate-limit";

/**
 * Finishes the rep's check-in and kicks off the Salesforce sync.
 * Safe to call twice — a duplicate submit reports `alreadyCompleted`.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/checkin/[token]/complete">,
) {
  const { token } = await context.params;

  // A low ceiling is safe here because completion is legitimately called once.
  const limit = await rateLimit("complete", request.headers, token);
  reportRateLimit(limit);
  if (!limit.allowed) return tooManyRequests(limit);

  const result = await completeCheckIn(token);

  if (result.ok) {
    return NextResponse.json({
      ok: true,
      alreadyCompleted: result.alreadyCompleted,
      submitted: result.submitted,
    });
  }

  if (result.reason === "NOT_FOUND") await countUnresolved(request.headers);

  const status = { NOT_FOUND: 404, INCOMPLETE: 400 }[result.reason];
  return NextResponse.json({ ok: false, reason: result.reason }, { status });
}
