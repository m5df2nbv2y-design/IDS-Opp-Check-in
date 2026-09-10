import { env } from "@/lib/env";
import { SalesforceSyncError } from "../types";

/**
 * Salesforce authentication — deliberately separate from the business logic in
 * salesforce-service.ts, so credentials and flow selection live in exactly one
 * place and a new flow (JWT bearer, refresh token) can be added without
 * touching any query or write code.
 *
 * SECURITY: this module reads credentials from the environment only. It never
 * logs, returns, or embeds a secret in an error message — failures report the
 * HTTP status and Salesforce's own error code, never the values sent.
 *
 * ---------------------------------------------------------------------------
 * Flows
 * ---------------------------------------------------------------------------
 * "client_credentials" (default) — the right flow for an External Client App
 * acting as itself, server to server. The integration identity is configured
 * in Salesforce as the app's "Run As" user, NOT sent in the request, so only
 * the Consumer Key and Secret are needed. Requires, on the External Client App:
 *   - OAuth Settings → Flow Enablement → "Enable Client Credentials Flow"
 *   - Policies → "Run As" set to the integration user
 *
 * "password" — legacy username/password grant. Kept because some orgs disable
 * client credentials. Needs SF_USERNAME and SF_PASSWORD (password with the
 * security token appended). Prefer client credentials where possible: it has
 * no user password to rotate or leak.
 */

export type SalesforceAuthFlow = "client_credentials" | "password";

export type SalesforceToken = {
  accessToken: string;
  instanceUrl: string;
  /** Identity URL from the token response — resolves to the Run As user. */
  identityUrl: string | null;
};

/** The configured flow, defaulting to the External Client App's flow. */
export function getAuthFlow(): SalesforceAuthFlow {
  return env.salesforce.authFlow === "password" ? "password" : "client_credentials";
}

/**
 * Which env vars the configured flow requires. Returned as names only so
 * callers can report what is missing without touching the values.
 */
export function missingCredentials(flow: SalesforceAuthFlow = getAuthFlow()): string[] {
  const { clientId, clientSecret, username, password } = env.salesforce;
  const missing: string[] = [];

  if (!clientId) missing.push("SF_CLIENT_ID");
  if (!clientSecret) missing.push("SF_CLIENT_SECRET");

  if (flow === "password") {
    if (!username) missing.push("SF_USERNAME");
    if (!password) missing.push("SF_PASSWORD");
  }

  return missing;
}

/**
 * Exchange the configured credentials for an access token.
 * Throws SalesforceSyncError — never leaks a credential value.
 */
export async function requestAccessToken(
  flow: SalesforceAuthFlow = getAuthFlow(),
): Promise<SalesforceToken> {
  const { clientId, clientSecret, username, password, loginUrl, instanceUrl } = env.salesforce;

  const missing = missingCredentials(flow);
  if (missing.length > 0) {
    throw new SalesforceSyncError(
      `Salesforce credentials are not configured for the ${flow} flow. Missing: ${missing.join(", ")}. ` +
        `Set them in .env, or run with SALESFORCE_PROVIDER=mock.`,
      { code: "NOT_CONFIGURED", retryable: false },
    );
  }

  const body =
    flow === "client_credentials"
      ? new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        })
      : new URLSearchParams({
          grant_type: "password",
          client_id: clientId,
          client_secret: clientSecret,
          username,
          password,
        });

  const response = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new SalesforceSyncError(
      `Salesforce authentication failed (${response.status}). ${explainAuthFailure(raw, flow)}`,
      { code: "AUTH_FAILED", retryable: false },
    );
  }

  const json = JSON.parse(raw) as {
    access_token: string;
    instance_url: string;
    id?: string;
  };

  return {
    accessToken: json.access_token,
    // An explicit SF_INSTANCE_URL wins; otherwise trust the token response,
    // which is already the correct My Domain host.
    instanceUrl: instanceUrl || json.instance_url,
    identityUrl: json.id ?? null,
  };
}

/**
 * Turn Salesforce's terse OAuth errors into the actual cause. The error body
 * contains only error codes, never our credentials, so it is safe to surface.
 */
function explainAuthFailure(body: string, flow: SalesforceAuthFlow): string {
  const code = safeErrorCode(body);

  if (code === "invalid_client" || code === "invalid_client_id") {
    return (
      "invalid_client — the Consumer Key/Secret don't match this login host. Check SF_LOGIN_URL " +
      "points at the right org (My Domain for client credentials; test.salesforce.com only for a " +
      "sandbox's non-My-Domain login), and that the External Client App is deployed and enabled."
    );
  }

  if (code === "unsupported_grant_type" || code === "invalid_grant_type") {
    return flow === "client_credentials"
      ? "unsupported_grant_type — the Client Credentials flow is not enabled on the External Client App. " +
          "Enable it under OAuth Settings → Flow Enablement, and set a Run As user under Policies."
      : "unsupported_grant_type — the username/password flow is not enabled on this app.";
  }

  if (code === "invalid_grant") {
    return flow === "client_credentials"
      ? "invalid_grant — the app has no Run As user set, or that user is inactive or lacks access to " +
          "the app. Set it under the External Client App's Policies → Client Credentials Flow."
      : "invalid_grant — wrong password, missing security token appended to SF_PASSWORD, IP not " +
          "allow-listed, or the password grant is blocked by org policy.";
  }

  if (code === "inactive_user") return "inactive_user — the integration user is deactivated.";
  if (code === "inactive_org") return "inactive_org — the Salesforce org is inactive or locked.";

  return code ? `Salesforce returned "${code}".` : "No error code returned by Salesforce.";
}

/** Extracts only the `error` code, so no response content can leak a value. */
function safeErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

/**
 * Read-only identity lookup — confirms which Salesforce user the application is
 * actually acting as. Useful to verify the Run As user is the dedicated
 * integration user and not a personal account.
 */
export async function fetchIdentity(token: SalesforceToken): Promise<{
  userId: string;
  username: string;
  displayName: string;
  organizationId: string;
} | null> {
  const response = await fetch(`${token.instanceUrl}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!response.ok) return null;

  const json = (await response.json()) as {
    user_id?: string;
    preferred_username?: string;
    name?: string;
    organization_id?: string;
  };

  return {
    userId: json.user_id ?? "unknown",
    username: json.preferred_username ?? "unknown",
    displayName: json.name ?? "unknown",
    organizationId: json.organization_id ?? "unknown",
  };
}
