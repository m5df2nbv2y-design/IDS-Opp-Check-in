# Live integration commissioning

This branch is preparation, not evidence of production readiness. It builds on
fa565a5 (V2 + Outbox + dashboard iterations). Production has not been migrated or
changed by this implementation.

## Salesforce

Completion stores responses; a live write requires the master switch AND an
admin's per-item approval of the displayed updatedAt revision after completion.
Approval and the SYNCING claim are atomic. Only StageName and a valid proposed
CloseDate are mapped into the PATCH. Date-only changes are supported. Probability,
notes and loss reason are excluded. Closed Lost stays withheld and live loss
reason discovery is disabled until Josh supplies the field and options.

The current CRM stage/date must still match the check-in snapshot. The subsequent
PATCH uses If-Unmodified-Since with the freshly read LastModifiedDate. A stale
record or HTTP 412 refuses the write. Validate timestamp precision and actual org
validation rules in a sandbox before enabling production writes.

SYNCING after a process crash and UNCERTAIN after a network/5xx failure require
manual reconciliation with Salesforce and the approval audit. Never reset them
to PENDING or use retry-all blindly. After a confirmed rejection, an admin may
review and approve the current response revision again. A changed CRM snapshot
requires a new reviewed check-in, not an override of conflict checks.

The dedicated integration user's permissions still require inspection. Grant only
necessary Opportunity edit/record access and field permissions; no Modify All
Data or unrelated object editing. Writes must stay disabled until commissioning.

## Resend

A redacted PENDING ledger row is committed before the API request. A SHA-256
request fingerprint has a permanent unique constraint and is also sent as the
Resend idempotency key. Identical calls are suppressed even after Resend's 24-hour
key retention. Intentionally sending identical content again needs a separately
designed request identity; this branch deliberately refuses silent replay.

Success saves the provider ID; timeout, transport failure, malformed acceptance,
and server errors leave UNCERTAIN. Process interruption may leave PENDING. Neither
is automatically resent. The API never returns provider bodies/errors into
persistent storage. Unknown outcomes must be reconciled in Resend; token-bearing
content is not stored locally, so an outbox worker cannot reconstruct it.

This is a durable send ledger, not a background delivery queue. Failed sends or
lost in-memory links need an explicitly approved replacement invitation. Reminder
batch locking and crash recovery still need work before customer rollout.

The webhook endpoint `/api/webhooks/resend` uses the official Svix verifier on
raw bytes, enforces timestamp/signature checks, and updates delivery, bounce and
complaint states idempotently. Register only those three event types. Unknown
provider IDs return 503 for provider retries (including callback-before-commit).
Reconcile a permanently missing receipt manually. Callback payloads are not stored.
The sending API key and webhook signing secret belong only in Production secrets.

## Confirmed pilot settings

Sender/Reply-To: hello@idsculpture.com. Internal recipients authorized by Josh:
jason.macmillan@idsculpture.com and josh.young@idsculpture.com. Existing demo action
accepts a single server-configured destination per test; it does not accept a
browser-supplied address or a comma-separated list. Use synthetic pilot records.

Resend domain idsculpture.com was added; DNS verification remains pending. See the
canonical vault operations note `2026-10-29-resend-dns-and-internal-pilot.md`.

## Remaining launch gates

DNS verification; Production-only secrets; webhook registration; migration/release
review; actual internal delivery evidence; Salesforce identity/permissions and
sandbox write evidence; SEC-001 public endpoint limits; reminder concurrency;
full Closed Lost product decision; owner/monitoring/access negative tests; restore
rehearsal; dependency advisories (npm audit currently flags existing dependencies,
including Next 16.3.4 as critical). Do not broadly enable customer sends or CRM
writes on the strength of passing local tests.

## Provider references

- https://resend.com/docs/dashboard/emails/idempotency-keys
- https://resend.com/docs/webhooks/verify-webhooks-requests
- https://developer.salesforce.com/docs/platform/api-rest/guide/intro-rest-conditional-requests.html
