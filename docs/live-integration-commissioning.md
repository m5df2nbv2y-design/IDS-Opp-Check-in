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

Recording an UNCERTAIN write as "It is in Salesforce" only marks the response
SYNCED and writes a SYNC_RECONCILED_APPLIED audit event. It never calls
Salesforce and never touches the cached Opportunity stage or close date, so that
cache can still show the old values. After any such attestation, run "Refresh
from Salesforce" on the dashboard as a separate step before preparing another
campaign. This is an operational requirement, not a gate the system enforces: the
campaign page keeps a notice saying so for as long as the attestation exists, and
a later refresh does not clear it.

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

## Microsoft Graph

Preparation only. Implementation and tests use a stubbed `fetch`; nothing has
called Microsoft, no credential exists in this repository, and `EMAIL_PROVIDER`
stays `mock` until customer email is deliberately commissioned. Graph does not
need Resend's DNS proof; sender-domain authentication is a Microsoft 365 tenant
matter to confirm with IT.

The adapter returns one of three outcomes and callers act on exactly that:

- SENT: sendMail answered 2xx (in practice 202, empty body, no message id). That
  is acceptance, not delivery.
- FAILED, not accepted: only where no sendMail request could have left, or
  Graph documented a rejection. That is a deployment refusal (returned, no
  ledger row), a missing `GRAPH_*` value (the variable is named, never a value),
  any failure to obtain a token (non-2xx, malformed body, transport, timeout),
  and a 4xx (other than 408) or 429 from sendMail. Nothing went out, so an
  identical later call retries it on the same ledger row (one concurrent caller
  wins the retry; the others get UNCERTAIN).
- UNCERTAIN, never replayed: a sendMail 5xx, 408, 1xx, unfollowed 3xx, timeout
  or transport failure; a stored PENDING or UNCERTAIN row for the same request;
  and a failed final ledger update, which leaves the row PENDING so a repeat
  cannot send again.

An identical request returns its stored outcome with no network call, and
concurrent identical calls make exactly one sendMail request. As with Resend,
sending identical content again on purpose needs a separately designed request
identity. If the initial PENDING ledger row cannot be written and no row exists
for the request, the send rethrows, which callers read as an unknown send.

Graph reports no delivery events for mail you send, so `deliveredAt` never
populates and no screen says "delivered". A bounce comes back as an NDR message
in the sending mailbox. Every message is saved to that mailbox's Sent Items,
and that copy holds the full message including the live check-in link; who can
read that mailbox, and how long it retains the message, are to settle with IT.
For each recipient under "Send outcome unknown" on the campaign page or sending
results, check the sending mailbox's Sent Items for a message to that address,
and for an NDR, before anyone resends. The campaign page now has controls for this: record "It was sent" or "It was
not sent", and "Re-send invitation" for a failed one.
The count is invitation-only: a recipient still PENDING (not yet attempted, or
interrupted) and an unresolved reminder stay in the campaign page's
pending-or-unresolved banner, and a reminder in the recipient's "Delivery
unresolved" status. Sent, Failed and Unknown therefore do not cover every
recipient while a launch is pending or interrupted.

Redirects are never followed: a 3xx from the token endpoint is a definite
pre-send failure, and a 3xx from `sendMail` is an unknown outcome.

Diagnostics are fixed text built from this code's own constants and an HTTP
status number. A provider or token body, thrown text, bearer link, credential or
mailbox value is never returned, stored in the ledger or written to an audit
event.

**Go-live procedure:** `docs/runbooks/graph-email-go-live.md`. **IT request:** `docs/runbooks/graph-it-request.md`. Microsoft's current scoping mechanism is Exchange RBAC for Applications, which replaces Application Access Policies; with it, the token carries no Mail.Send role, and the Outbox readiness check accounts for that.

Still blocked on IT approval, and not verified here:

- Mail.Send application permission with admin consent on the app registration.
- A mailbox-scoping mechanism limiting that consent to the one sending mailbox.
  Which mechanism applies is to be verified against current official Microsoft
  guidance; this repository asserts none.
- The sending mailbox (`GRAPH_SENDER_MAILBOX`; the Graph payload sets no `from`,
  so `EMAIL_FROM_ADDRESS` has no effect on this path) and Production-only
  `GRAPH_*` secrets.
- Evidence of a real internal send and its Sent Items entry, and of how a 4xx,
  429 or 5xx actually presents from the live service. The classification is
  based on the documented behaviour and has only been exercised against stubs.

Before a pilot:

- An owner for the client-secret expiry and rotation.
- The disable procedure: set `EMAIL_PROVIDER` back to `mock` and redeploy.
- An owner for watching the sent mailbox for non-delivery reports.
- Access to the sending mailbox and its retention, settled with IT, since Sent
  Items holds the full message including the live check-in link.

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
