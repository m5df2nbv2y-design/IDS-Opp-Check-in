# Client response iteration — 2026-10-22

Local review implementation on `feat/client-response-v2`, based on the clean local `34487d5` checkout. The separate throttle and Outbox branches were not incorporated or modified. Azure evaluation remains on hold.

## Requested flow

- Lead with project name and original Salesforce Opportunity.CreatedDate.
- Exclude value and current Salesforce stage from the recipient component's props, screen, and completion summary.
- Ask “What is the current status?” with Open and Closed Lost.
- Closed Lost requires selecting a Loss Reason.
- Open asks “When do you expect this opportunity to close?” with an editable native calendar. Confirming the date reveals “How likely is it that you win the project?”
- Display only 10%, 50%, 75%, 90%, mapped respectively to QUALIFICATION, PROPOSAL, SPECIFIED, NEGOTIATION. Internal stage mappings remain unchanged.
- Each answer must save before advancing; failed requests leave the recipient on the current project with an error and retry.

## Salesforce and persistence

Additive migration `20261022223000_client_response_v2` adds Opportunity.salesforceCreatedAt and CheckInOpportunity.lossReason. No database reset or production migration was performed. Live catalog reads now request CreatedDate and retain it separately from the local createdAt field. Existing cached records need a separately controlled catalog refresh; unknown dates display unavailable and never use the local import timestamp.

The user identified the field label as “Loss Reason”, not its API name. The live provider reads Opportunity Describe metadata, identifies exactly one picklist with that label, and returns active API values and labels. Metadata is cached for five minutes and used for server-side validation. Ambiguous or dependent picklists and organizations exposing nonmaster record types fail closed: these require a verified record-type-scoped metadata implementation before live use. No guessed API field or live options were embedded. The live org's actual metadata has not been called or verified in this task.

Version 2 responses require a valid close date for Open and a recognized picklist value for Closed Lost. Switching branches clears obsolete values. Existing API callers without flowVersion retain the legacy optional-date/free-text-reason contract for compatibility; this is not a universal replacement of that protocol. Selected loss reasons are stored locally as a dedicated API value and a human-readable comment for existing admin views. No Salesforce Loss Reason write is added. Salesforce write-back commissioning remains blocked by the existing policy and implementation gaps.

## Local preview

`/demo/client-response` is development-only; production returns not found. It contains fictional projects and clearly labeled sample loss reasons. Preview saves and completion never call APIs. Start development with explicit mock providers and a local test database URL, then open that route. The production recipient route does not receive the preview flag.

## Publication prerequisites

Verify the org's actual Loss Reason field, choices, record types, and dependent restrictions. Implement scoped metadata support if required. Obtain current recovery protection, review/apply the additive migration through the normal process, populate CreatedDate under controlled read/import scope, and complete production readiness and publication approval separately. Do not enable Salesforce writes or live email as part of this iteration.

## Browser review performed

Using the development-only fictional preview:

- Initial view: project name and original creation date, with no value or stored stage.
- Open: date field appears; percentages remain hidden until date confirmation.
- Confirm date: exactly 10%, 50%, 75%, 90% appear, with no stage names.
- Select 75%: Next project becomes enabled and advances.
- Closed Lost on project 2: reason dropdown appears and Submit remains disabled until a choice is made.
- Select a sample reason and submit: completion shows the reported Open date/probability and Closed Lost reason, with no previous Salesforce stage.
- Reload restores the fictional preview to its initial unanswered state. No preview response APIs were called by the component.

This browser walkthrough verifies fictional UI behavior, not the live Salesforce metadata or production persistence. The separate new database tests cover persistence against disposable local schemas.

## Validation status

- Lint and standalone typecheck passed.
- Production webpack build passed using a local test database URL, mock providers, Salesforce writes disabled, and a build-only placeholder AUTH_SECRET. No production credentials or environment files were copied.
- Initial focused run: 46/47 passed, including all new persistence tests. An existing write-retry guard matched the new read helper because it was placed after the write method. Moved the read helper before the write method; no test, assertion, timeout, or write behavior was weakened. Final focused run result is recorded in the review output after completion.
- Full-suite attempts did not complete cleanly: the existing Closed Lost set hit 10-second setup timeouts, including after the development server was stopped. Runs were interrupted rather than weakening tests or claiming a clean result. This task has not independently isolated the cause of those timeouts. A clean full suite remains required before publication.
- Original working checkout and the separate Outbox checkout remain clean and unchanged.

Final focused run: **47/47 tests passed across 4 files**, exit 0, with unchanged default timeouts. This includes the new response rules and database persistence tests plus existing production-readiness and Salesforce write guards. The default full suite is still not established clean as described above.
