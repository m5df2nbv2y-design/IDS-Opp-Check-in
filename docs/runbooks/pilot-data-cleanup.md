# Pilot data cleanup

One-off, before the real rollout. Removes the read-only pilot's campaigns, simulated sends and demo test emails from Production. Keeps the Salesforce catalogue and its history. Run by Josh only.

## What it removes and keeps

**Removes**, in one transaction:
- every campaign, drafts included, with their recipients, check-in items, answers and selections (every pilot check-in link stops working);
- every simulated (`mock`) outbox row, every demo test email (kind TEST, any provider), and every FAILED (never delivered) send on a pilot campaign;
- every audit event tied to one of those campaigns;
- every `CAMPAIGN_LAUNCH` snapshot.

**Keeps:** accounts, contacts, reps, opportunities, `CATALOG_REFRESH` and `OUTCOME_OBSERVED` snapshots, signals, real-provider (`graph`, `resend`) invitation and reminder rows that are not tied to a pilot campaign, audit events not tied to a campaign (catalogue refreshes, closed opportunities, signals, report exports), rate-limit counters, the mock Salesforce tables.

It writes one `PILOT_DATA_CLEARED` audit event with the counts.

**It refuses, and changes nothing, when:**
- `itemsWithSalesforceWrites` > 0: a pilot check-in item had a real Salesforce write attempt (SYNCED, SYNCING, UNCERTAIN or FAILED). "No change" answers (SKIPPED) and WITHHELD answers are fine;
- `realSendsInPilot` > 0: a real-provider (`graph` or `resend`) invitation or reminder, not marked FAILED, is tied to a pilot campaign.

## Steps

1. **Back up Production.** Take a database backup or branch snapshot (for example a Neon branch) and write down its name. That backup is the only way back.
2. **No admin activity.** Nobody uses the admin app during the run. The app's only scheduled job is an hourly read-only health check (`/api/health`, one `SELECT 1`); reminders and refreshes are manual, so this is enough. Pilot contacts can still open their links during the run; if one writes meanwhile, the apply is rolled back (see step 6) and you simply run it again.
3. **Writes still off.** Confirm Graph email and Salesforce writes are still switched off in Production.
4. **Point at Production.** In a fresh shell, export only the Production connection string. Paste it at the silent prompt and press Enter, so it never lands in shell history:
   ```sh
   read -rs DATABASE_URL && export DATABASE_URL
   ```
   Do not use a full `vercel env pull` file: the script reads `.env` through `dotenv`, not other env files, so a pulled file would be ignored and the run would count the local database. An exported variable always wins over `.env`. Do not commit or paste the string anywhere.
5. **Dry run:**
   ```sh
   npm run db:clear-pilot
   ```
   The first line shows the target database endpoint (the first part of the host, for example `ep-…`). Every Neon host ends the same way, so compare this id with the Production endpoint id shown in the database provider / Vercel before trusting the counts. It then prints counts only (including `submittedAnswers`, the answers that will be removed). Check they look right, and that both blockers are 0.
6. **Apply.** `<host>` is the host part of `DATABASE_URL` (after `@`, before `:` or `/`):
   ```sh
   npm run db:clear-pilot -- --apply --confirm <host> --actor Josh
   ```
   The "After apply" counts should all be 0.
   - **Refused:** nothing was written. See below.
   - **"Rolled back: something else wrote…":** nothing was changed. Run it again when the app is quiet.
   - **"Apply committed; the check afterwards failed":** the cleanup ran. Run the dry run to confirm the counts.
   - **"Outcome unknown":** the error came at or near commit, so it may or may not have committed. Run the dry run again before doing anything else.
   - **"committed, but new rows appeared afterwards":** the cleanup ran; something wrote new pilot rows after it. Find out what, then run the dry run again.
7. **Verify in the app:**
   - the dashboard shows no campaigns;
   - the outbox shows no simulated sends or test emails;
   - the audit trail shows one `PILOT_DATA_CLEARED` event and still shows catalogue refreshes;
   - opportunities and reports still show the catalogue and its history.
8. **Clean up.** Close the shell (or `unset DATABASE_URL`) so the Production string does not linger.

## When a blocker is non-zero

Stop. The pilot was not purely simulated, and removing those records would erase the only trace of a real Salesforce write or a real email.
- `itemsWithSalesforceWrites`: find the items in the admin app (campaign detail, sync status) and check in Salesforce what actually changed. Decide with the business whether those campaigns stay. Do not edit sync statuses to get past the check.
- `realSendsInPilot`: someone may actually have been emailed a pilot link (FAILED sends are not counted). Check the outbox, confirm with the sender, and decide whether those contacts need a follow-up before their links stop working.

Re-run the dry run once resolved. The script has no override.

## Restoring from the backup

If the result is wrong after the apply:
1. Stop admin activity again.
2. Restore the backup from step 1 (in Neon: restore the branch, or point Production's `DATABASE_URL` at the backup branch and redeploy).
3. Run the dry run against the restored database and check the counts match the first dry run.
4. Write down what went wrong before trying again.
