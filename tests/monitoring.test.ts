import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import AdminDashboardPage from "@/app/admin/page";
import { prisma } from "@/lib/db";
import { listProblemsNeedingAttention } from "@/server/services/attention-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** Monitoring (Josh, 2026-11-19): a health check Vercel can alert on, and a dashboard banner for problems. */

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
  session.current = { user: { id: "u1", name: "Admin", email: "admin@example.com", roles: ["SalesOps.Admin"], oid: "oid-1" } };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("health check", () => {
  it("answers 200 ok when the database responds, and is never cached", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("answers 503 with no detail when the database fails, so the 5xx alert fires", async () => {
    vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("connect ECONNREFUSED postgres://user:secret@db"));
    const response = await health();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "error" });
    expect(body).not.toContain("secret");
  });

  it("is called hourly by a Vercel cron", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(config.crons).toContainEqual({ path: "/api/health", schedule: "0 * * * *" });
  });
});

describe("problems needing attention", () => {
  async function campaignWithProblems() {
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    const recipients = await prisma.checkInRecipient.findMany({ where: { campaignId }, orderBy: { id: "asc" } });
    await prisma.checkInRecipient.update({ where: { id: recipients[0].id }, data: { sendStatus: "FAILED" } });
    await prisma.checkInRecipient.update({ where: { id: recipients[1].id }, data: { sendStatus: "UNCERTAIN" } });
    const items = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId } }, orderBy: { id: "asc" } });
    await prisma.checkInOpportunity.update({ where: { id: items[0].id }, data: { syncStatus: "FAILED", submittedAt: new Date() } });
    return { campaignId, recipients, items };
  }

  it("counts failed or unknown Salesforce updates and invitations per campaign", async () => {
    const { campaignId } = await campaignWithProblems();
    expect(await listProblemsNeedingAttention()).toEqual([
      { campaignId, campaignName: "Spring Check-In", salesforce: 1, invitations: 2 },
    ]);
  });

  it("ignores revoked links, healthy rows and clean campaigns", async () => {
    const { campaignId, recipients, items } = await campaignWithProblems();
    await prisma.checkInRecipient.update({ where: { id: recipients[0].id }, data: { revokedAt: new Date() } });
    await prisma.checkInOpportunity.update({ where: { id: items[0].id }, data: { syncStatus: "SYNCED" } });
    expect(await listProblemsNeedingAttention()).toEqual([
      { campaignId, campaignName: "Spring Check-In", salesforce: 0, invitations: 1 },
    ]);
    await prisma.checkInRecipient.update({ where: { id: recipients[1].id }, data: { sendStatus: "SENT" } });
    expect(await listProblemsNeedingAttention()).toEqual([]);
  });

  it("counts an unknown reminder and an UNCERTAIN Salesforce write", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    const [recipient] = await prisma.checkInRecipient.findMany({ where: { campaignId }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: recipient.id }, data: { sendStatus: "REMINDER_UNCERTAIN" } });
    const [item] = await prisma.checkInOpportunity.findMany({ where: { recipientId: recipient.id }, take: 1 });
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { syncStatus: "UNCERTAIN", submittedAt: new Date() } });
    expect(await listProblemsNeedingAttention()).toEqual([
      { campaignId, campaignName: "Spring Check-In", salesforce: 1, invitations: 1 },
    ]);
  });
});

describe("dashboard banner", () => {
  const render = async () => renderToStaticMarkup(await AdminDashboardPage({ searchParams: Promise.resolve({}) } as never));

  it("lists each campaign's problems with a link, above Sent campaigns", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    const [recipient] = await prisma.checkInRecipient.findMany({ where: { campaignId }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: recipient.id }, data: { sendStatus: "FAILED" } });
    const html = await render();
    expect(html).toContain("Problems to fix");
    expect(html).toContain(`href="/admin/campaigns/${campaignId}"`);
    expect(html).toContain("1 invitation failed or unknown");
    expect(html.indexOf("Problems to fix")).toBeLessThan(html.indexOf("Sent campaigns"));
  });

  it("joins both kinds of problem, and keeps two campaigns apart, newest first", async () => {
    const first = await launchCampaignAndCollectTokens("Spring Check-In");
    const [item] = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId: first.campaignId } }, take: 1 });
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { syncStatus: "FAILED", submittedAt: new Date() } });
    const [r1] = await prisma.checkInRecipient.findMany({ where: { campaignId: first.campaignId }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: r1.id }, data: { sendStatus: "UNCERTAIN" } });
    const second = await launchCampaignAndCollectTokens("Fall Check-In");
    const [r2] = await prisma.checkInRecipient.findMany({ where: { campaignId: second.campaignId }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: r2.id }, data: { sendStatus: "FAILED" } });

    expect((await listProblemsNeedingAttention()).map((p) => [p.campaignName, p.salesforce, p.invitations])).toEqual([
      ["Fall Check-In", 0, 1],
      ["Spring Check-In", 1, 1],
    ]);
    expect(await render()).toContain("1 Salesforce update failed or unconfirmed · 1 invitation failed or unknown");
  });

  it("a failed Salesforce write on a revoked link still counts", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    const [r] = await prisma.checkInRecipient.findMany({ where: { campaignId }, take: 1 });
    const [item] = await prisma.checkInOpportunity.findMany({ where: { recipientId: r.id }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: r.id }, data: { revokedAt: new Date(), sendStatus: "FAILED" } });
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { syncStatus: "FAILED", submittedAt: new Date() } });
    expect(await listProblemsNeedingAttention()).toEqual([{ campaignId, campaignName: "Spring Check-In", salesforce: 1, invitations: 0 }]);
  });

  it("shows no banner when nothing needs fixing", async () => {
    await launchCampaignAndCollectTokens("Spring Check-In");
    expect(await render()).not.toContain("Problems to fix");
  });
});
