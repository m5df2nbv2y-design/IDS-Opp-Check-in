import "dotenv/config";
import { requestAccessToken, type SalesforceToken } from "@/server/integrations/salesforce/live/auth";

/**
 * Read-only Salesforce data discovery.
 *
 *   npm run sf:discover
 *
 * Answers "what does the data actually look like?" before any mapping decision
 * is made. Pure investigation: it issues only GET requests (describe + SOQL
 * SELECT) and never creates, updates, or deletes anything.
 *
 * Deliberately makes no recommendations in code — it reports distributions and
 * lets a human decide. Where the data does not support a rule, the numbers say
 * so rather than a default being invented.
 */

const API = "v61.0";

let token: SalesforceToken;

async function soql<T>(query: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${token.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(query)}`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = (await res.json()) as { records: T[]; done: boolean; nextRecordsUrl?: string };
    out.push(...page.records);
    url = page.done || !page.nextRecordsUrl ? null : `${token.instanceUrl}${page.nextRecordsUrl}`;
  }
  return out;
}

async function count(query: string): Promise<number> {
  const res = await fetch(`${token.instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { totalSize: number }).totalSize;
}

async function picklist(sobject: string, field: string): Promise<string[] | null> {
  const res = await fetch(`${token.instanceUrl}/services/data/${API}/sobjects/${sobject}/describe`, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });
  if (!res.ok) return null;
  const described = (await res.json()) as {
    fields: { name: string; picklistValues?: { value: string; active: boolean }[] }[];
  };
  const found = described.fields.find((f) => f.name.toLowerCase() === field.toLowerCase());
  if (!found?.picklistValues) return null;
  return found.picklistValues.filter((v) => v.active).map((v) => v.value);
}

function section(title: string) {
  console.log(`\n${"═".repeat(74)}\n${title}\n${"═".repeat(74)}`);
}

function table(rows: [string, number][], total?: number) {
  const width = Math.max(...rows.map(([label]) => label.length), 10);
  for (const [label, n] of rows) {
    const pct = total && total > 0 ? ` ${((n / total) * 100).toFixed(1)}%`.padStart(7) : "";
    console.log(`    ${label.padEnd(width)}  ${String(n).padStart(6)}${pct}`);
  }
}

type Agg = { expr0: number };

async function main() {
  token = await requestAccessToken();
  console.log("Salesforce read-only data discovery");
  console.log(`Org: ${token.instanceUrl}`);
  console.log("Only SELECT and describe calls — nothing is modified.");

  const openOpps = await count("SELECT COUNT() FROM Opportunity WHERE IsClosed = false");
  console.log(`\nOpen opportunities: ${openOpps}`);

  // ---- A. Contact.Contact_Type__c ----------------------------------------
  section("A. Contact.Contact_Type__c");
  const contactTypeValues = await picklist("Contact", "Contact_Type__c");
  console.log(`  Defined picklist values (${contactTypeValues?.length ?? 0}):`);
  if (contactTypeValues?.length) {
    for (const v of contactTypeValues) console.log(`    - ${v}`);
  } else {
    console.log("    (none readable)");
  }

  const totalContacts = await count("SELECT COUNT() FROM Contact");
  const emailable = await count("SELECT COUNT() FROM Contact WHERE Email != null");
  console.log(`\n  Contacts: ${totalContacts} total, ${emailable} with an email address`);

  const byType = await soql<{ Contact_Type__c: string | null } & Agg>(
    "SELECT Contact_Type__c, COUNT(Id) FROM Contact WHERE Email != null GROUP BY Contact_Type__c",
  );
  console.log("\n  Emailable contacts by Contact_Type__c:");
  table(
    byType
      .map((r) => [r.Contact_Type__c ?? "(blank)", r.expr0] as [string, number])
      .sort((a, b) => b[1] - a[1]),
    emailable,
  );

  // ---- B. Account → Contact ----------------------------------------------
  section("B. Account → Contact, for accounts with open opportunities");

  const oppAccounts = await soql<{ AccountId: string | null } & Agg>(
    "SELECT AccountId, COUNT(Id) FROM Opportunity WHERE IsClosed = false GROUP BY AccountId",
  );
  const accountsWithOpenOpps = new Set(
    oppAccounts.flatMap((r) => (r.AccountId ? [r.AccountId] : [])),
  );
  const oppsWithNoAccount = oppAccounts.find((r) => !r.AccountId)?.expr0 ?? 0;
  console.log(`  Distinct accounts with open opportunities: ${accountsWithOpenOpps.size}`);
  console.log(`  Open opportunities with NO AccountId:      ${oppsWithNoAccount}`);

  const contactsPerAccount = await soql<{ AccountId: string | null } & Agg>(
    "SELECT AccountId, COUNT(Id) FROM Contact WHERE Email != null GROUP BY AccountId",
  );
  const emailableByAccount = new Map<string, number>();
  for (const r of contactsPerAccount) {
    if (r.AccountId) emailableByAccount.set(r.AccountId, r.expr0);
  }

  let zero = 0;
  let one = 0;
  let many = 0;
  const multiAccountIds: string[] = [];
  for (const id of accountsWithOpenOpps) {
    const n = emailableByAccount.get(id) ?? 0;
    if (n === 0) zero += 1;
    else if (n === 1) one += 1;
    else {
      many += 1;
      multiAccountIds.push(id);
    }
  }
  console.log("\n  Emailable contacts per account (accounts with open opportunities):");
  table(
    [
      ["zero contacts", zero],
      ["exactly one", one],
      ["more than one", many],
    ],
    accountsWithOpenOpps.size,
  );

  // How ambiguous are the multi-contact accounts, really?
  if (multiAccountIds.length > 0) {
    const sample = multiAccountIds.slice(0, 300);
    const contacts = await soql<{
      AccountId: string;
      Contact_Type__c: string | null;
    }>(
      `SELECT AccountId, Contact_Type__c FROM Contact WHERE Email != null AND AccountId IN (${sample
        .map((id) => `'${id}'`)
        .join(",")})`,
    );

    const grouped = new Map<string, (string | null)[]>();
    for (const c of contacts) {
      const list = grouped.get(c.AccountId) ?? [];
      list.push(c.Contact_Type__c);
      grouped.set(c.AccountId, list);
    }

    let exactlyOneTyped = 0;
    let multipleTyped = 0;
    let noneTyped = 0;
    const typeCounter = new Map<string, number>();
    for (const types of grouped.values()) {
      const named = types.filter((t): t is string => Boolean(t));
      for (const t of named) typeCounter.set(t, (typeCounter.get(t) ?? 0) + 1);
      if (named.length === 0) noneTyped += 1;
      else if (new Set(named).size === named.length && named.length === 1) exactlyOneTyped += 1;
      else multipleTyped += 1;
    }

    console.log(`\n  Of ${grouped.size} sampled multi-contact accounts, by Contact_Type__c:`);
    table(
      [
        ["exactly one typed contact", exactlyOneTyped],
        ["several typed contacts", multipleTyped],
        ["no typed contacts at all", noneTyped],
      ],
      grouped.size,
    );
    console.log("\n  Contact_Type__c values present at those accounts:");
    table([...typeCounter.entries()].sort((a, b) => b[1] - a[1]));
  }

  // ---- C. Opportunity Contact Roles --------------------------------------
  section("C. Opportunity Contact Roles");
  try {
    const totalRoles = await count("SELECT COUNT() FROM OpportunityContactRole");
    const openRoles = await count(
      "SELECT COUNT() FROM OpportunityContactRole WHERE Opportunity.IsClosed = false",
    );
    console.log(`  Contact roles, all opportunities:  ${totalRoles}`);
    console.log(`  Contact roles, open opportunities: ${openRoles}`);

    if (openRoles > 0) {
      const rows = await soql<{ OpportunityId: string; IsPrimary: boolean; Role: string | null }>(
        "SELECT OpportunityId, IsPrimary, Role FROM OpportunityContactRole WHERE Opportunity.IsClosed = false",
      );
      const oppsCovered = new Set(rows.map((r) => r.OpportunityId));
      const oppsWithPrimary = new Set(rows.filter((r) => r.IsPrimary).map((r) => r.OpportunityId));
      console.log(`\n  Open opportunities WITH at least one contact role: ${oppsCovered.size} of ${openOpps}`);
      console.log(`  Open opportunities WITH a primary contact role:    ${oppsWithPrimary.size} of ${openOpps}`);
      console.log(`  Coverage: ${((oppsCovered.size / openOpps) * 100).toFixed(1)}% / primary ${((oppsWithPrimary.size / openOpps) * 100).toFixed(1)}%`);

      const roleCounter = new Map<string, number>();
      for (const r of rows) roleCounter.set(r.Role ?? "(blank)", (roleCounter.get(r.Role ?? "(blank)") ?? 0) + 1);
      console.log("\n  Role values on open opportunities:");
      table([...roleCounter.entries()].sort((a, b) => b[1] - a[1]), rows.length);
    } else {
      console.log("\n  Not populated on open opportunities.");
    }
  } catch (error) {
    console.log(`  Could not read OpportunityContactRole: ${error instanceof Error ? error.message : error}`);
  }

  // ---- D. Opportunity fields ---------------------------------------------
  section("D. Opportunity fields (open opportunities)");

  const stages = await soql<{ StageName: string | null } & Agg>(
    "SELECT StageName, COUNT(Id) FROM Opportunity WHERE IsClosed = false GROUP BY StageName",
  );
  console.log("  StageName:");
  table(
    stages.map((r) => [r.StageName ?? "(blank)", r.expr0] as [string, number]).sort((a, b) => b[1] - a[1]),
    openOpps,
  );

  const overdue = await count(
    "SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND CloseDate < TODAY",
  );
  const next90 = await count(
    "SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND CloseDate >= TODAY AND CloseDate <= NEXT_N_DAYS:90",
  );
  const noCloseDate = await count(
    "SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND CloseDate = null",
  );
  console.log("\n  CloseDate:");
  table(
    [
      ["in the past (overdue)", overdue],
      ["within next 90 days", next90],
      ["no close date", noCloseDate],
    ],
    openOpps,
  );

  for (const field of ["shopbuilt_or_sitebuilt__c", "Project_Type__c"]) {
    const values = await picklist("Opportunity", field);
    const dist = await soql<Record<string, unknown> & Agg>(
      `SELECT ${field}, COUNT(Id) FROM Opportunity WHERE IsClosed = false GROUP BY ${field}`,
    );
    console.log(`\n  ${field}  (${values?.length ?? 0} defined picklist values):`);
    table(
      dist
        .map((r) => [(r[field] as string | null) ?? "(blank)", r.expr0] as [string, number])
        .sort((a, b) => b[1] - a[1]),
      openOpps,
    );
  }

  // ---- E. Sales rep identification ---------------------------------------
  section("E. Distinguishing sales reps from other active users");

  const owners = await soql<{ OwnerId: string } & Agg>(
    "SELECT OwnerId, COUNT(Id) FROM Opportunity WHERE IsClosed = false GROUP BY OwnerId",
  );
  const ownerCounts = new Map(owners.map((r) => [r.OwnerId, r.expr0]));

  type DiscoveredUser = {
    Id: string;
    Name: string;
    Username: string;
    UserType: string | null;
    IsActive: boolean;
    Profile?: { Name: string } | null;
    UserRole?: { Name: string } | null;
  };

  // Profile/UserRole need "View Setup and Configuration"; fall back rather than
  // fail, and report which metadata this identity can actually see.
  const userQueries: [string, string][] = [
    ["Profile + Role", "SELECT Id, Name, Username, UserType, IsActive, Profile.Name, UserRole.Name FROM User WHERE IsActive = true"],
    ["Role only", "SELECT Id, Name, Username, UserType, IsActive, UserRole.Name FROM User WHERE IsActive = true"],
    ["base fields only", "SELECT Id, Name, Username, UserType, IsActive FROM User WHERE IsActive = true"],
  ];

  let users: DiscoveredUser[] = [];
  let usedQuery = "";
  for (const [label, q] of userQueries) {
    try {
      users = await soql<DiscoveredUser>(q);
      usedQuery = label;
      break;
    } catch {
      console.log(`  (cannot read ${label} on User — insufficient metadata access)`);
    }
  }
  console.log(`  User metadata available to this identity: ${usedQuery}\n`);

  console.log(`  Active users: ${users.length}. Open opportunities are owned by ${ownerCounts.size} of them.\n`);
  console.log(
    `    ${"Name".padEnd(26)}${"UserType".padEnd(12)}${"Profile".padEnd(28)}${"Role".padEnd(22)}open opps`,
  );
  const sorted = [...users].sort((a, b) => (ownerCounts.get(b.Id) ?? 0) - (ownerCounts.get(a.Id) ?? 0));
  for (const u of sorted) {
    const n = ownerCounts.get(u.Id) ?? 0;
    console.log(
      `    ${u.Name.slice(0, 25).padEnd(26)}${(u.UserType ?? "-").slice(0, 11).padEnd(12)}` +
        `${(u.Profile?.Name ?? "-").slice(0, 27).padEnd(28)}${(u.UserRole?.Name ?? "-").slice(0, 21).padEnd(22)}` +
        `${n > 0 ? String(n) : "-"}`,
    );
  }

  // Owners that are not in the active-user list at all (inactive owners).
  const activeIds = new Set(users.map((u) => u.Id));
  const inactiveOwners = [...ownerCounts.keys()].filter((id) => !activeIds.has(id));
  if (inactiveOwners.length > 0) {
    console.log(`\n  ⚠ ${inactiveOwners.length} owner(s) of open opportunities are INACTIVE users.`);
    const total = inactiveOwners.reduce((sum, id) => sum + (ownerCounts.get(id) ?? 0), 0);
    console.log(`    They own ${total} open opportunities, which would be excluded by the current filter.`);
  }

  // ---- F. Account.Type ----------------------------------------------------
  section("F. Account.Type for accounts with open opportunities");

  const accountTypeValues = await picklist("Account", "Type");
  console.log(`  Defined picklist values (${accountTypeValues?.length ?? 0}):`);
  for (const v of accountTypeValues ?? []) console.log(`    - ${v}`);

  const byTypeOpps = await soql<{ Type: string | null } & Agg>(
    "SELECT Account.Type, COUNT(Id) FROM Opportunity WHERE IsClosed = false GROUP BY Account.Type",
  );
  console.log("\n  Open OPPORTUNITIES by Account.Type:");
  table(
    byTypeOpps.map((r) => [r.Type ?? "(blank)", r.expr0] as [string, number]).sort((a, b) => b[1] - a[1]),
    openOpps,
  );

  const accountRows = await soql<{ Id: string; Type: string | null }>(
    `SELECT Id, Type FROM Account WHERE Id IN (${[...accountsWithOpenOpps]
      .slice(0, 800)
      .map((id) => `'${id}'`)
      .join(",")})`,
  );
  const accountTypeCounter = new Map<string, number>();
  for (const a of accountRows) {
    const key = a.Type ?? "(blank)";
    accountTypeCounter.set(key, (accountTypeCounter.get(key) ?? 0) + 1);
  }
  console.log(`\n  Distinct ACCOUNTS by Type (sampled ${accountRows.length}):`);
  table([...accountTypeCounter.entries()].sort((a, b) => b[1] - a[1]), accountRows.length);

  console.log("\nDiscovery complete. Read-only — nothing was modified.\n");
}

main().catch((error) => {
  console.error("\nDiscovery failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
