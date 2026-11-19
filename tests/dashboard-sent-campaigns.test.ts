import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AdminDashboardPage from "@/app/admin/page";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** Sent campaigns sit at the top of the dashboard, above the opportunity queue (Josh, 2026-11-19). */

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/admin",
  useSearchParams: () => new URLSearchParams(),
}));

const render = async () =>
  renderToStaticMarkup(await AdminDashboardPage({ searchParams: Promise.resolve({}) } as never));

describe("dashboard layout", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    session.current = { user: { id: "u1", name: "Admin", email: "admin@example.com", roles: ["SalesOps.Admin"], oid: "oid-1" } };
  });
  afterEach(() => vi.unstubAllEnvs());

  it("shows Sent campaigns above the opportunity queue", async () => {
    await launchCampaignAndCollectTokens("Spring Check-In");
    const html = await render();
    const sent = html.indexOf("Sent campaigns");
    expect(sent).toBeGreaterThan(-1);
    expect(sent).toBeLessThan(html.indexOf("Your opportunity queue"));
    expect(html).toContain("Spring Check-In");
  });

  it("shows no Sent campaigns section before anything is sent", async () => {
    expect(await render()).not.toContain("Sent campaigns");
  });
});
