import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { refreshCatalogFromSalesforce, getLastCatalogRefresh } from "@/server/services/catalog-service";
import { LastRefreshed } from "@/components/admin/last-refreshed";
import { resetDatabase } from "./fixtures";

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
const salesforce = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/integrations/salesforce", async (original) => {
  const real = await original<typeof import("@/server/integrations/salesforce")>();
  return { ...real, getSalesforceService: () => {
    const service = real.getSalesforceService();
    return salesforce.fail ? Object.assign(Object.create(service), { getSalesReps: async () => { throw new Error("Salesforce down"); } }) : service;
  } };
});
import { refreshCatalogAction, refreshDiscoveryAction } from "@/app/admin/actions";

/** "Refresh from Salesforce" must say when it last ran and what it pulled. */

describe("last Salesforce refresh", () => {
  beforeEach(async () => {
    await resetDatabase();
    salesforce.fail = false;
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    session.current = { user: { id: "u1", name: "Admin", email: "admin@example.com", roles: ["SalesOps.Admin"], oid: "oid-1" } };
  });

  it("reports nothing before the first refresh", async () => {
    await prisma.auditEvent.deleteMany({ where: { type: AUDIT_EVENTS.CATALOG_REFRESHED } });
    expect(await getLastCatalogRefresh()).toBeNull();
    expect(renderToStaticMarkup(LastRefreshed({ last: null }))).toContain("Not refreshed yet");
  });

  it("returns the newest refresh, with its time and what it pulled", async () => {
    await prisma.auditEvent.deleteMany({ where: { type: AUDIT_EVENTS.CATALOG_REFRESHED } });
    await prisma.auditEvent.create({ data: { type: AUDIT_EVENTS.CATALOG_REFRESHED, summary: "Pulled 1 old", actor: "a", actorKind: "SYSTEM", createdAt: new Date("2026-01-01T10:00:00Z") } });
    await prisma.auditEvent.create({ data: { type: AUDIT_EVENTS.CATALOG_REFRESHED, summary: "Pulled 1145 open opportunities across 982 organizations from Salesforce / SFX", actor: "a", actorKind: "SYSTEM", createdAt: new Date("2026-11-18T21:53:32Z") } });
    const last = await getLastCatalogRefresh();
    expect(last?.summary).toContain("1145 open opportunities");
    const html = renderToStaticMarkup(LastRefreshed({ last }));
    expect(html).toContain("Last refreshed");
    expect(html).toContain("Nov 18, 2:53 PM MST");
    expect(html).toContain("Pulled 1145 open opportunities across 982 organizations");
    expect(html).not.toContain("Pulled 1 old");
  });

  it("a refresh is immediately reported as the latest", async () => {
    const before = new Date();
    await refreshCatalogFromSalesforce("josh@example.com");
    const last = await getLastCatalogRefresh();
    expect(last).not.toBeNull();
    expect(last!.at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(last!.summary).toMatch(/^Pulled \d+ open opportunities across \d+ organizations/);
  });

  it("both refresh buttons show the line", () => {
    for (const page of ["src/app/admin/page.tsx", "src/app/admin/organizations/page.tsx"]) {
      const source = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
      expect(source).toContain("<LastRefreshed");
      expect(source).toContain("getLastCatalogRefresh()");
    }
  });

  it("a failed refresh comes back as a message, and the last success stays shown", async () => {
    const before = await getLastCatalogRefresh();
    salesforce.fail = true;
    for (const action of [refreshDiscoveryAction, refreshCatalogAction]) {
      const result = await action();
      expect(result).toEqual({ error: expect.stringContaining("didn't finish") });
    }
    expect(await getLastCatalogRefresh()).toEqual(before);
  });

  it("a successful refresh returns no message", async () => {
    expect(await refreshDiscoveryAction()).toBeUndefined();
  });
});
