import { accountTypeFromSalesforce } from "@/lib/account-types";
import { env } from "@/lib/env";
import { stageFromSalesforce, stageToSalesforce, type OpportunityStage } from "@/lib/stages";
import {
  SalesforceSyncError,
  type OpportunityStatusUpdate,
  type SalesforceAccount,
  type SalesforceContact,
  type SalesforceOpportunity,
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
 * scope is StageName and CloseDate only — NOTE_FIELD is retained for the mock
 * provider's benefit but is not part of the confirmed write scope.
 */

const API_VERSION = "v61.0";
const NOTE_FIELD = "Description";

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

  async updateOpportunityStatus(externalId: string, stage: OpportunityStage): Promise<void> {
    await this.patchOpportunity(externalId, { StageName: stageToSalesforce(stage) });
  }

  async updateOpportunityComment(
    externalId: string,
    comment: string,
    source?: string,
  ): Promise<void> {
    const stamp = source ? `[${source}] ` : "";
    await this.patchOpportunity(externalId, { [NOTE_FIELD]: `${stamp}${comment}` });
  }

  async applyUpdate(update: OpportunityStatusUpdate): Promise<void> {
    const payload: Record<string, unknown> = { StageName: stageToSalesforce(update.stage) };
    if (update.comment?.trim()) {
      const stamp = update.source ? `[${update.source}] ` : "";
      payload[NOTE_FIELD] = `${stamp}${update.comment.trim()}`;
    }
    await this.patchOpportunity(update.externalId, payload);
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

  private async query<T>(soql: string): Promise<T[]> {
    const auth = await this.authenticate();
    const results: T[] = [];
    let url: string | null = `${auth.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;

    while (url) {
      const response: Response = await fetch(url, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });
      if (!response.ok) {
        throw new SalesforceSyncError(await describeError(response), { code: "QUERY_FAILED" });
      }
      const page = (await response.json()) as {
        records: T[];
        done: boolean;
        nextRecordsUrl?: string;
      };
      results.push(...page.records);
      url = page.done || !page.nextRecordsUrl ? null : `${auth.instanceUrl}${page.nextRecordsUrl}`;
    }

    return results;
  }

  private async patchOpportunity(externalId: string, fields: Record<string, unknown>) {
    const auth = await this.authenticate();
    const response = await fetch(
      `${auth.instanceUrl}/services/data/${API_VERSION}/sobjects/Opportunity/${externalId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          "Content-Type": "application/json",
        },
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
