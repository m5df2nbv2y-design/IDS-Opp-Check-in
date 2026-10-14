# Outbox email choices — rollout

The Outbox now prepares the shared campaign invitation before listing message history. Standard is the default; Custom edits the subject and opening message. Saving does not send. Review shows the saved copy and requires confirmation before the existing selected-recipient send.

Review now previews each selected recipient's actual personalized invitation using a placeholder link. Confirming sends through the existing provider and opens `/admin/campaigns/[id]/receipt`, which uses recorded invitation rows and snapshotted opportunity names. Mock captures, provider acceptance, delivery confirmation, missing records and failures are distinct. The receipt links to each actual Outbox email record; email details and campaign activity link back to the receipt.

Outbox and review include a recipient-experience preview. `/admin/recipient-preview` shows a fictional invitation; `/recipient-preview` is a standalone, admin-authenticated demonstration of the same CheckInFlow component. Two fictional projects are used. Preview submissions short-circuit before fetch and never mark real recipients opened or save answers. Real token pages keep their existing authorization boundary and do not inherit preview mode.

## Database prerequisite

Apply migration `20261014043000_campaign_email_draft` before deploying this code. It adds nullable `Campaign.emailSubject` and `Campaign.emailBody`, plus `Campaign.emailRevision` with default 0. Existing campaigns use the standard invitation. No data is deleted or backfilled.

Use the existing trusted migration environment with its securely configured Neon connection:

```bash
pnpm exec prisma migrate deploy
```

Do not paste credentials into chat, the vault, or Git. If the Neon SQL console is used instead, run the checked-in SQL once and reconcile the Prisma migration history before subsequent automated migrations. Do not run both paths blindly.

## Deploy and verify

After scoped approval: inspect the current migration state, preserve the existing draft copy, apply the migration, merge this change into main and verify the exact Vercel commit and Ready status. Keep email simulated and Salesforce writeback disabled.

Verify Standard and Custom, subject/body validation, saved copy after reload, switching back to Standard, the final review preview, and rejection of stale saves/reviews across two tabs. Preserve the existing opportunity selections. Restore the original draft copy after smoke checks. Do not press Send during verification: simulated sends still create application records/tokens.

Verify recipient-specific greeting/count/subject/body previews, the receipt for an existing campaign, and each email record link. Do not create a campaign just to test the receipt without additional scoped approval. In the fictional recipient preview, check statuses, back/next, the required Closed Lost reason, date and note controls and completion. Confirm no response API request is issued in preview mode. Keep the temporary local demonstration routes out of the published tree.

Saving is audited with the admin identity. Subject is limited to 200 characters without line breaks; body is plain text up to 5,000 characters and escaped in HTML. Personalized greeting, selected-opportunity count and secure recipient link remain controlled by the application. Reminders continue using the standard reminder template.

## Rollback

Redeploy the previous main checkpoint `a1206758f561b6a19c8b81863e3c058b4f773d01` if necessary. Keep the additive columns and saved drafts; the previous app ignores them. Dropping columns would destroy draft copy and is unnecessary for rollback.

## Verification limits

Local lint, typecheck, build, isolated unit/service checks and responsive UI inspection are recorded in the vault development note. No local PostgreSQL is available, so database migration/transaction integration and live persistence need the approved environment verification. The temporary UI fixture was excluded from the branch and final build.
