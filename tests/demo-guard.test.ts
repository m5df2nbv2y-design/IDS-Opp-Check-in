import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertDemoEnvironment,
  demoSafetyViolations,
  isDemoEnvironment,
  UnsafeEnvironmentError,
} from "@/lib/demo-guard";

/**
 * The seed script wipes the database, pulls the full catalog and launches a
 * campaign. Against real providers that would email every resolved contact —
 * the exact outcome the selection queue exists to prevent. The guard must fail
 * CLOSED: anything other than an explicit "mock" on BOTH providers is refused.
 */

describe("demo environment guard", () => {
  it("permits only an explicit mock/mock combination", () => {
    expect(isDemoEnvironment({ SALESFORCE_PROVIDER: "mock", EMAIL_PROVIDER: "mock" })).toBe(true);
    expect(demoSafetyViolations({ SALESFORCE_PROVIDER: "mock", EMAIL_PROVIDER: "mock" })).toEqual([]);
  });

  it("fails closed when either variable is missing entirely", () => {
    expect(isDemoEnvironment({})).toBe(false);
    expect(isDemoEnvironment({ SALESFORCE_PROVIDER: "mock" })).toBe(false);
    expect(isDemoEnvironment({ EMAIL_PROVIDER: "mock" })).toBe(false);

    // Both missing → both reported, so the message is actionable.
    expect(demoSafetyViolations({})).toHaveLength(2);
  });

  it("fails closed on empty or whitespace-only values", () => {
    expect(isDemoEnvironment({ SALESFORCE_PROVIDER: "", EMAIL_PROVIDER: "mock" })).toBe(false);
    expect(isDemoEnvironment({ SALESFORCE_PROVIDER: "   ", EMAIL_PROVIDER: "mock" })).toBe(false);
  });

  it("refuses every live provider combination", () => {
    const unsafe: [string, string][] = [
      ["salesforce", "mock"],
      ["mock", "resend"],
      ["salesforce", "resend"],
      ["salesforce", "microsoft365"],
      ["SALESFORCE", "MOCK"],
      ["production", "mock"],
    ];

    for (const [sf, email] of unsafe) {
      expect(
        isDemoEnvironment({ SALESFORCE_PROVIDER: sf, EMAIL_PROVIDER: email }),
        `${sf}/${email} must be refused`,
      ).toBe(false);
    }
  });

  it("accepts case-insensitive mock, since env vars are hand-edited", () => {
    expect(isDemoEnvironment({ SALESFORCE_PROVIDER: "Mock", EMAIL_PROVIDER: "MOCK" })).toBe(true);
  });

  it("throws an actionable error naming the offending variable", () => {
    expect(() =>
      assertDemoEnvironment("npm run db:seed", {
        SALESFORCE_PROVIDER: "salesforce",
        EMAIL_PROVIDER: "mock",
      }),
    ).toThrow(UnsafeEnvironmentError);

    try {
      assertDemoEnvironment("npm run db:seed", {
        SALESFORCE_PROVIDER: "salesforce",
        EMAIL_PROVIDER: "resend",
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("REFUSING TO RUN npm run db:seed");
      expect(message).toContain("SALESFORCE_PROVIDER");
      expect(message).toContain("EMAIL_PROVIDER");
    }
  });
});

describe("seed script refuses to run against live providers", () => {
  const seed = fileURLToPath(new URL("../prisma/seed.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  /** Runs the real seed script and returns its combined output + exit code. */
  function runSeed(env: Record<string, string>) {
    try {
      execFileSync("npx", ["tsx", seed], {
        cwd,
        env: { ...process.env, ...env },
        stdio: "pipe",
        encoding: "utf8",
      });
      return { code: 0, output: "" };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { code: e.status, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it(
    "exits non-zero and wipes nothing when SALESFORCE_PROVIDER is live",
    { timeout: 120_000 },
    () => {
      const result = runSeed({
        SALESFORCE_PROVIDER: "salesforce",
        EMAIL_PROVIDER: "mock",
        // Point at a path that does not exist: if the guard ever failed to fire,
        // the run would blow up on the database rather than quietly succeeding.
        DATABASE_URL: "file:/nonexistent/should-never-be-touched.db",
      });

      expect(result.code).not.toBe(0);
      expect(result.output).toContain("REFUSING TO RUN");
      expect(result.output).toContain("SALESFORCE_PROVIDER");
      // Proof it stopped before doing any work.
      expect(result.output).not.toContain("Resetting database");
    },
  );

  it(
    "exits non-zero when EMAIL_PROVIDER is live",
    { timeout: 120_000 },
    () => {
      const result = runSeed({
        SALESFORCE_PROVIDER: "mock",
        EMAIL_PROVIDER: "resend",
        DATABASE_URL: "file:/nonexistent/should-never-be-touched.db",
      });

      expect(result.code).not.toBe(0);
      expect(result.output).toContain("EMAIL_PROVIDER");
      expect(result.output).not.toContain("Resetting database");
    },
  );
});
