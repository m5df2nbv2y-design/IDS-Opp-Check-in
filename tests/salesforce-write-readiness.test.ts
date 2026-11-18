import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/db";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import type { SalesforceWriteReadiness } from "@/server/integrations/salesforce";
import { resetDatabase } from "./fixtures";

/**
 * The read-only write-readiness check on /admin/salesforce. Before writes are
 * switched on, it shows whether the integration user can edit the fields and
 * the cached open opportunities a campaign would touch — without writing.
 */

vi.mock("@/server/integrations/salesforce/live/auth", async (original) => ({
  ...(await original<typeof import("@/server/integrations/salesforce/live/auth")>()),
  requestAccessToken: vi.fn(async () => ({
    accessToken: "synthetic-token-SECRET",
    instanceUrl: "https://secret-instance.example.invalid",
    identityUrl: null,
  })),
}));

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const live = vi.hoisted(() => ({
  on: false,
  calls: 0,
  result: null as null | ((ids: string[]) => SalesforceWriteReadiness),
  fail: null as string | null,
}));
vi.mock("@/server/integrations/salesforce", async (original) => {
  const real = await original<typeof import("@/server/integrations/salesforce")>();
  return {
    ...real,
    getSalesforceService: () =>
      live.on
        ? {
            info: { id: "salesforce", label: "Salesforce / SFX", simulated: false, description: "" },
            checkWriteReadiness: async (ids: string[]) => {
              live.calls += 1;
              if (live.fail) throw new Error(live.fail);
              return live.result!(ids);
            },
          }
        : real.getSalesforceService(),
  };
});

import SalesforcePage from "@/app/admin/salesforce/page";

const ADMIN = { user: { id: "u1", name: "Admin", email: "admin@example.com", roles: ["SalesOps.Admin"], oid: "oid-1" } };
const FIELDS = ["StageName", "CloseDate", "Probability"].map((name) => ({ name, updateable: true }));

const render = async (params: Record<string, string> = {}) =>
  renderToStaticMarkup(await SalesforcePage({ searchParams: Promise.resolve(params) } as never));

// -- the service method ------------------------------------------------------

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

async function liveService() {
  vi.resetModules();
  const mod = await import("@/server/integrations/salesforce/live/salesforce-service");
  return new mod.LiveSalesforceService();
}

function orgFetch(options: { describeFails?: boolean; stageUpdateable?: boolean; blocked?: Set<string>; noUserId?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    const target = String(url);
    if (target.includes("/userinfo")) {
      return json(options.noUserId ? { preferred_username: "integration@ids.example" } : { user_id: "005INTEGRATION", preferred_username: "integration@ids.example" });
    }
    if (target.includes("/describe")) {
      if (options.describeFails) return new Response('[{"errorCode":"NOT_FOUND","message":"nope"}]', { status: 404 });
      return json({
        fields: [
          { name: "StageName", updateable: options.stageUpdateable ?? true },
          { name: "CloseDate", updateable: true },
          { name: "Probability", updateable: true },
          { name: "Loss_Reason__c", updateable: true },
        ],
      });
    }
    const soql = decodeURIComponent(target.split("q=")[1] ?? "");
    const ids = [...soql.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((id) => id !== "005INTEGRATION");
    return json({ done: true, records: ids.map((id) => ({ RecordId: id, HasEditAccess: !options.blocked?.has(id) })) });
  });
}

describe("LiveSalesforceService.checkWriteReadiness", () => {
  beforeEach(() => vi.stubEnv("SALESFORCE_PROVIDER", "salesforce"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("makes only GET requests and reports the user, fields and per-id access", async () => {
    vi.stubEnv("SF_FIELD_LOSS_REASON", "Loss_Reason__c");
    const fetchMock = orgFetch({ blocked: new Set(["006B"]) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await (await liveService()).checkWriteReadiness(["006A", "006B"]);

    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]) {
      expect(call[1]?.method ?? "GET").toBe("GET");
      expect(call[1]?.body).toBeUndefined();
    }
    expect(result.username).toBe("integration@ids.example");
    expect(result.fields.map((f) => f.name)).toEqual(["StageName", "CloseDate", "Probability", "Loss_Reason__c"]);
    expect(result.editable).toEqual({ "006A": true, "006B": false });
  });

  it("asks UserRecordAccess for at most 200 record ids at a time, escaped", async () => {
    const fetchMock = orgFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 450 }, (_, i) => `006${i}`);
    ids.push("006'x");
    const result = await (await liveService()).checkWriteReadiness(ids);

    const queries = fetchMock.mock.calls
      .map((call) => decodeURIComponent(String(call[0]).split("q=")[1] ?? ""))
      .filter((soql) => soql.includes("UserRecordAccess"));
    expect(queries).toHaveLength(3);
    for (const soql of queries) expect(soql.split("RecordId IN (")[1].split(",").length).toBeLessThanOrEqual(200);
    expect(queries[2]).toContain("'006\\'x'");
    for (const soql of queries) expect(soql).toContain("UserId = '005INTEGRATION'");
    expect(Object.keys(result.editable)).toHaveLength(451);
  });

  it("marks a field the org will not let it update", async () => {
    vi.stubGlobal("fetch", orgFetch({ stageUpdateable: false }));
    const result = await (await liveService()).checkWriteReadiness([]);
    expect(result.fields[0]).toEqual({ name: "StageName", updateable: false });
    expect(result.fields.map((f) => f.name)).not.toContain("");
  });

  it("treats userinfo without a user id as an identity failure, after one fresh-token retry", async () => {
    const fetchMock = orgFetch({ noUserId: true });
    vi.stubGlobal("fetch", fetchMock);
    await expect((await liveService()).checkWriteReadiness(["006A"])).rejects.toThrow(/Identifying the integration user failed/);
    const urls = fetchMock.mock.calls.map((call) => decodeURIComponent(String(call[0])));
    expect(urls.filter((url) => url.includes("/userinfo"))).toHaveLength(2);
    expect(urls.some((url) => url.includes("UserRecordAccess"))).toBe(false);
  });

  it("trims and de-duplicates the configured loss-reason field", async () => {
    vi.stubEnv("SF_FIELD_LOSS_REASON", " Probability ");
    vi.stubGlobal("fetch", orgFetch());
    const result = await (await liveService()).checkWriteReadiness([]);
    expect(result.fields.map((f) => f.name)).toEqual(["StageName", "CloseDate", "Probability"]);
  });

  it("names the step that failed", async () => {
    vi.stubGlobal("fetch", orgFetch({ describeFails: true }));
    await expect((await liveService()).checkWriteReadiness(["006A"])).rejects.toThrow(/Opportunity Describe failed/);
  });
});

// -- the page ----------------------------------------------------------------

describe("/admin/salesforce write readiness", () => {
  let openIds: string[] = [];
  let firstOwner = "";

  beforeEach(async () => {
    live.on = false;
    await resetDatabase();
    await refreshCatalogFromSalesforce();
    const open = await prisma.opportunity.findMany({ where: { isOpen: true }, include: { internalRep: true }, orderBy: { externalId: "asc" } });
    openIds = open.map((o) => o.externalId);
    firstOwner = open[0].internalRep.name;
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    vi.stubEnv("SF_CLIENT_ID", "client-id-SECRET");
    vi.stubEnv("SF_CLIENT_SECRET", "client-secret-SECRET");
    session.current = ADMIN;
    live.on = true;
    live.calls = 0;
    live.fail = null;
    live.result = (ids) => ({ username: "integration@ids.example", fields: FIELDS, editable: Object.fromEntries(ids.map((id) => [id, true])) });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("without ?check=1 shows the switches and a Run check link, and calls nothing", async () => {
    const html = await render();
    expect(html).toContain("Run check");
    expect(html).toContain("/admin/salesforce?check=1");
    expect(html).toContain("SALESFORCE_WRITE_ENABLED");
    expect(live.calls).toBe(0);
  });

  it("all editable: N of N with a ready message", async () => {
    const html = await render({ check: "1" });
    expect(html).toContain("integration@ids.example");
    expect(html).toContain(`${openIds.length} of ${openIds.length} open opportunities editable`);
    expect(html).toContain("Ready:");
  });

  it("some blocked: X of N and the blocked owners", async () => {
    live.result = (ids) => ({ username: "u", fields: FIELDS, editable: Object.fromEntries(ids.map((id) => [id, id !== openIds[0]])) });
    const html = await render({ check: "1" });
    expect(html).toContain(`${openIds.length - 1} of ${openIds.length} open opportunities editable`);
    expect(html).toContain(`${firstOwner}: 1 not editable`);
    expect(html).toContain("Not ready");
  });

  it("empty cache: 0 of 0, a refresh prompt, not ready", async () => {
    await prisma.opportunity.updateMany({ data: { isOpen: false } });
    const html = await render({ check: "1" });
    expect(html).toContain("0 of 0 open opportunities editable");
    expect(html).toContain("the cache is empty");
    expect(html).toContain("Not ready");
  });

  it("an open id Salesforce did not answer for counts as not editable", async () => {
    live.result = (ids) => ({ username: "u", fields: FIELDS, editable: Object.fromEntries(ids.slice(1).map((id) => [id, true])) });
    const html = await render({ check: "1" });
    expect(html).toContain(`${openIds.length - 1} of ${openIds.length} open opportunities editable`);
    expect(html).toContain("Not ready");
  });

  it("Probability off: labelled not written and not required", async () => {
    live.result = (ids) => ({ username: "u", fields: [...FIELDS.slice(0, 2), { name: "Probability", updateable: false }], editable: Object.fromEntries(ids.map((id) => [id, true])) });
    const html = await render({ check: "1" });
    expect(html).toContain("not written");
    expect(html).toContain("Ready:");
  });

  it("a field that is not updateable makes it not ready", async () => {
    live.result = (ids) => ({ username: "u", fields: [{ name: "StageName", updateable: false }], editable: Object.fromEntries(ids.map((id) => [id, true])) });
    const html = await render({ check: "1" });
    expect(html).toContain("not editable");
    expect(html).toContain("Not ready");
  });

  it("shows an unset loss reason field as not configured", async () => {
    // env is read at import; the suite runs with SF_FIELD_LOSS_REASON unset.
    expect(await render()).toContain("not configured");
  });

  it("shows a Salesforce failure as a message, without URLs", async () => {
    live.fail = "Reading the Opportunity Describe failed: 404 at https://secret-instance.example.invalid/x";
    const html = await render({ check: "1" });
    expect(html).toContain("Reading the Opportunity Describe failed");
    expect(html).not.toContain("secret-instance");
  });

  it("never renders a secret", async () => {
    const html = await render({ check: "1" });
    for (const secret of ["client-id-SECRET", "client-secret-SECRET", "synthetic-token-SECRET", "secret-instance"]) {
      expect(html).not.toContain(secret);
    }
  });

  it("mock provider: the mock view plus switches and a live-org note", async () => {
    live.on = false;
    const html = await render({ check: "1" });
    expect(html).toContain("Mock Salesforce org");
    expect(html).toContain("SALESFORCE_WRITE_ENABLED");
    expect(html).toContain("needs the live Salesforce org");
    expect(html).not.toContain("open opportunities editable");
    expect(live.calls).toBe(0);
  });

  describe("with the write switches set (env re-read on import)", () => {
    const renderFresh = async () => {
      vi.resetModules();
      const page = (await import("@/app/admin/salesforce/page")).default;
      return renderToStaticMarkup(await page({ searchParams: Promise.resolve({ check: "1" }) } as never));
    };

    it("shows the switches on and the field name, and is ready when the field is editable", async () => {
      vi.stubEnv("SALESFORCE_WRITE_ENABLED", "true");
      vi.stubEnv("SF_WRITE_CLOSED_LOST", "true");
      vi.stubEnv("SF_FIELD_LOSS_REASON", "Loss_Reason__c");
      live.result = (ids) => ({ username: "u", fields: [...FIELDS, { name: "Loss_Reason__c", updateable: true }], editable: Object.fromEntries(ids.map((id) => [id, true])) });
      const html = await renderFresh();
      expect(html).toContain("SALESFORCE_WRITE_ENABLED): <span class=\"font-semibold text-ink\">on</span>");
      expect(html).toContain("SF_WRITE_CLOSED_LOST): <span class=\"font-semibold text-ink\">on</span>");
      expect(html).toContain("Loss_Reason__c");
      expect(html).toContain("Ready:");
    });

    it("Closed Lost on with the loss-reason field not editable is not ready", async () => {
      vi.stubEnv("SF_WRITE_CLOSED_LOST", "true");
      vi.stubEnv("SF_FIELD_LOSS_REASON", "Loss_Reason__c");
      live.result = (ids) => ({ username: "u", fields: [...FIELDS, { name: "Loss_Reason__c", updateable: false }], editable: Object.fromEntries(ids.map((id) => [id, true])) });
      expect(await renderFresh()).toContain("Not ready");
    });

    it("Closed Lost on with the loss-reason field unset is not ready, with the reason", async () => {
      vi.stubEnv("SF_WRITE_CLOSED_LOST", "true");
      vi.stubEnv("SF_FIELD_LOSS_REASON", "");
      const html = await renderFresh();
      expect(html).toContain("Closed Lost is on but SF_FIELD_LOSS_REASON is not configured");
      expect(html).toContain("Not ready");
    });
  });

  it("not admin: redirected before any check runs", async () => {
    session.current = null;
    await expect(render({ check: "1" })).rejects.toThrow(/REDIRECT/);
    expect(live.calls).toBe(0);
  });
});
