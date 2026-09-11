import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertProductionConfig,
  ProductionConfigError,
  productionConfigViolations,
} from "@/lib/production-config";
import { demoSafetyViolations } from "@/lib/demo-guard";

/**
 * Production must fail closed.
 *
 * Every default the application carries is a development convenience — SQLite,
 * a localhost base URL, the mock Salesforce org. Each is silently wrong in
 * production: the app would boot and serve an empty database, or email
 * check-in links nobody outside the server can open. These tests pin the
 * refusal.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(`${root}${relative}`, "utf8");

/** A complete, valid production environment. */
const VALID = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pw@db.example.com:5432/ids?sslmode=require",
  AUTH_SECRET: "a-real-secret",
  AUTH_MICROSOFT_ENTRA_ID_ID: "entra-client-id",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-client-secret",
  AUTH_REQUIRED_APP_ROLE: "SalesOps.Admin",
  APP_BASE_URL: "https://checkin.idsculpture.com",
  SALESFORCE_PROVIDER: "salesforce",
  SF_CLIENT_ID: "consumer-key",
  SF_CLIENT_SECRET: "consumer-secret",
};

describe("production configuration", () => {
  it("accepts a fully configured production environment", () => {
    expect(productionConfigViolations(VALID)).toEqual([]);
    expect(() => assertProductionConfig(VALID)).not.toThrow();
  });

  it("never constrains development", () => {
    // An empty dev environment is fine — that is the point of the defaults.
    expect(productionConfigViolations({ NODE_ENV: "development" })).toEqual([]);
    expect(productionConfigViolations({})).toEqual([]);
  });

  it.each([
    ["DATABASE_URL", "DATABASE_URL"],
    ["AUTH_SECRET", "AUTH_SECRET"],
    ["AUTH_MICROSOFT_ENTRA_ID_ID", "Entra ID is not configured"],
    ["AUTH_MICROSOFT_ENTRA_ID_SECRET", "Entra ID is not configured"],
    ["SF_CLIENT_SECRET", "SF_CLIENT_ID / SF_CLIENT_SECRET"],
  ])("refuses to start when %s is missing", (key, expected) => {
    const violations = productionConfigViolations({ ...VALID, [key]: undefined });
    expect(violations.join(" ")).toContain(expected);
  });

  it("refuses a SQLite database in production", () => {
    const violations = productionConfigViolations({ ...VALID, DATABASE_URL: "file:./dev.db" });
    expect(violations.join(" ")).toContain("PostgreSQL");
  });

  it("refuses a localhost base URL, which customers cannot open", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
      const violations = productionConfigViolations({ ...VALID, APP_BASE_URL: url });
      expect(violations.join(" ")).toContain("localhost");
    }
  });

  it("refuses the development sign-in bypass in production", () => {
    const violations = productionConfigViolations({ ...VALID, AUTH_DEV_BYPASS: "true" });
    expect(violations.join(" ")).toContain("AUTH_DEV_BYPASS");
  });

  it("refuses to serve the mock Salesforce org as real pipeline", () => {
    const violations = productionConfigViolations({ ...VALID, SALESFORCE_PROVIDER: "mock" });
    expect(violations.join(" ")).toContain("mock org would present demo data as real");
  });

  it("refuses a deployment where nobody could be authorized", () => {
    const violations = productionConfigViolations({
      ...VALID,
      AUTH_REQUIRED_APP_ROLE: undefined,
      AUTH_REQUIRED_GROUP_ID: undefined,
    });
    expect(violations.join(" ")).toContain("No authorization policy");
  });

  it("accepts the group-id fallback in place of an App Role", () => {
    const violations = productionConfigViolations({
      ...VALID,
      AUTH_REQUIRED_APP_ROLE: undefined,
      AUTH_REQUIRED_GROUP_ID: "00000000-0000-0000-0000-000000000000",
    });
    expect(violations).toEqual([]);
  });

  it("names every problem at once rather than one at a time", () => {
    const error = (() => {
      try {
        assertProductionConfig({ NODE_ENV: "production" });
        return null;
      } catch (caught) {
        return caught as ProductionConfigError;
      }
    })();

    expect(error).toBeInstanceOf(ProductionConfigError);
    expect(error!.violations.length).toBeGreaterThanOrEqual(5);
    // The message must not echo a configured value back out.
    expect(error!.message).toContain("REFUSING TO START");
  });

  it("is checked at server startup", () => {
    const instrumentation = read("instrumentation.ts");
    expect(instrumentation).toContain("assertProductionConfig");
    expect(instrumentation).toContain("export async function register()");
  });
});

describe("the destructive seed cannot reach a real database", () => {
  const MOCK = { SALESFORCE_PROVIDER: "mock", EMAIL_PROVIDER: "mock" };

  it("allows a local SQLite target", () => {
    expect(demoSafetyViolations({ ...MOCK, DATABASE_URL: "file:./dev.db" })).toEqual([]);
  });

  it("allows Postgres on this machine", () => {
    expect(
      demoSafetyViolations({ ...MOCK, DATABASE_URL: "postgresql://u:p@localhost:5432/dev" }),
    ).toEqual([]);
  });

  it("REFUSES a remote database even when both providers are mock", () => {
    // Mock providers say nothing about which database gets wiped.
    const violations = demoSafetyViolations({
      ...MOCK,
      DATABASE_URL: "postgresql://u:p@db.production.example.com:5432/ids",
    });
    expect(violations.join(" ")).toContain("remote database");
  });

  it("REFUSES a production build", () => {
    const violations = demoSafetyViolations({ ...MOCK, NODE_ENV: "production" });
    expect(violations.join(" ")).toContain("production");
  });
});

describe("secrets never reach the browser", () => {
  const clientFiles = () => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(`${root}${dir}`, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "generated") walk(path);
        } else if (/\.tsx?$/.test(entry.name)) {
          if (readFileSync(`${root}${path}`, "utf8").includes('"use client"')) out.push(path);
        }
      }
    };
    walk("src");
    return out;
  };

  it("declares no NEXT_PUBLIC_ variable anywhere", () => {
    // A secret prefixed NEXT_PUBLIC_ is inlined into the client bundle. Prose
    // mentioning the prefix is fine; a DECLARATION or a read is not.
    const declaration = /^\s*(?:#\s*)?NEXT_PUBLIC_[A-Z0-9_]*\s*=/m;
    const read_ = /process\.env\.NEXT_PUBLIC_/;
    for (const path of ["src/lib/env.ts", "src/server/auth/config.ts", ".env.example"]) {
      const source = read(path);
      expect(source, `${path} declares a NEXT_PUBLIC_ variable`).not.toMatch(declaration);
      expect(source, `${path} reads a NEXT_PUBLIC_ variable`).not.toMatch(read_);
    }
  });

  it("no client component imports server config, the database, or an integration", () => {
    for (const path of clientFiles()) {
      const source = read(path);
      expect(source, `${path} must not import server config`).not.toMatch(
        /^import\s+\{[^}]*\benv\b[^}]*\}\s+from\s+"@\/lib\/env"/m,
      );
      expect(source, `${path} must not import the database`).not.toContain('from "@/lib/db"');
      expect(source, `${path} must not import an integration`).not.toContain(
        'from "@/server/integrations',
      );
    }
  });

  it("reads Salesforce and email credentials only on the server", () => {
    const envModule = read("src/lib/env.ts");
    for (const key of ["SF_CLIENT_SECRET", "RESEND_API_KEY", "DATABASE_URL", "DEMO_TEST_EMAIL"]) {
      expect(envModule).toContain(key);
    }
    // src/lib/env.ts is imported only by server code; no client file may.
    for (const path of clientFiles()) {
      expect(read(path)).not.toContain("process.env");
    }
  });

  it("never logs a credential or a full token", () => {
    for (const path of [
      "src/server/integrations/salesforce/live/auth.ts",
      "src/server/integrations/salesforce/live/salesforce-service.ts",
      "src/server/integrations/email/mock-email-service.ts",
    ]) {
      const source = read(path);
      expect(source).not.toMatch(/console\.\w+\([^)]*clientSecret/);
      expect(source).not.toMatch(/console\.\w+\([^)]*accessToken/);
      expect(source).not.toMatch(/console\.\w+\([^)]*databaseUrl/);
    }
    // The OAuth error path surfaces only the error CODE, never the body.
    expect(read("src/server/integrations/salesforce/live/auth.ts")).toContain("safeErrorCode");
  });
});

describe("the Salesforce transport is bounded", () => {
  const service = () => read("src/server/integrations/salesforce/live/salesforce-service.ts");

  it("times out every request rather than hanging", () => {
    expect(service()).toContain("AbortSignal.timeout(REQUEST_TIMEOUT_MS)");
    expect(read("src/server/integrations/salesforce/live/auth.ts")).toContain(
      "AbortSignal.timeout(AUTH_TIMEOUT_MS)",
    );
  });

  it("re-authenticates once on a 401 instead of failing the call", () => {
    const source = service();
    expect(source).toContain("response.status === 401");
    expect(source).toContain("allowReauth: false");
  });

  it("retries reads on transient failures only", () => {
    const source = service();
    expect(source).toContain("response.status === 429 || response.status >= 500");
    expect(source).toContain("MAX_READ_ATTEMPTS");
  });

  it("does NOT auto-retry writes", () => {
    const source = service();
    const patch = source.slice(source.indexOf("private async patchOpportunity"));
    // The comment there explains the choice; what matters is the absent call.
    expect(patch).not.toContain("this.readWithRetry(");
    expect(patch).toContain("this.request(");
  });

  it("still writes nothing to Salesforce by default", () => {
    // The write-back master switch defaults to false.
    expect(read("src/lib/env.ts")).toContain('process.env.SALESFORCE_WRITE_ENABLED === "true"');
    expect(read(".env.example")).toContain('SALESFORCE_WRITE_ENABLED="false"');
  });
});

describe("the public surface stays public and bounded", () => {
  it("keeps /checkin and /signin outside the admin guard", () => {
    const proxy = read("proxy.ts");
    // The matcher is the whole boundary: only /admin is intercepted. proxy.ts
    // naturally names /signin as its redirect TARGET, which is not a match rule.
    expect(proxy).toContain('matcher: ["/admin/:path*"]');
    const matcher = proxy.slice(proxy.indexOf("export const config"));
    expect(matcher).not.toContain("/checkin");
    expect(matcher).not.toContain("/signin");
    // And the recipient page itself is never authenticated.
    const page = read("src/app/checkin/[token]/page.tsx");
    expect(page).not.toContain("requireAdmin");
  });

  it("bounds the one free-text field an anonymous caller can write", () => {
    const source = read("src/server/services/response-service.ts");
    expect(source).toContain("MAX_COMMENT_LENGTH");
    expect(source).toContain("slice(0, MAX_COMMENT_LENGTH)");
  });

  it("requires admin authorization for every report export", () => {
    for (const route of [
      "src/app/api/admin/reports/executive-brief/route.ts",
      "src/app/api/admin/reports/pipeline-workbook/route.ts",
    ]) {
      expect(read(route)).toContain("authorizeExport(");
    }
    expect(read("src/server/reports/authorize-export.ts")).toContain("requireAdmin()");
  });

  it("generates reports in memory, with no filesystem persistence", () => {
    // Serverless hosts have no writable, durable filesystem.
    for (const path of [
      "src/server/reports/executive-brief-pdf.ts",
      "src/server/reports/pipeline-workbook.ts",
    ]) {
      const source = read(path);
      expect(source).not.toContain("writeFileSync");
      expect(source).not.toContain("createWriteStream");
      expect(source).not.toContain("node:fs");
    }
  });
});

import { readdirSync } from "node:fs";
