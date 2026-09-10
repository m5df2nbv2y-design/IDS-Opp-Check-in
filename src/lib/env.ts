/**
 * Single place where environment configuration is read and defaulted.
 * Everything else in the app reads config from here, never from process.env.
 */

function str(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  databaseUrl: str("DATABASE_URL", "file:./dev.db"),

  /** Public origin used to build check-in links inside emails. */
  appBaseUrl: str(
    "APP_BASE_URL",
    process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000",
  ).replace(/\/$/, ""),

  /** "mock" | "salesforce" */
  salesforceProvider: str("SALESFORCE_PROVIDER", "mock"),

  /** "mock" | "smartsheet" */
  smartsheetProvider: str("SMARTSHEET_PROVIDER", "mock"),

  /** "mock" | "resend" | "microsoft365" */
  emailProvider: str("EMAIL_PROVIDER", "mock"),
  emailFromName: str("EMAIL_FROM_NAME", "IDS Sales Operations"),
  emailFromAddress: str("EMAIL_FROM_ADDRESS", "sales-ops@ids.example.com"),

  /** How long a personalized check-in link stays valid. */
  checkInTokenTtlDays: int("CHECKIN_TOKEN_TTL_DAYS", 45),

  salesforce: {
    /**
     * "client_credentials" (default) — External Client App acting as its
     * configured Run As user. Only the key and secret are needed.
     * "password" — legacy username/password grant, for orgs that require it.
     */
    authFlow: str("SF_AUTH_FLOW", "client_credentials"),
    /**
     * Write-back master switch. Defaults to FALSE — the integration is
     * read-only unless someone deliberately turns writing on. Reading real
     * pipeline data must never carry a risk of modifying it.
     */
    writeEnabled: process.env.SALESFORCE_WRITE_ENABLED === "true",
    loginUrl: str("SF_LOGIN_URL", "https://login.salesforce.com"),
    instanceUrl: process.env.SF_INSTANCE_URL ?? "",
    clientId: process.env.SF_CLIENT_ID ?? "",
    clientSecret: process.env.SF_CLIENT_SECRET ?? "",
    username: process.env.SF_USERNAME ?? "",
    password: process.env.SF_PASSWORD ?? "",
  },

  resendApiKey: process.env.RESEND_API_KEY ?? "",

  smartsheet: {
    baseUrl: str("SMARTSHEET_BASE_URL", "https://api.smartsheet.com/2.0"),
    apiKey: process.env.SMARTSHEET_API_KEY ?? "",
  },
} as const;

