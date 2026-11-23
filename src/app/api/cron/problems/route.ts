import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { listProblemsNeedingAttention } from "@/server/services/attention-service";

export const dynamic = "force-dynamic";

/**
 * Called daily at 15:00 UTC by a Vercel cron (vercel.json). Open problems answer
 * 500, a Production 5xx, so the existing Vercel alert emails the team owner once
 * a day. Vercel sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET is
 * set; anyone else, or any call while it is unset, gets 401 and never a 5xx, so
 * the route cannot be used to trigger alerts. The body carries counts only.
 */
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  // Raw value, as Vercel sends it; only the outer whitespace HTTP strips from
  // a header value is trimmed. Trim also decides whether it is blank.
  const secret = process.env.CRON_SECRET ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!secret.trim() || !timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`.trim()))) {
    return NextResponse.json({ status: "unauthorized" }, { status: 401, headers });
  }
  const problems = await listProblemsNeedingAttention();
  if (problems.length === 0) return NextResponse.json({ status: "ok" }, { headers });
  const sum = (key: "salesforce" | "invitations") => problems.reduce((total, p) => total + p[key], 0);
  return NextResponse.json({ status: "problems", salesforce: sum("salesforce"), invitations: sum("invitations") }, { status: 500, headers });
}
