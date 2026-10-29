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

The last verified production rollback checkpoint is `5ad1462f81d57c6a2eb19088377a3b756f5c290f`, deployment `Aeu7fCNk2xYEzcNsGFh9jSk7jR3k` under IDS. Recheck the actual current deployment before approving rollout; do not roll back past newer authorized work. Keep the additive columns and saved drafts; the previous app ignores them. Dropping columns would destroy draft copy and is unnecessary for rollback.

## Verification limits

Local lint, typecheck, build, isolated unit/service checks and responsive UI inspection are recorded in the vault development note. Claude Report 08 documents successful fresh and pre-existing-campaign upgrade migration checks using disposable local PostgreSQL. That does not establish production migration state or live persistence. Codex remediation validation is recorded separately in the vault; do not infer a production migration from local test success. The temporary UI fixture was excluded from the branch and final build.


## October 14 local boundary remediation and approval packet

The personalized preview now imports the pure renderer from `src/lib/check-in-email.ts`; data-only message types live in `src/lib/email-message.ts`. Server provider entry points re-export the same renderer/types, preserving the existing email output and API. No delivery/config/database code belongs in this shared renderer's runtime dependency graph. A transitive runtime-import check supplements the unchanged production-readiness guard.

Local remediation/preparation is authorized. Push, PR update/merge, production migration, deployment and post-deploy draft mutations still need Josh's scoped rollout approval. Do not include the separate recipient-throttling branch.

Before approval, provide the exact intended source/diff, completed local checks and their limits, current production deployment/branch identity and migration status. Request a current post-import recovery snapshot with its cost/retention and an agreed recovery procedure: the October 13 pre-import snapshot is not a current-data backup. Do not reset or restore it to perform this rollout.

Production sequence after specific approval:

1. Recheck main/feature checkpoints and migration metadata. Inspect whether `20261014043000_campaign_email_draft` is already applied; do not infer absence from an old vault note. Preserve current campaign draft fields, revision and selections without storing customer/secret data in Git or the vault.
2. Verify current recovery point, then apply only the reviewed committed migration with the trusted configured migration tool. Do not combine manual SQL and automated migration paths blindly; preserve Prisma migration history. Existing campaigns must retain standard invitation/default revision.
3. Merge/publish the reviewed combined source and verify its exact production commit, Ready status, canonical domain and sign-in. Keep EMAIL_PROVIDER mock and Salesforce writeback disabled; do not refresh the catalog.
4. Within approved draft-smoke scope, verify Standard/Custom, reload persistence, recipient-specific placeholder previews, validation and stale two-tab save/review rejection. Preserve selections and restore original copy through the app's audited save flow; do not reset revision counters by hand. Saving creates audit records even without sending.
5. Inspect receipt only against already-existing evidence if available; do not launch or confirm a campaign merely to create a test receipt. Fictional preview must issue no real recipient API request. Record any unverified functionality explicitly.
6. On regression, redeploy the verified pre-rollout code while retaining additive columns and drafts; do not drop them. Record evidence and unresolved effects before closing the change.

The hosted feature Preview currently fails its database guard. Do not copy Production database/credentials into Preview as a workaround. Hosted Preview persistence is a separate isolated environment decision.
