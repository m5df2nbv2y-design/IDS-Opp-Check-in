/**
 * Fail-closed guard for destructive development tooling.
 *
 * The seed script wipes the database, pulls the full opportunity catalog, and
 * launches a campaign — which, pointed at real providers, would email every
 * resolved contact. That is precisely the outcome the human-in-the-loop
 * selection queue exists to prevent, so it must be impossible to reach by
 * accident.
 *
 * Deliberately fails CLOSED: a missing or empty variable is treated as unsafe,
 * not defaulted to "mock". A developer who has not stated their intent does not
 * get to run a destructive script.
 */

export class UnsafeEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeEnvironmentError";
  }
}

export type ProviderEnv = Record<string, string | undefined>;

/**
 * Returns the reasons the environment is unsafe for destructive demo tooling.
 * Empty array means safe. Pure, so it can be tested without touching process.env.
 */
export function demoSafetyViolations(env: ProviderEnv): string[] {
  const violations: string[] = [];

  for (const key of ["SALESFORCE_PROVIDER", "EMAIL_PROVIDER"] as const) {
    const value = env[key]?.trim();
    if (!value) {
      violations.push(`${key} is not set — it must be explicitly "mock".`);
    } else if (value.toLowerCase() !== "mock") {
      violations.push(`${key} is "${value}" — it must be "mock".`);
    }
  }

  return violations;
}

export function isDemoEnvironment(env: ProviderEnv = process.env): boolean {
  return demoSafetyViolations(env).length === 0;
}

/**
 * Throws unless BOTH providers are explicitly "mock". Call this before any
 * database wipe, Salesforce call, or campaign launch.
 */
export function assertDemoEnvironment(
  scriptName: string,
  env: ProviderEnv = process.env,
): void {
  const violations = demoSafetyViolations(env);
  if (violations.length === 0) return;

  throw new UnsafeEnvironmentError(
    [
      "",
      "═".repeat(72),
      `REFUSING TO RUN ${scriptName}`,
      "═".repeat(72),
      "",
      ...violations.map((reason) => `  ✗ ${reason}`),
      "",
      `  ${scriptName} deletes all local data, pulls the full opportunity`,
      "  catalog, and launches a campaign. Against real providers that would",
      "  email every resolved contact and could modify Salesforce.",
      "",
      '  Set BOTH of these to "mock" in .env, or run it somewhere else:',
      '    SALESFORCE_PROVIDER="mock"',
      '    EMAIL_PROVIDER="mock"',
      "",
      "═".repeat(72),
      "",
    ].join("\n"),
  );
}
