import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { GET as problemsCron } from "@/app/api/cron/problems/route";
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

describe("stuck rows", () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  it("a Salesforce write SYNCING for over 15 minutes counts; one younger does not", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    const [item] = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId } }, take: 1 });
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { sendStatus: "SENT" } });
    // An explicit value overrides @updatedAt.
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { syncStatus: "SYNCING", updatedAt: minutesAgo(14) } });
    expect(await listProblemsNeedingAttention()).toEqual([]);
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { updatedAt: minutesAgo(16) } });
    expect(await listProblemsNeedingAttention()).toEqual([{ campaignId, campaignName: "Spring Check-In", salesforce: 1, invitations: 0 }]);
  });

  it("an invitation PENDING for over 15 minutes counts unless revoked; one younger does not", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { sendStatus: "SENT" } });
    const [r] = await prisma.checkInRecipient.findMany({ where: { campaignId }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: r.id }, data: { sendStatus: "PENDING", createdAt: minutesAgo(14) } });
    expect(await listProblemsNeedingAttention()).toEqual([]);
    await prisma.checkInRecipient.update({ where: { id: r.id }, data: { createdAt: minutesAgo(16) } });
    expect(await listProblemsNeedingAttention()).toEqual([{ campaignId, campaignName: "Spring Check-In", salesforce: 0, invitations: 1 }]);
    await prisma.checkInRecipient.update({ where: { id: r.id }, data: { revokedAt: new Date() } });
    expect(await listProblemsNeedingAttention()).toEqual([]);
  });

  it("a REMINDER_PENDING row counts, since it carries no timestamp to age it by", async () => {
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { sendStatus: "SENT" } });
    const [r] = await prisma.checkInRecipient.findMany({ where: { campaignId }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: r.id }, data: { sendStatus: "REMINDER_PENDING" } });
    expect(await listProblemsNeedingAttention()).toEqual([{ campaignId, campaignName: "Spring Check-In", salesforce: 0, invitations: 1 }]);
  });
});

describe("daily problems alert", () => {
  const call = (authorization?: string) =>
    problemsCron(new Request("https://checkin.test/api/cron/problems", { headers: authorization ? { authorization } : {} }));

  it("is called daily at 15:00 UTC by a Vercel cron", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    expect(config.crons).toContainEqual({ path: "/api/cron/problems", schedule: "0 15 * * *" });
  });

  it("answers 200 ok, never cached, when nothing is open", async () => {
    vi.stubEnv("CRON_SECRET", "cron-synthetic");
    await launchCampaignAndCollectTokens("Spring Check-In");
    await prisma.checkInRecipient.updateMany({ data: { sendStatus: "SENT" } });
    const response = await call("Bearer cron-synthetic");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("compares against the raw CRON_SECRET, as Vercel sends it", async () => {
    vi.stubEnv("CRON_SECRET", " cron-synthetic ");
    // HTTP strips a header value's outer whitespace; the inner space is kept.
    expect((await call("Bearer  cron-synthetic ")).status).toBe(200);
    expect((await call("Bearer cron-synthetic")).status).toBe(401);
  });

  it("answers 500 with counts only when problems are open, so the 5xx alert fires", async () => {
    vi.stubEnv("CRON_SECRET", "cron-synthetic");
    const { campaignId } = await launchCampaignAndCollectTokens("Spring Check-In");
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { sendStatus: "SENT" } });
    const [r] = await prisma.checkInRecipient.findMany({ where: { campaignId }, take: 1 });
    await prisma.checkInRecipient.update({ where: { id: r.id }, data: { sendStatus: "PENDING", createdAt: new Date(Date.now() - 16 * 60_000) } });
    const [item] = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId } }, take: 1 });
    await prisma.checkInOpportunity.update({ where: { id: item.id }, data: { syncStatus: "FAILED", submittedAt: new Date() } });
    const response = await call("Bearer cron-synthetic");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "problems", salesforce: 1, invitations: 1 });
    expect(body).not.toContain(campaignId);
    expect(body).not.toContain("Spring");
  });

  it.each([
    ["no header", "cron-synthetic", undefined],
    ["a wrong bearer", "cron-synthetic", "Bearer wrong"],
    ["CRON_SECRET unset", "", "Bearer "],
    ["CRON_SECRET unset, a guessed value", "", "Bearer undefined"],
    ["a whitespace-only CRON_SECRET", "  ", "Bearer   "],
  ])("answers 401 with no counts and no database read for %s", async (_label, secret, authorization) => {
    vi.stubEnv("CRON_SECRET", secret);
    const read = vi.spyOn(prisma.checkInRecipient, "findMany");
    const response = await call(authorization);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ status: "unauthorized" });
    expect(read).not.toHaveBeenCalled();
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
