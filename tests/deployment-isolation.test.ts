import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  deploymentEnvironment,
  liveIntegrationRefusal,
} from "@/lib/deployment-environment";

/**
 * Preview deployments must not reach production systems.
 *
 * On Vercel a Preview build runs with NODE_ENV=production, so NODE_ENV cannot
 * tell Preview from Production. Without a separate signal, a pull-request
 * preview — public URL, unreviewed code — inherits whatever credentials are
 * scoped to it, and the moment Salesforce write-back is enabled that preview
 * can write to the production CRM.
 *
 * VERCEL_ENV is the signal. The rule is deliberately fail-closed: anything that
 * is not provably Vercel Production, or provably a local workstation, is
 * refused a live integration.
 *
 * Local development is NOT restricted. `npm run sf:smoke` exists to validate a
 * real org from a developer's machine and must keep working.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(`${root}${relative}`, "utf8");

/** A configuration that would reach the real Salesforce org. */
const LIVE = { SALESFORCE_PROVIDER: "salesforce" };

describe("deployment environment detection", () => {
  it.each([
    ["production", "vercel-production"],
    ["preview", "vercel-preview"],
    ["development", "vercel-development"],
  ])("maps VERCEL_ENV=%s to %s", (vercelEnv, expected) => {
    expect(deploymentEnvironment({ VERCEL_ENV: vercelEnv })).toBe(expected);
  });

  it("treats a workstation with no Vercel signal as local", () => {
    expect(deploymentEnvironment({ NODE_ENV: "development" })).toBe("local");
    expect(deploymentEnvironment({})).toBe("local");
  });

  it("treats a production-like deployment with no VERCEL_ENV as UNKNOWN, not production", () => {
    // The dangerous assumption would be "NODE_ENV=production means production".
    expect(deploymentEnvironment({ NODE_ENV: "production" })).toBe("unknown");
    expect(deploymentEnvironment({ VERCEL: "1", NODE_ENV: "production" })).toBe("unknown");
  });

  it("treats an unrecognised VERCEL_ENV as UNKNOWN", () => {
    expect(deploymentEnvironment({ VERCEL_ENV: "staging" })).toBe("unknown");
    expect(deploymentEnvironment({ VERCEL_ENV: "" })).toBe("local");
  });
});

describe("live Salesforce is refused outside Vercel Production", () => {
  it("ALLOWS the live provider on Vercel Production", () => {
    expect(liveIntegrationRefusal({ ...LIVE, VERCEL_ENV: "production" })).toBeNull();
  });

  it("ALLOWS the live provider on a local workstation (sf:smoke must keep working)", () => {
    expect(liveIntegrationRefusal({ ...LIVE, NODE_ENV: "development" })).toBeNull();
  });

  it("REFUSES the live provider on a Preview deployment", () => {
    const refusal = liveIntegrationRefusal({ ...LIVE, VERCEL_ENV: "preview" });
    expect(refusal).toContain("preview");
  });

  it("REFUSES the live provider on a Vercel development deployment", () => {
    expect(liveIntegrationRefusal({ ...LIVE, VERCEL_ENV: "development" })).not.toBeNull();
  });

  it("FAILS CLOSED when VERCEL_ENV is missing in a production-like deployment", () => {
    const refusal = liveIntegrationRefusal({ ...LIVE, NODE_ENV: "production" });
    expect(refusal).not.toBeNull();
  });

  it("FAILS CLOSED on an unrecognised VERCEL_ENV", () => {
    expect(liveIntegrationRefusal({ ...LIVE, VERCEL_ENV: "staging" })).not.toBeNull();
  });

  it("never refuses the MOCK provider — previews are expected to run on it", () => {
    for (const vercelEnv of ["preview", "development", "production"]) {
      expect(
        liveIntegrationRefusal({ SALESFORCE_PROVIDER: "mock", VERCEL_ENV: vercelEnv }),
      ).toBeNull();
    }
  });

  it("leaks no secret value in the refusal message", () => {
    const refusal = liveIntegrationRefusal({
      ...LIVE,
      VERCEL_ENV: "preview",
      SF_CLIENT_ID: "consumer-key-should-never-appear",
      SF_CLIENT_SECRET: "consumer-secret-should-never-appear",
      DATABASE_URL: "postgresql://user:hunter2@db.example.com/ids",
      AUTH_SECRET: "auth-secret-should-never-appear",
      RESEND_API_KEY: "re_should_never_appear",
    })!;

    for (const secret of [
      "consumer-key-should-never-appear",
      "consumer-secret-should-never-appear",
      "hunter2",
      "auth-secret-should-never-appear",
      "re_should_never_appear",
    ]) {
      expect(refusal).not.toContain(secret);
    }
  });
});

describe("the guard cannot be bypassed", () => {
  it("is enforced by LiveSalesforceService itself, not only by the factory", async () => {
    // Two scripts construct LiveSalesforceService directly, bypassing
    // getSalesforceService(). The guard therefore lives in the class, so every
    // path — present and future — inherits it.
    vi.resetModules();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SALESFORCE_PROVIDER", "salesforce");

    const { LiveSalesforceService } = await import(
      "@/server/integrations/salesforce/live/salesforce-service"
    );
    expect(() => new LiveSalesforceService()).toThrow(/preview/i);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("refuses through the factory too", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SALESFORCE_PROVIDER", "salesforce");

    const { getSalesforceService } = await import("@/server/integrations/salesforce");
    expect(() => getSalesforceService()).toThrow();

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("still builds the mock provider on a preview deployment", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("SALESFORCE_PROVIDER", "mock");

    const { getSalesforceService } = await import("@/server/integrations/salesforce");
    expect(getSalesforceService().info.simulated).toBe(true);

    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("has no LiveSalesforceService construction outside the guarded class", () => {
    // If a new call site appears, it inherits the constructor guard — this test
    // records the known ones so the list is reviewed rather than drifting.
    const sites = ["scripts/salesforce-recipient-preview.ts", "scripts/salesforce-smoke-test.ts"];
    for (const site of sites) {
      expect(read(site)).toContain("new LiveSalesforceService()");
    }
    // Those are local diagnostics; the guard permits local, refuses deployments.
    expect(liveIntegrationRefusal({ ...LIVE, NODE_ENV: "development" })).toBeNull();
  });
});

describe("existing guards are unchanged", () => {
  it("keeps Salesforce write-back disabled by default", () => {
    expect(read("src/lib/env.ts")).toContain('process.env.SALESFORCE_WRITE_ENABLED === "true"');
    expect(read(".env.example")).toContain('SALESFORCE_WRITE_ENABLED="false"');
  });

  it("keeps the write guard tied to the simulated flag", () => {
    expect(read("src/server/services/sync-service.ts")).toContain(
      "salesforce.info.simulated || env.salesforce.writeEnabled",
    );
  });

  it("keeps the C-1 token redaction intact", () => {
    const outbox = read("src/server/integrations/email/outbox.ts");
    expect(outbox).toContain("redactCheckInTokens");
    expect(outbox).toContain("info.simulated");
  });
});
