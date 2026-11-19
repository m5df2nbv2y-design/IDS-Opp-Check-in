import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Called hourly by a Vercel cron (vercel.json). A 503 here is a Production 5xx,
 * which the Vercel alert rule emails to the team owner, so an outage is noticed
 * even when nobody is using the app. The body never carries error detail.
 * Public on purpose, so an external uptime checker can use it too; it does one
 * SELECT 1 and reveals nothing.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { headers });
  } catch {
    return NextResponse.json({ status: "error" }, { status: 503, headers });
  }
}
