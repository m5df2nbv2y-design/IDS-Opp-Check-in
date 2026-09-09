import { NextResponse } from "next/server";
import { completeCheckIn } from "@/server/services/response-service";

/**
 * Finishes the rep's check-in and kicks off the Salesforce sync.
 * Safe to call twice — a duplicate submit reports `alreadyCompleted`.
 */
export async function POST(
  _request: Request,
  context: RouteContext<"/api/checkin/[token]/complete">,
) {
  const { token } = await context.params;
  const result = await completeCheckIn(token);

  if (result.ok) {
    return NextResponse.json({
      ok: true,
      alreadyCompleted: result.alreadyCompleted,
      submitted: result.submitted,
    });
  }

  const status = { NOT_FOUND: 404, INCOMPLETE: 400 }[result.reason];
  return NextResponse.json({ ok: false, reason: result.reason }, { status });
}
