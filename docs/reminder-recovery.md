# Interrupted invitations and reminders

An approved selection remains a visible shortfall until a recipient item exists. Closed, unresolved, reassigned, and legacy selections lacking routing evidence require review. Resume provisions only complete eligible groups for never-provisioned contacts whose routing matches the immutable campaign routing audit. Existing invitation items are never expanded, and an old pending recipient is never deleted because of its age.

Recipient creation, its full item set, and launch snapshots commit together. The campaign row lock is shared with campaign closure so an interrupted launch cannot close while approved selections are still missing. Invitation PENDING and UNCERTAIN states are evidence of interrupted or unknown delivery, not instructions to replay.

## Reminder claims

Only an unfinished, unrevoked recipient with a SENT invitation and at least one item is eligible. The conditional claim rotates the token and persists REMINDER_PENDING with versioned recovery evidence in sendError. Evidence contains an attempt UUID and the prior hash, hint, and expiry; it contains no bearer token or link. Overlapping batches cannot claim the same attempt, and elapsed time never authorizes takeover.

- Accepted: keep the new token, increment reminderCount and record REMINDER_SENT atomically.
- Definitively rejected: conditionally restore the prior hash, hint and expiry, and record REMINDER_FAILED atomically.
- Unknown, exception, or crash: retain the new token and recovery evidence, show unresolved delivery, and block automatic resend. Failed local finalization leaves the durable pending claim intact, including when audit persistence fails.

A one-token schema cannot guarantee uninterrupted prior-link access across every crash. Provider acceptance and local database persistence cannot be atomic. Unknown outcomes require provider reconciliation and may require a reviewed replacement. These changes do not commission production sending or promise exactly-once delivery. Do not clear a pending/uncertain claim or restore its prior token based only on age, token comparison, or a missing local success record.

## Manual reconciliation boundary

Inspect the recipient state, attempt identity, audit trail, and provider ledger. A ledger PENDING/UNCERTAIN is not a rejection. Verify externally whether the provider accepted the exact attempt before deciding on a replacement. There is deliberately no automatic takeover or bulk reconciliation action. Recovery evidence must remain intact until an authorized, reviewed reconciliation procedure can update state and audit together. Never persist raw replacement links in a real-provider ledger.

## Microsoft Graph integration

The separate Graph/provider PR is not integrated by this change. Before combining it, adopt the SENT/FAILED/UNCERTAIN result contract without collapsing pending or ambiguous external outcomes into FAILED. Apply the same durable ledger, duplicate suppression, redaction, and test-email consumer behavior. Verify unknown/exception/crash and finalization failure cases with a mock Graph endpoint before any production commissioning. Salesforce writes remain outside this work.
