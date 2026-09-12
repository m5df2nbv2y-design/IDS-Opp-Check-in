/**
 * Which deployment this process is, and what it is allowed to talk to.
 *
 * ---------------------------------------------------------------------------
 * Why NODE_ENV is not enough
 * ---------------------------------------------------------------------------
 * On Vercel, a Preview deployment runs with NODE_ENV=production — identical to
 * the real thing. So NODE_ENV cannot distinguish "the production system" from
 * "a public URL built off an unreviewed branch". Without a second signal, a
 * pull-request preview inherits whatever credentials are scoped to it, and once
 * Salesforce write-back is enabled that preview can write to the production CRM.
 *
 * VERCEL_ENV is that signal: Vercel sets it to production | preview |
 * development on every deployment.
 *
 * ---------------------------------------------------------------------------
 * The rule
 * ---------------------------------------------------------------------------
 * A live integration is permitted in exactly two places:
 *
 *   vercel-production  the real deployment, which is the point
 *   local              a developer's machine — `npm run sf:smoke` exists to
 *                      validate a real org from a workstation and must keep
 *                      working
 *
 * Everything else is refused, including the case that matters most: a
 * production-like deployment where VERCEL_ENV is absent or unrecognised. That
 * is treated as UNKNOWN and refused, rather than assumed to be production —
 * assuming production is precisely the mistake this module exists to prevent.
 *
 * Pure and env-injectable, so the dangerous configurations can be tested
 * without setting them.
 */

export type DeploymentEnvironment =
  | "vercel-production"
  | "vercel-preview"
  | "vercel-development"
  | "local"
  | "unknown";

export type DeploymentEnv = Record<string, string | undefined>;

const VERCEL_ENVIRONMENTS: Record<string, DeploymentEnvironment> = {
  production: "vercel-production",
  preview: "vercel-preview",
  development: "vercel-development",
};

/** Where this process is running, as far as it can be proven. */
export function deploymentEnvironment(env: DeploymentEnv): DeploymentEnvironment {
  const vercelEnv = env.VERCEL_ENV?.trim();

  if (vercelEnv) {
    // An unrecognised value is not production. It is unknown.
    return VERCEL_ENVIRONMENTS[vercelEnv] ?? "unknown";
  }

  // No Vercel signal. A production build in that state is some deployment we
  // cannot identify — self-hosted, a container, a misconfigured platform — and
  // it does not get production credentials on trust.
  if (env.NODE_ENV === "production") return "unknown";

  return "local";
}

/** The environments in which a live integration may be used. */
const LIVE_ALLOWED: DeploymentEnvironment[] = ["vercel-production", "local"];

const DESCRIPTIONS: Record<DeploymentEnvironment, string> = {
  "vercel-production": "the Vercel Production deployment",
  "vercel-preview": "a Vercel Preview deployment",
  "vercel-development": "a Vercel development deployment",
  local: "a local workstation",
  unknown: "an unidentified production-like deployment (VERCEL_ENV is missing or unrecognised)",
};

/**
 * Why a live Salesforce integration must be refused here, or null if it is
 * allowed. Returns a message — never a value — so nothing it produces can leak
 * a credential.
 */
export function liveIntegrationRefusal(env: DeploymentEnv): string | null {
  // A simulated provider reaches nothing real, so it is always permitted.
  if (env.SALESFORCE_PROVIDER?.trim().toLowerCase() !== "salesforce") return null;

  const where = deploymentEnvironment(env);
  if (LIVE_ALLOWED.includes(where)) return null;

  return [
    `Refusing to use the live Salesforce org from ${DESCRIPTIONS[where]}.`,
    "",
    "  Production credentials must be scoped to the Vercel Production",
    "  environment only. A preview deployment is built from unreviewed code on",
    "  a shareable URL, and must never reach the production CRM.",
    "",
    '  Set SALESFORCE_PROVIDER="mock" for this environment, or remove the',
    "  production Salesforce credentials from its environment variables.",
  ].join("\n");
}

/**
 * The same rule for outbound email.
 *
 * A preview deployment wired to a real provider would send genuine mail to
 * genuine customers from unreviewed code. Mock is always permitted.
 */
export function liveEmailRefusal(env: DeploymentEnv): string | null {
  const provider = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "mock") return null;

  const where = deploymentEnvironment(env);
  if (LIVE_ALLOWED.includes(where)) return null;

  return (
    `Refusing to use the "${provider}" email provider from ${DESCRIPTIONS[where]}. ` +
    'Set EMAIL_PROVIDER="mock" for this environment — a preview must not send real customer mail.'
  );
}

export class DeploymentIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentIsolationError";
  }
}

/**
 * Throws unless a live integration is permitted here.
 *
 * Called from the LiveSalesforceService constructor rather than only from the
 * provider factory, because two scripts construct that class directly. Putting
 * it in the class means every path — present and future — inherits the guard.
 */
export function assertLiveIntegrationAllowed(env: DeploymentEnv = process.env): void {
  const refusal = liveIntegrationRefusal(env);
  if (refusal) throw new DeploymentIsolationError(refusal);
}
