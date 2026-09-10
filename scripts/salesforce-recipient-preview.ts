import "dotenv/config";
import { writeFileSync } from "node:fs";
import { LiveSalesforceService } from "@/server/integrations/salesforce/live/salesforce-service";
import {
  RESOLUTION_REASON_LABELS,
  resolveRecipients,
  type ResolutionReason,
} from "@/server/services/recipient-resolution-service";

/**
 * Read-only recipient preview.
 *
 *   npm run sf:preview            summary to the terminal
 *   npm run sf:preview -- --csv   also writes the full row-by-row preview
 *
 * Runs the CANONICAL recipient-resolution rule across every open opportunity
 * in the real org and reports exactly who would be contacted — before anything
 * is ever sent. Sends nothing, writes nothing to Salesforce, changes no stage
 * or close date. Discovery is not authorization to send.
 */

const CSV_PATH = "salesforce-recipient-preview.csv";

function csvCell(value: string | number | null | undefined): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function main() {
  const salesforce = new LiveSalesforceService();

  console.log("Recipient preview — canonical rule");
  console.log("  Opportunity → Primary Opportunity Contact Role → Contact → Email");
  console.log("Read-only. No email is sent and no Salesforce record is modified.\n");

  const [opportunities, contacts, accounts, reps] = await Promise.all([
    salesforce.getOpenOpportunities(),
    salesforce.getExternalContacts(),
    salesforce.getAccounts(),
    salesforce.getSalesReps(),
  ]);

  const contactsById = new Map(contacts.map((c) => [c.externalId, c]));
  const accountsById = new Map(accounts.map((a) => [a.externalId, a]));
  const repsById = new Map(reps.map((r) => [r.externalId, r]));

  const summary = resolveRecipients({ opportunities, contacts });

  const rows = summary.results.map(({ opportunity, resolution }) => {
    const contact =
      resolution.status === "RESOLVED"
        ? contactsById.get(resolution.contactExternalId)
        : opportunity.primaryContactExternalId
          ? contactsById.get(opportunity.primaryContactExternalId)
          : undefined;

    return {
      opportunity: opportunity.opportunityName,
      opportunityId: opportunity.externalId,
      account: accountsById.get(opportunity.accountExternalId)?.name ?? "(no account)",
      owner: repsById.get(opportunity.ownerExternalId)?.name ?? "(inactive or unknown user)",
      stage: opportunity.stage,
      closeDate: opportunity.closeDate ? opportunity.closeDate.toISOString().slice(0, 10) : "",
      contactName: contact?.name ?? "",
      contactEmail: contact?.email ?? "",
      status: resolution.status,
      reason: RESOLUTION_REASON_LABELS[resolution.reason as ResolutionReason] ?? resolution.reason,
    };
  });

  // ---- Headline numbers ---------------------------------------------------
  const total = opportunities.length;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`.padStart(7);

  console.log("═".repeat(74));
  console.log(`Total open opportunities                        ${String(total).padStart(6)}`);
  console.log(`Resolved recipients                             ${String(summary.resolvedCount).padStart(6)}  ${pct(summary.resolvedCount)}`);
  console.log(`Unresolved (needs attention)                    ${String(summary.unresolvedCount).padStart(6)}  ${pct(summary.unresolvedCount)}`);
  console.log("─".repeat(74));
  for (const [reason, n] of Object.entries(summary.unresolvedByReason)) {
    if (reason === "PRIMARY_CONTACT_ROLE" || n === 0) continue;
    console.log(`  ${RESOLUTION_REASON_LABELS[reason as ResolutionReason].padEnd(44)}${String(n).padStart(6)}  ${pct(n)}`);
  }
  console.log("═".repeat(74));

  // ---- Who would actually be contacted ------------------------------------
  const recipientEmails = new Set<string>();
  for (const id of summary.recipientExternalIds) {
    const email = contactsById.get(id)?.email?.trim().toLowerCase();
    if (email) recipientEmails.add(email);
  }
  console.log(`\nDistinct contact records that would be emailed: ${summary.recipientExternalIds.length}`);
  console.log(`Distinct email addresses:                       ${recipientEmails.size}`);
  if (recipientEmails.size < summary.recipientExternalIds.length) {
    console.log(
      `  ⚠ ${summary.recipientExternalIds.length - recipientEmails.size} duplicate contact record(s) share an address — ` +
        `that person would receive more than one email.`,
    );
  }

  // ---- Account-oriented view ---------------------------------------------
  const byAccount = new Map<string, { resolved: number; unresolved: number }>();
  for (const row of rows) {
    const entry = byAccount.get(row.account) ?? { resolved: 0, unresolved: 0 };
    if (row.status === "RESOLVED") entry.resolved += 1;
    else entry.unresolved += 1;
    byAccount.set(row.account, entry);
  }
  const sendable = [...byAccount.entries()].filter(([, v]) => v.resolved > 0);
  console.log(`\nAccounts with at least one sendable opportunity: ${sendable.length}`);

  console.log("\nTop 15 accounts by sendable opportunities:");
  console.log(`    ${"Account".padEnd(42)}${"sendable".padStart(9)}${"needs attn".padStart(12)}`);
  for (const [account, counts] of sendable.sort((a, b) => b[1].resolved - a[1].resolved).slice(0, 15)) {
    console.log(
      `    ${account.slice(0, 41).padEnd(42)}${String(counts.resolved).padStart(9)}${String(counts.unresolved).padStart(12)}`,
    );
  }

  // ---- Sample rows --------------------------------------------------------
  console.log("\nSample of resolved recipients (first 10):");
  for (const row of rows.filter((r) => r.status === "RESOLVED").slice(0, 10)) {
    console.log(`    ${row.account.slice(0, 28).padEnd(30)}${row.opportunity.slice(0, 30).padEnd(32)}${row.contactName.slice(0, 22).padEnd(24)}${row.contactEmail}`);
  }

  console.log("\nSample of needs-attention (first 10):");
  for (const row of rows.filter((r) => r.status === "UNRESOLVED").slice(0, 10)) {
    console.log(`    ${row.account.slice(0, 28).padEnd(30)}${row.opportunity.slice(0, 30).padEnd(32)}${row.reason}`);
  }

  if (process.argv.includes("--csv")) {
    const header = [
      "Opportunity", "OpportunityId", "Account", "Owner", "Stage", "CloseDate",
      "PrimaryContact", "ContactEmail", "Status", "Reason",
    ];
    const csv = [
      header.join(","),
      ...rows.map((r) =>
        [r.opportunity, r.opportunityId, r.account, r.owner, r.stage, r.closeDate,
         r.contactName, r.contactEmail, r.status, r.reason].map(csvCell).join(","),
      ),
    ].join("\n");
    writeFileSync(CSV_PATH, csv);
    console.log(`\nFull preview written to ${CSV_PATH} (${rows.length} rows).`);
    console.log("It contains contact email addresses — it is gitignored; do not commit it.");
  } else {
    console.log("\nRe-run with `-- --csv` to write the full row-by-row preview to a file.");
  }

  console.log("\nNothing was sent and nothing in Salesforce was modified.\n");
}

main().catch((error) => {
  console.error("\nPreview failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
