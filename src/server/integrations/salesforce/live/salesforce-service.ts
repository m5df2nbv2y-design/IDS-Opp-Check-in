import { accountTypeFromSalesforce } from "@/lib/account-types";
import { assertLiveIntegrationAllowed } from "@/lib/deployment-environment";
import { env } from "@/lib/env";
import { stageFromSalesforce, stageToSalesforce, type OpportunityStage } from "@/lib/stages";
import {
  SalesforceSyncError,
  type OpportunityStatusUpdate,
  type SalesforceAccount,
  type SalesforceContact,
  type SalesforceOpportunity,
  type SalesforceOpportunityOutcome,
  type SalesforceProviderInfo,
  type SalesforceRep,
  type SalesforceService,
} from "../types";
import { requestAccessToken } from "./auth";

/**
 * ===========================================================================
 *  THIS IS WHERE THE REAL SALESFORCE/SFX INTEGRATION PLUGS IN.
 * ===========================================================================
 *
 * Nothing else in the application changes: set
 *
 *   SALESFORCE_PROVIDER=salesforce
 *   SF_LOGIN_URL / SF_CLIENT_ID / SF_CLIENT_SECRET
 *
 * and the factory in ../index.ts returns this class instead of the mock.
 * Authentication (External Client App, client credentials by default) lives in
 * ./auth.ts — this file only queries and writes. Verify an org before turning
 * the provider on with `npm run sf:smoke`, which is read-only.
 *
 * The field questions are now settled against the real org (see
 * ../FIELD-MAPPING.md): "open" is IsClosed = false, the account is standard
 * AccountId, and the recipient is the primary OpportunityContactRole. Write-back
 * scope is StageName and CloseDate only; notes are never written.
 */

const API_VERSION = "v61.0";

/**
 * Transport policy.
 *
 * A hung Salesforce connection must not hold a serverless request open until
 * the platform kills it, so every call is bounded. Reads are idempotent and
 * are retried on the two failures that are genuinely transient — 429 and 5xx —
 * with a short backoff. Writes are NOT retried here: `retryable` is reported
 * on the error and the decision is left to the sync service, which knows
 * whether replaying an update is safe.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_READ_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The primary contact role subquery is the recipient. Confirmed against the
 * org: 78.6% of open opportunities carry one, and IDS maintains it deliberately.
 * There is no partner-account lookup and no custom check-in contact field —
 * standard AccountId and OpportunityContactRole are the real model.
 */
const OPEN_OPPORTUNITY_SOQL = `
  SELECT Id, Name, Amount, StageName, CloseDate, OwnerId,
         AccountId, Account.Name,
         (SELECT ContactId FROM OpportunityContactRoles WHERE IsPrimary = true)
  FROM Opportunity
  WHERE IsClosed = false
`;

const ACCOUNT_SOQL = `SELECT Id, Name, Type FROM Account WHERE IsDeleted = false`;

/**
 * Contacts WITHOUT an email are deliberately included, so resolution can tell
 * "primary contact has no email" apart from "contact not found" and report the
 * difference on the needs-attention list.
 */
const CONTACT_SOQL = `
  SELECT Id, AccountId, Name, Email
  FROM Contact
  WHERE AccountId != null
`;

type SalesforceAuth = { accessToken: string; instanceUrl: string; expiresAt: number };

export class LiveSalesforceService implements SalesforceService {
  readonly info: SalesforceProviderInfo = {
    id: "salesforce",
    label: "Salesforce / SFX",
    simulated: false,
    description: "Live Salesforce org via the REST API.",
  };

  private auth: SalesforceAuth | null = null;

  /**
   * Environment isolation, enforced at construction.
   *
   * Two scripts build this class directly rather than going through
   * getSalesforceService(), so the guard lives here: every path that can reach
   * the real org has to pass through this constructor. A Vercel Preview — or
   * any deployment that cannot prove it is Production — is refused.
   */
  constructor() {
    assertLiveIntegrationAllowed();
  }

  async getSalesReps(): Promise<SalesforceRep[]> {
    const rows = await this.query<{ Id: string; Name: string; Email: string; IsActive: boolean }>(
      `SELECT Id, Name, Email, IsActive FROM User WHERE IsActive = true`,
    );

    return rows.map((row) => ({
      externalId: row.Id,
      name: row.Name,
      email: row.Email,
      active: row.IsActive,
    }));
  }

  async getAccounts(): Promise<SalesforceAccount[]> {
    const rows = await this.query<{ Id: string; Name: string; Type: string | null }>(ACCOUNT_SOQL);

    return rows.map((row) => ({
      externalId: row.Id,
      name: row.Name,
      type: accountTypeFromSalesforce(row.Type),
      active: true,
    }));
  }

  async getExternalContacts(options?: {
    accountExternalIds?: string[];
  }): Promise<SalesforceContact[]> {
    let soql = CONTACT_SOQL;
    if (options?.accountExternalIds?.length) {
      soql += ` AND AccountId IN (${options.accountExternalIds.map((id) => `'${escapeSoql(id)}'`).join(",")})`;
    }

    const rows = await this.query<{
      Id: string;
      AccountId: string | null;
      Name: string;
      Email: string;
    }>(soql);

    return rows
      .filter((row) => row.AccountId)
      .map((row) => ({
        externalId: row.Id,
        accountExternalId: row.AccountId!,
        name: row.Name,
        email: row.Email,
        // No primary-contact flag exists on Contact in this org, and
        // resolution does not use one — the primary role on the Opportunity is
        // the sole recipient signal.
        isPrimary: false,
        // Salesforce Contacts have no IsActive; a deactivated contact is
        // normally modelled with a custom field or a status picklist. Confirm
        // with the org and filter here.
        active: true,
      }));
  }

  async getOpenOpportunities(options?: {
    ownerExternalIds?: string[];
  }): Promise<SalesforceOpportunity[]> {
    let soql = OPEN_OPPORTUNITY_SOQL;
    if (options?.ownerExternalIds?.length) {
      soql += ` AND OwnerId IN (${options.ownerExternalIds.map((id) => `'${escapeSoql(id)}'`).join(",")})`;
    }

    const rows = await this.query<SalesforceOpportunityRow>(soql);
    return rows.flatMap((row) => {
      const mapped = this.toDomain(row);
      // Stages outside the controlled list are skipped, never guessed at.
      // See FIELD-MAPPING.md §7 — this is the number to check at go-live.
      if (!mapped) {
        console.warn(`[salesforce] skipped ${row.Id} — unmapped stage "${row.StageName}"`);
        return [];
      }
      return [mapped];
    });
  }

  async getOpportunity(externalId: string): Promise<SalesforceOpportunity | null> {
    const rows = await this.query<SalesforceOpportunityRow>(
      `${OPEN_OPPORTUNITY_SOQL.replace("WHERE IsClosed = false", "WHERE")} Id = '${escapeSoql(externalId)}'`,
    );
    const row = rows[0];
    return row ? this.toDomain(row) : null;
  }

  async getOpportunityOutcomes(externalIds: string[]): Promise<SalesforceOpportunityOutcome[]> {
    if (externalIds.length === 0) return [];

    // SOQL IN-lists are bounded, so ask in chunks rather than one huge query.
    const CHUNK = 200;
    const outcomes: SalesforceOpportunityOutcome[] = [];

    for (let i = 0; i < externalIds.length; i += CHUNK) {
      const ids = externalIds.slice(i, i + CHUNK).map((id) => `'${escapeSoql(id)}'`).join(",");
      const rows = await this.query<{
        Id: string;
        IsClosed: boolean;
        IsWon: boolean;
        StageName: string;
        Amount: number | null;
        CloseDate: string | null;
      }>(
        `SELECT Id, IsClosed, IsWon, StageName, Amount, CloseDate FROM Opportunity WHERE Id IN (${ids})`,
      );

      for (const row of rows) {
        outcomes.push({
          externalId: row.Id,
          isClosed: row.IsClosed,
          isWon: row.IsWon,
          // Raw StageName — "Closed Won"/"Closed Lost" are outside the four
          // controlled stages and must not be mapped away.
          stageName: row.StageName,
          amount: row.Amount ?? 0,
          closeDate: row.CloseDate ? new Date(row.CloseDate) : null,
        });
      }
    }

    return outcomes;
  }

  async updateOpportunityStatus(externalId: string, stage: OpportunityStage): Promise<void> {
    await this.patchOpportunity(externalId, { StageName: stageToSalesforce(stage) });
  }

  async applyUpdate(update: OpportunityStatusUpdate): Promise<void> {
    // Stage only. Notes are never written to Salesforce — see ../FIELD-MAPPING.md.
    await this.patchOpportunity(update.externalId, {
      StageName: stageToSalesforce(update.stage),
    });
  }

  // -- transport ------------------------------------------------------------

  /**
   * Obtains and caches an access token. The flow itself lives in ./auth.ts —
   * this only decides when to re-request one.
   */
  private async authenticate(): Promise<SalesforceAuth> {
    if (this.auth && this.auth.expiresAt > Date.now()) return this.auth;

    const token = await requestAccessToken();
    this.auth = {
      accessToken: token.accessToken,
      instanceUrl: token.instanceUrl,
      expiresAt: Date.now() + 30 * 60 * 1000,
    };
    return this.auth;
  }

  /**
   * One bounded request. A 401 means the cached token is no longer good —
   * Salesforce can revoke or expire it ahead of our own clock — so the token is
   * dropped and the call retried once with a fresh one.
   */
  private async request(
    buildUrl: (auth: SalesforceAuth) => string,
    init: RequestInit = {},
    { allowReauth = true }: { allowReauth?: boolean } = {},
  ): Promise<Response> {
    const auth = await this.authenticate();

    let response: Response;
    try {
      response = await fetch(buildUrl(auth), {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${auth.accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      // A timeout or a dropped connection — transient by nature.
      const reason = caught instanceof Error ? caught.name : "unknown error";
      throw new SalesforceSyncError(
        `Salesforce did not respond within ${REQUEST_TIMEOUT_MS / 1000}s (${reason}).`,
        { code: "NETWORK", retryable: true },
      );
    }

    if (response.status === 401 && allowReauth) {
      this.auth = null;
      return this.request(buildUrl, init, { allowReauth: false });
    }

    return response;
  }

  /** Reads are idempotent, so transient failures are retried. */
  private async readWithRetry(
    buildUrl: (auth: SalesforceAuth) => string,
    init: RequestInit = {},
  ): Promise<Response> {
    let lastError: SalesforceSyncError | null = null;

    for (let attempt = 1; attempt <= MAX_READ_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.request(buildUrl, init);
        if (response.ok) return response;

        const transient = response.status === 429 || response.status >= 500;
        if (!transient || attempt === MAX_READ_ATTEMPTS) {
          throw new SalesforceSyncError(await describeError(response), {
            code: "QUERY_FAILED",
            retryable: transient,
          });
        }
        lastError = new SalesforceSyncError(await describeError(response), {
          code: "QUERY_FAILED",
          retryable: true,
        });
      } catch (caught) {
        const error =
          caught instanceof SalesforceSyncError
            ? caught
            : new SalesforceSyncError(String(caught), { code: "NETWORK", retryable: true });
        if (!error.retryable || attempt === MAX_READ_ATTEMPTS) throw error;
        lastError = error;
      }

      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }

    throw lastError ?? new SalesforceSyncError("Salesforce read failed.", { code: "QUERY_FAILED" });
  }

  private async query<T>(soql: string): Promise<T[]> {
    const results: T[] = [];
    let path: string | null = `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;

    while (path) {
      const nextPath: string = path;
      const response = await this.readWithRetry((auth) => `${auth.instanceUrl}${nextPath}`);
      const page = (await response.json()) as {
        records: T[];
        done: boolean;
        nextRecordsUrl?: string;
      };
      results.push(...page.records);
      path = page.done || !page.nextRecordsUrl ? null : page.nextRecordsUrl;
    }

    return results;
  }

  private async patchOpportunity(externalId: string, fields: Record<string, unknown>) {
    // Deliberately NOT routed through readWithRetry: replaying a write is a
    // decision for the sync service, not the transport.
    const response = await this.request(
      (auth) =>
        `${auth.instanceUrl}/services/data/${API_VERSION}/sobjects/Opportunity/${encodeURIComponent(externalId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      },
    );

    if (!response.ok) {
      throw new SalesforceSyncError(await describeError(response), {
        code: "UPDATE_FAILED",
        retryable: response.status >= 500 || response.status === 429,
      });
    }
  }

  private toDomain(row: SalesforceOpportunityRow): SalesforceOpportunity | null {
    const stage = stageFromSalesforce(row.StageName);
    if (!stage) return null;

    const instanceUrl = this.auth?.instanceUrl ?? env.salesforce.instanceUrl;
    return {
      externalId: row.Id,
      opportunityName: row.Name,
      projectName: row.Name,
      customerName: row.Account?.Name ?? "Unknown account",
      amount: row.Amount ?? 0,
      stage,
      closeDate: row.CloseDate ? new Date(row.CloseDate) : null,
      url: `${instanceUrl}/lightning/r/Opportunity/${row.Id}/view`,
      ownerExternalId: row.OwnerId,
      // The partner account drives recipient resolution. Orgs that sell direct
      // leave the lookup empty, in which case the opportunity's own Account is
      // both the customer and the partner.
      accountExternalId: row.AccountId ?? "",
      primaryContactExternalId: row.OpportunityContactRoles?.records?.[0]?.ContactId ?? null,
    };
  }
}

type SalesforceOpportunityRow = {
  Id: string;
  Name: string;
  Amount: number | null;
  StageName: string;
  CloseDate: string | null;
  OwnerId: string;
  AccountId: string | null;
  Account: { Name: string } | null;
  OpportunityContactRoles?: { records: { ContactId: string }[] } | null;
};

function escapeSoql(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function describeError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as Array<{ message?: string; errorCode?: string }>;
    const first = Array.isArray(parsed) ? parsed[0] : null;
    if (first?.message) return `${first.errorCode ?? response.status}: ${first.message}`;
  } catch {
    // fall through to the raw body
  }
  return `Salesforce request failed (${response.status}) ${text.slice(0, 200)}`.trim();
}
