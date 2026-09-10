import "dotenv/config";
import { ACCOUNT_TYPES } from "@/lib/account-types";
import { env } from "@/lib/env";
import { OPPORTUNITY_STAGES } from "@/lib/stages";
import {
  fetchIdentity,
  getAuthFlow,
  missingCredentials,
  requestAccessToken,
} from "@/server/integrations/salesforce/live/auth";
import { LiveSalesforceService } from "@/server/integrations/salesforce/live/salesforce-service";

/**
 * Read-only Salesforce/SFX connection smoke test.
 *
 *   npm run sf:smoke
 *
 * Answers the questions that block turning on SALESFORCE_PROVIDER=salesforce,
 * against the real org, without changing anything:
 *
 *   1. Do the credentials authenticate at all?
 *   2. Do the fields the live provider queries actually exist?
 *   3. Does the StageName picklist match our four controlled values?
 *   4. Does Account.Type match our organization types?
 *   5. How much data would a campaign actually pick up — and how much would it
 *      skip or fail to route?
 *
 * SAFETY: this script only ever issues the OAuth token request and GET
 * requests (describe + SOQL SELECT). It never PATCHes, POSTs a record, or
 * writes anything. Credentials are read from .env and never printed — only a
 * masked fingerprint, so you can confirm which credentials were loaded.
 *
 * Findings map onto the decisions in
 * src/server/integrations/salesforce/FIELD-MAPPING.md §9.
 */

const API_VERSION = "v61.0";

// Fields the live provider's queries depend on. Base fields are standard and
// should always exist; the __c ones are placeholders that need to be replaced
// with whatever IDS actually uses (FIELD-MAPPING.md decisions 1-3).
const OPPORTUNITY_BASE_FIELDS = [
  "Id",
  "Name",
  "Amount",
  "StageName",
  "CloseDate",
  "OwnerId",
  "AccountId",
  "IsClosed",
];
const OPPORTUNITY_PLACEHOLDER_FIELDS = ["Partner_Account__c", "IDS_CheckIn_Contact__c"];
const CONTACT_BASE_FIELDS = ["Id", "AccountId", "Name", "Email"];
const CONTACT_PLACEHOLDER_FIELDS = ["IDS_Primary_CheckIn_Contact__c"];
const NOTE_FIELD_CANDIDATES = ["Description", "IDS_CheckIn_Note__c"];

type DescribeField = {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  updateable: boolean;
  picklistValues?: { value: string; label: string; active: boolean }[];
};

type DescribeResult = { name: string; fields: DescribeField[] };

let failures = 0;
let warnings = 0;

function section(title: string) {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

function ok(message: string) {
  console.log(`  ✓ ${message}`);
}

function warn(message: string) {
  warnings += 1;
  console.log(`  ⚠ ${message}`);
}

function fail(message: string) {
  failures += 1;
  console.log(`  ✗ ${message}`);
}

function info(message: string) {
  console.log(`    ${message}`);
}

/**
 * Last four characters only — enough to confirm which credential loaded,
 * useless to steal. Values too short to mask safely are never echoed.
 */
function fingerprint(value: string): string {
  if (!value) return "(not set)";
  if (value.length < 12) return `(set, ${value.length} chars — too short to display safely)`;
  return `${"•".repeat(8)}${value.slice(-4)} (${value.length} chars)`;
}

/**
 * Reports the loaded configuration (masked) and authenticates through the same
 * module the application itself uses, so a pass here means the app's own auth
 * path works — not merely that some credentials exist somewhere.
 */
async function authenticate(): Promise<{ accessToken: string; instanceUrl: string }> {
  const flow = getAuthFlow();

  info(`auth flow:     ${flow}${flow === "client_credentials" ? "  (External Client App Run As user)" : ""}`);
  info(`login url:     ${env.salesforce.loginUrl}`);
  info(`client id:     ${fingerprint(env.salesforce.clientId)}`);
  info(`client secret: ${fingerprint(env.salesforce.clientSecret)}`);
  if (flow === "password") {
    info(`username:      ${env.salesforce.username || "(not set)"}`);
    info(`password:      ${fingerprint(env.salesforce.password)} (security token appended?)`);
  } else {
    info(`username/password: not used by this flow — identity comes from the app's Run As user`);
  }
  console.log();

  const missing = missingCredentials(flow);
  if (missing.length > 0) {
    throw new Error(`Missing required credentials in .env for the ${flow} flow: ${missing.join(", ")}.`);
  }

  // The client credentials flow is issued by the org's My Domain host. The
  // generic login host usually rejects it, so flag it before the round trip.
  if (flow === "client_credentials" && /(^|\/\/)(login|test)\.salesforce\.com/.test(env.salesforce.loginUrl)) {
    warn(
      `SF_LOGIN_URL is "${env.salesforce.loginUrl}". The client credentials flow normally requires ` +
        `your My Domain host (e.g. https://idsculpture.my.salesforce.com, or ` +
        `https://idsculpture--<sandbox>.sandbox.my.salesforce.com). Expect invalid_client if this is wrong.`,
    );
    console.log();
  }

  const token = await requestAccessToken(flow);
  return { accessToken: token.accessToken, instanceUrl: token.instanceUrl };
}

async function describe(
  auth: { accessToken: string; instanceUrl: string },
  sobject: string,
): Promise<DescribeResult> {
  const response = await fetch(
    `${auth.instanceUrl}/services/data/${API_VERSION}/sobjects/${sobject}/describe`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`Describe ${sobject} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as DescribeResult;
}

async function query<T>(
  auth: { accessToken: string; instanceUrl: string },
  soql: string,
): Promise<{ records: T[]; totalSize: number }> {
  const response = await fetch(
    `${auth.instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
    { headers: { Authorization: `Bearer ${auth.accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`Query failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as { records: T[]; totalSize: number };
}

/** Reports which of the expected fields exist, and lists the custom ones that do. */
function checkFields(
  describeResult: DescribeResult,
  baseFields: string[],
  placeholderFields: string[],
) {
  const byName = new Map(describeResult.fields.map((field) => [field.name.toLowerCase(), field]));

  for (const name of baseFields) {
    if (byName.has(name.toLowerCase())) ok(`${describeResult.name}.${name}`);
    else fail(`${describeResult.name}.${name} — MISSING (standard field; check field-level security)`);
  }

  for (const name of placeholderFields) {
    if (byName.has(name.toLowerCase())) {
      ok(`${describeResult.name}.${name} — exists`);
    } else {
      warn(
        `${describeResult.name}.${name} — does not exist. This is a placeholder in the live ` +
          `provider; it must be replaced with the real field (see the custom fields below).`,
      );
    }
  }

  const custom = describeResult.fields.filter((field) => field.custom);
  if (custom.length === 0) {
    info(`No custom fields on ${describeResult.name}.`);
    return;
  }

  console.log(`\n    Custom fields on ${describeResult.name} (${custom.length}) — look here for the real equivalents:`);
  for (const field of custom) {
    const relationship = field.type === "reference" ? " → lookup" : "";
    info(`  ${field.name} (${field.type}${relationship}) "${field.label}"`);
  }
}

/** Compares an org picklist against the values this application controls. */
function comparePicklist(
  describeResult: DescribeResult,
  fieldName: string,
  expected: { label: string; salesforceValue: string }[],
) {
  const field = describeResult.fields.find(
    (candidate) => candidate.name.toLowerCase() === fieldName.toLowerCase(),
  );
  if (!field) {
    fail(`${describeResult.name}.${fieldName} not found — cannot compare picklist.`);
    return;
  }

  const actual = (field.picklistValues ?? []).filter((value) => value.active);
  if (actual.length === 0) {
    warn(`${describeResult.name}.${fieldName} has no active picklist values (is it a picklist?).`);
    return;
  }

  const actualByValue = new Map(actual.map((value) => [value.value.toLowerCase(), value]));

  for (const entry of expected) {
    if (actualByValue.has(entry.salesforceValue.toLowerCase())) {
      ok(`"${entry.salesforceValue}" exists in the org`);
    } else {
      warn(
        `"${entry.salesforceValue}" is NOT in the org picklist — update salesforceValue for ` +
          `${entry.label}, or the mapping will silently skip these records.`,
      );
    }
  }

  const expectedValues = new Set(expected.map((entry) => entry.salesforceValue.toLowerCase()));
  const unmapped = actual.filter((value) => !expectedValues.has(value.value.toLowerCase()));
  if (unmapped.length > 0) {
    console.log(`\n    Org values NOT mapped by this app (records in these are skipped):`);
    for (const value of unmapped) info(`  "${value.value}"`);
  }
}

async function main() {
  console.log("\nIDS Opportunity Check-In — Salesforce connection smoke test");
  console.log("Read-only. No records are created, updated, or deleted.");

  // ---- 1. Authentication --------------------------------------------------
  section("1. Authentication");
  let auth: { accessToken: string; instanceUrl: string };
  try {
    auth = await authenticate();
    ok(`Authenticated. Instance: ${auth.instanceUrl}`);
    if (!env.salesforce.instanceUrl) {
      info(`SF_INSTANCE_URL is not set; using the instance the token returned.`);
      info(`Consider setting SF_INSTANCE_URL=${auth.instanceUrl}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    console.log("\nCannot continue without authentication.\n");
    process.exit(1);
  }

  // ---- 1b. Who are we actually acting as? ---------------------------------
  section("1b. Integration identity (who this application acts as)");
  try {
    const identity = await fetchIdentity({ ...auth, identityUrl: null });
    if (!identity) {
      warn("Could not read /services/oauth2/userinfo — the token works, but identity is unconfirmed.");
    } else {
      ok(`Running as: ${identity.displayName} <${identity.username}>`);
      info(`user id:         ${identity.userId}`);
      info(`organization id: ${identity.organizationId}`);

      // Optional guard against the app silently running as the wrong user —
      // e.g. a Run As setting changed to someone's personal account. Opt-in,
      // because the correct username differs between orgs and sandboxes, and
      // hardcoding one here would be wrong everywhere except a single org.
      const expected = (process.env.SF_EXPECTED_USERNAME ?? "").trim();
      if (!expected) {
        info("");
        info("Set SF_EXPECTED_USERNAME in .env to assert this is the intended");
        info("integration user on every run.");
      } else if (identity.username.toLowerCase() === expected.toLowerCase()) {
        ok(`Matches SF_EXPECTED_USERNAME — this is the intended integration user.`);
      } else {
        warn(
          `Identity does not match SF_EXPECTED_USERNAME.\n` +
            `      expected: ${expected}\n` +
            `      actual:   ${identity.username}\n` +
            `      Check the External Client App's Policies → Run As user. Running as a personal ` +
            `account means the app inherits that person's permissions and breaks when they leave.`,
        );
      }
    }
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
  }

  // ---- 2. Opportunity -----------------------------------------------------
  section("2. Opportunity fields");
  let opportunityDescribe: DescribeResult | null = null;
  try {
    opportunityDescribe = await describe(auth, "Opportunity");
    checkFields(opportunityDescribe, OPPORTUNITY_BASE_FIELDS, OPPORTUNITY_PLACEHOLDER_FIELDS);

    console.log("\n    Note field candidates (where a contact's comment would be written):");
    for (const name of NOTE_FIELD_CANDIDATES) {
      const field = opportunityDescribe.fields.find(
        (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
      );
      if (!field) info(`  ${name} — does not exist`);
      else if (!field.updateable) warn(`${name} exists but is NOT updateable by this user`);
      else ok(`${name} exists and is updateable`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // ---- 3. Stage picklist --------------------------------------------------
  section("3. Opportunity.StageName picklist vs the four controlled stages");
  if (opportunityDescribe) {
    comparePicklist(opportunityDescribe, "StageName", [...OPPORTUNITY_STAGES]);
  } else {
    fail("Skipped — Opportunity describe failed.");
  }

  // ---- 4. Account ---------------------------------------------------------
  section("4. Account.Type picklist vs the organization types");
  try {
    const accountDescribe = await describe(auth, "Account");
    comparePicklist(accountDescribe, "Type", [...ACCOUNT_TYPES]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // ---- 5. Contact ---------------------------------------------------------
  section("5. Contact fields (the check-in recipients)");
  try {
    const contactDescribe = await describe(auth, "Contact");
    checkFields(contactDescribe, CONTACT_BASE_FIELDS, CONTACT_PLACEHOLDER_FIELDS);
    info("");
    info("Salesforce Contacts have no IsActive field. Decision #3 in FIELD-MAPPING.md:");
    info("pick the field that marks a contact as gone (status picklist, Inactive__c,");
    info("HasOptedOutOfEmail, …) — until then the live provider treats everyone as active.");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // ---- 6. Data shape ------------------------------------------------------
  section("6. What a campaign would actually pick up (read-only counts)");
  try {
    const openCount = await query<never>(auth, "SELECT COUNT() FROM Opportunity WHERE IsClosed = false");
    ok(`Open opportunities (IsClosed = false): ${openCount.totalSize}`);

    const byStage = await query<{ StageName: string; expr0: number }>(
      auth,
      "SELECT StageName, COUNT(Id) FROM Opportunity WHERE IsClosed = false GROUP BY StageName",
    );
    const mapped = new Set(OPPORTUNITY_STAGES.map((stage) => stage.salesforceValue.toLowerCase()));
    let wouldSkip = 0;
    console.log("\n    Open opportunities by stage:");
    for (const row of byStage.records) {
      const isMapped = mapped.has((row.StageName ?? "").toLowerCase());
      if (!isMapped) wouldSkip += row.expr0;
      info(`  ${isMapped ? "✓" : "✗"} ${row.StageName ?? "(none)"}: ${row.expr0}${isMapped ? "" : "  ← skipped, stage not mapped"}`);
    }
    if (wouldSkip > 0) {
      warn(`${wouldSkip} open opportunities sit in unmapped stages and would be excluded entirely.`);
    } else {
      ok("Every open opportunity is in a mapped stage.");
    }

    const contactCount = await query<never>(auth, "SELECT COUNT() FROM Contact WHERE Email != null");
    ok(`Contacts with an email address: ${contactCount.totalSize}`);

    // The "needs attention" preview: open opportunities whose account has
    // nobody we could email. Every one of these is a routing failure on day 1.
    const noContact = await query<never>(
      auth,
      "SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND AccountId NOT IN " +
        "(SELECT AccountId FROM Contact WHERE Email != null)",
    );
    if (noContact.totalSize > 0) {
      warn(
        `${noContact.totalSize} open opportunities belong to an account with no emailable contact — ` +
          `these become "needs attention" items, not check-ins.`,
      );
    } else {
      ok("Every open opportunity's account has at least one emailable contact.");
    }

    const multiContact = await query<{ AccountId: string; expr0: number }>(
      auth,
      "SELECT AccountId, COUNT(Id) FROM Contact WHERE Email != null GROUP BY AccountId HAVING COUNT(Id) > 1",
    );
    if (multiContact.records.length > 0) {
      warn(
        `${multiContact.records.length} accounts have more than one emailable contact — each needs a ` +
          `primary flag, or recipient resolution will pick one and flag it ambiguous.`,
      );
    } else {
      ok("No account has competing contacts — recipient resolution will be unambiguous.");
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // ---- 7. The application's own provider ----------------------------------
  section("7. The application's Salesforce provider (read-only call)");
  try {
    // Exercises LiveSalesforceService end to end — auth, SOQL, and mapping —
    // using getSalesReps(), which touches only standard User fields and so is
    // unaffected by the custom-field decisions still outstanding above.
    const reps = await new LiveSalesforceService().getSalesReps();
    ok(`LiveSalesforceService.getSalesReps() returned ${reps.length} active users.`);
    if (reps.length === 0) {
      warn("No active users returned — check the integration user's access to the User object.");
    } else {
      info("Sample (first 3):");
      for (const rep of reps.slice(0, 3)) info(`  ${rep.name} <${rep.email}>`);
      info("");
      info("Note: this returns ALL active users. Narrowing it to actual sales reps is");
      info("decision #1 in FIELD-MAPPING.md — a Role, Profile, or custom flag.");
    }
  } catch (error) {
    fail(
      `The application's provider could not read from Salesforce: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ---- Summary ------------------------------------------------------------
  section("Summary");
  if (failures === 0 && warnings === 0) {
    console.log("  All checks passed. The org matches what the live provider expects.\n");
  } else {
    console.log(`  ${failures} failure(s), ${warnings} warning(s).\n`);
    console.log("  Failures block the integration. Warnings are the mapping decisions in");
    console.log("  src/server/integrations/salesforce/FIELD-MAPPING.md §9 — resolve them by");
    console.log("  editing the constants in live/salesforce-service.ts, lib/stages.ts and");
    console.log("  lib/account-types.ts. No business logic changes.\n");
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("\nUnexpected error:", error);
  process.exit(1);
});
