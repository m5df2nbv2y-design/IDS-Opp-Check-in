/**
 * Production configuration guard.
 *
 * Every default in src/lib/env.ts exists to make local development pleasant:
 * a SQLite file, a localhost base URL, a mock Salesforce org. Each of those is
 * the WRONG answer in production, and the failure mode is silent — the app
 * boots, serves pages, and quietly reads an empty local database or mails
 * check-in links pointing at localhost.
 *
 * So production is checked explicitly and fails closed. A missing value is an
 * error, never a default.
 *
 * Pure and env-injectable so it can be tested without touching process.env.
 */

export class ProductionConfigError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(
      [
        "",
        "═".repeat(72),
        "REFUSING TO START — production configuration is incomplete",
        "═".repeat(72),
        "",
        ...violations.map((reason) => `  ✗ ${reason}`),
        "",
        "  See docs/PRODUCTION-DEPLOYMENT.md for the full list.",
        "  No value is defaulted in production: each must be set explicitly.",
        "",
        "═".repeat(72),
        "",
      ].join("\n"),
    );
    this.name = "ProductionConfigError";
    this.violations = violations;
  }
}

export type ConfigEnv = Record<string, string | undefined>;

const isSet = (value: string | undefined) => typeof value === "string" && value.trim() !== "";

/**
 * Returns the reasons this environment is not fit for production.
 * Empty array means fit. Non-production environments always return empty —
 * local development keeps its conveniences.
 */
export function productionConfigViolations(env: ConfigEnv): string[] {
  if (env.NODE_ENV !== "production") return [];

  const violations: string[] = [];

  // --- Database ---------------------------------------------------------
  // Without this, env.databaseUrl falls back to a local SQLite file and the
  // application serves an empty database as though nothing were wrong.
  if (!isSet(env.DATABASE_URL)) {
    violations.push("DATABASE_URL is not set. Production must not fall back to local SQLite.");
  } else if (env.DATABASE_URL!.startsWith("file:")) {
    violations.push(
      "DATABASE_URL points at a local SQLite file. Production requires PostgreSQL.",
    );
  }

  // --- Authentication ---------------------------------------------------
  if (!isSet(env.AUTH_SECRET)) {
    violations.push("AUTH_SECRET is not set. Session cookies cannot be signed.");
  }

  if (!isSet(env.AUTH_MICROSOFT_ENTRA_ID_ID) || !isSet(env.AUTH_MICROSOFT_ENTRA_ID_SECRET)) {
    violations.push(
      "Entra ID is not configured (AUTH_MICROSOFT_ENTRA_ID_ID / _SECRET). " +
        "There would be no way for an employee to sign in.",
    );
  }

  // The dev bypass is already unreachable in a production build — the provider
  // is never registered. Setting it is still a misconfiguration worth refusing,
  // because it signals the operator believes it does something.
  if (env.AUTH_DEV_BYPASS === "true") {
    violations.push(
      'AUTH_DEV_BYPASS is "true" in production. Remove it — the local sign-in ' +
        "must not be part of a production deployment.",
    );
  }

  // --- Authorization ----------------------------------------------------
  // Without a policy the authorization layer admits nobody, which is the
  // correct failure but a confusing one to debug after a deploy.
  if (!isSet(env.AUTH_REQUIRED_APP_ROLE) && !isSet(env.AUTH_REQUIRED_GROUP_ID)) {
    violations.push(
      "No authorization policy is set. Configure AUTH_REQUIRED_APP_ROLE " +
        "(preferred) or AUTH_REQUIRED_GROUP_ID, or nobody will be admitted to /admin.",
    );
  }

  // --- Application ------------------------------------------------------
  // Check-in links are built from this and are emailed to customers. A wrong
  // value produces links nobody outside the server can open.
  const hasVercelUrl = isSet(env.VERCEL_PROJECT_PRODUCTION_URL);
  if (!isSet(env.APP_BASE_URL) && !hasVercelUrl) {
    violations.push(
      "APP_BASE_URL is not set. Check-in links in customer email would point at localhost.",
    );
  } else if (isSet(env.APP_BASE_URL) && /localhost|127\.0\.0\.1/.test(env.APP_BASE_URL!)) {
    violations.push(
      `APP_BASE_URL is "${env.APP_BASE_URL}" — a localhost URL cannot be opened by a customer.`,
    );
  }

  // --- Salesforce -------------------------------------------------------
  // A live deployment reading the mock org would show fabricated pipeline as
  // though it were real, which is worse than failing.
  const provider = env.SALESFORCE_PROVIDER?.trim().toLowerCase();
  if (provider !== "salesforce") {
    violations.push(
      `SALESFORCE_PROVIDER is "${env.SALESFORCE_PROVIDER ?? "unset"}". ` +
        'Production must be "salesforce" — the mock org would present demo data as real.',
    );
  } else if (!isSet(env.SF_CLIENT_ID) || !isSet(env.SF_CLIENT_SECRET)) {
    violations.push("SF_CLIENT_ID / SF_CLIENT_SECRET are required for the live Salesforce provider.");
  }

  return violations;
}

/** Throws unless this environment is fit for production. */
export function assertProductionConfig(env: ConfigEnv = process.env): void {
  const violations = productionConfigViolations(env);
  if (violations.length > 0) throw new ProductionConfigError(violations);
}
