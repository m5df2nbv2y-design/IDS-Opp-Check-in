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

/**
 * ===========================================================================
 *  THIS IS WHERE THE REAL SALESFORCE/SFX INTEGRATION PLUGS IN.
 * ===========================================================================
 *
 * Nothing else in the application changes: set
 *
 *   SALESFORCE_PROVIDER=salesforce
 *   SF_LOGIN_URL / SF_CLIENT_ID / SF_CLIENT_SECRET / SF_USERNAME / SF_PASSWORD
 *
 * and the factory in ../index.ts returns this class instead of the mock.
 *
 * Four queries need org-specific confirmation before go-live — each is a single
 * constant below, and each is listed in ../FIELD-MAPPING.md:
 *
 *   1. OPEN_OPPORTUNITY_SOQL  — what "open" means, and where the partner
 *      account and check-in contact live on the Opportunity.
 *   2. ACCOUNT_SOQL           — which accounts are external partners.
 *   3. CONTACT_SOQL           — which contacts are check-in recipients, and
 *      which field marks the primary one.
 *   4. NOTE_FIELD             — where the recipient's note is written.
 */

const API_VERSION = "v61.0";
const NOTE_FIELD = "Description";

/**
 * `IDS_CheckIn_Contact__c` and `Partner_Account__c` are placeholders for the
 * org's real fields. If IDS uses Opportunity Contact Roles instead of a lookup,
 * replace the field with a subquery on `OpportunityContactRoles` (see §2 of
 * FIELD-MAPPING.md) — the mapping in `toDomain` is the only thing that changes.
 */
const OPEN_OPPORTUNITY_SOQL = `
  SELECT Id, Name, Amount, StageName, CloseDate, OwnerId,
         AccountId, Account.Name,
         Partner_Account__c, IDS_CheckIn_Contact__c
  FROM Opportunity
  WHERE IsClosed = false
`;

const ACCOUNT_SOQL = `SELECT Id, Name, Type FROM Account WHERE IsDeleted = false`;

const CONTACT_SOQL = `
  SELECT Id, AccountId, Name, Email, IsDeleted, IDS_Primary_CheckIn_Contact__c
  FROM Contact
  WHERE IsDeleted = false AND Email != null
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
      IDS_Primary_CheckIn_Contact__c?: boolean;
    }>(soql);

    return rows
      .filter((row) => row.AccountId)
      .map((row) => ({
        externalId: row.Id,
        accountExternalId: row.AccountId!,
        name: row.Name,
        email: row.Email,
        isPrimary: Boolean(row.IDS_Primary_CheckIn_Contact__c),
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

  private async authenticate(): Promise<SalesforceAuth> {
    if (this.auth && this.auth.expiresAt > Date.now()) return this.auth;

    const { clientId, clientSecret, username, password, loginUrl } = env.salesforce;
    if (!clientId || !clientSecret || !username || !password) {
      throw new SalesforceSyncError(
        "Salesforce credentials are not configured. Set SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME and SF_PASSWORD, or run with SALESFORCE_PROVIDER=mock.",
        { code: "NOT_CONFIGURED", retryable: false },
      );
    }

    const response = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: clientId,
        client_secret: clientSecret,
        username,
        password,
      }),
    });

    if (!response.ok) {
      throw new SalesforceSyncError(`Salesforce authentication failed (${response.status}).`, {
        code: "AUTH_FAILED",
      });
    }

    const json = (await response.json()) as { access_token: string; instance_url: string };
    this.auth = {
      accessToken: json.access_token,
      instanceUrl: env.salesforce.instanceUrl || json.instance_url,
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
      accountExternalId: row.Partner_Account__c ?? row.AccountId ?? "",
      contactExternalId: row.IDS_CheckIn_Contact__c ?? null,
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
  Partner_Account__c?: string | null;
  IDS_CheckIn_Contact__c?: string | null;
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
