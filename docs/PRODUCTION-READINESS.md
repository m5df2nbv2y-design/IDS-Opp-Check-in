# Production readiness report

Assessed against the current `main`. Deployment steps are in
[`PRODUCTION-DEPLOYMENT.md`](./PRODUCTION-DEPLOYMENT.md).

> **Refreshed 23 Nov 2026.** Production is live on Vercel with a Neon database.
> Since the original assessment: contact-facing rate limits are enforced (20 Nov),
> monitoring and a daily problems email are in place, the database restore window
> is 7 days and was rehearsed, capacity and dependencies were checked, and Graph
> email needs only `GRAPH_SENDER_MAILBOX`. Salesforce writes are commissioned;
> email is still simulated until IT completes the Graph request. Sections below
> marked "updated" carry the current state; the rest is the original assessment.

| Status | Meaning |
|---|---|
| 🟢 **GREEN** | Ready. No code work and no configuration outstanding. |
| 🟡 **YELLOW** | Code is complete; an external service still needs configuring. |
| 🔴 **RED** | A code or security blocker. Do not deploy without addressing it. |

A component is **not** GREEN merely because the code exists. If a Salesforce
admin, an Entra admin, or a database still has to be provisioned, it is YELLOW.

---

## Summary

| Area | Status |
|---|---|
| Authentication | 🟡 |
| Authorization | 🟡 |
| Salesforce integration | 🟡 |
| Database | 🟢 |
| Email | 🟡 |
| Check-in tokens | 🟢 |
| Input validation | 🟢 |
| Audit logging | 🟢 |
| Analytics | 🟢 |
| Reporting | 🟢 |
| Deployment | 🟡 |
| Secrets | 🟢 |
| Security headers | 🟢 |
| Rate limiting | 🟢 |
| Monitoring | 🟡 |

**No RED remains** (monitoring was the last, now YELLOW). Everything else is
either done or waiting on an external service. See "Blockers" at the end.

---

## Authentication — 🟡

**Code complete.** Auth.js v5 with the Microsoft Entra ID provider. Sessions are
JWT-based and signed with `AUTH_SECRET`.

The development sign-in is double-gated: the credentials provider is registered
only when `NODE_ENV !== "production"` **and** `AUTH_DEV_BYPASS === "true"`. In a
production build the provider is absent from the array — the code path does not
exist rather than being merely discouraged. Setting `AUTH_DEV_BYPASS` in
production is additionally refused at startup.

Missing `AUTH_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`, or `..._SECRET` in
production is a startup error naming each one.

**External configuration required:** Entra app registration, client secret,
redirect URI, and admin consent. Nobody can sign in until that exists.

---

## Authorization — 🟡

**Code complete.** `AUTH_REQUIRED_APP_ROLE` (`Admin`, display name
`Opportunity Check-In Administrator`) checked against
the `roles` claim. Fails closed: with no policy configured, **nobody** is
authorized — it does not fall back to admitting the tenant.

`requireAdmin()` is called by the `/admin` layout *and independently by every
server action*, because a layout guard does not protect a POST. A test
enumerates the exports of `actions.ts` and asserts each one asserts first, so a
new action cannot silently skip the check.

The Entra "groups overage" case — where a user in >200 groups has the `groups`
claim silently dropped — is detected and reported distinctly rather than being
treated as "not a member". This is why App Roles are preferred over raw groups.

**External configuration required:** create the App Role and assign the Sales
Operations security group to it.

---

## Salesforce integration — 🟡

**Code complete, and read-only.**

- OAuth 2.0 **Client Credentials** via an External Client App, acting as a
  dedicated Run As integration user. No human's credentials are involved.
- Credentials are read from the server environment only. They are never stored
  in the database, never serialized into a client component, and never logged —
  the OAuth error path extracts only the `error` code, never the response body.
- **Timeouts**: every request is bounded (20s for data, 15s for auth). A hung
  connection cannot hold a serverless request open until the platform kills it.
- **Re-auth**: a 401 drops the cached token and retries once with a fresh one,
  so an early revocation or expiry does not surface as a failed sync.
- **Retry**: reads retry up to 3 times with exponential backoff on 429 and 5xx
  only. Writes are deliberately **not** auto-retried — `retryable` is reported
  and the decision is left to the sync service.

Write-back is **off**. `SALESFORCE_WRITE_ENABLED` defaults to `false`, and the
guard is `writeEnabled = provider.simulated || env.salesforce.writeEnabled`, so
a live provider with the flag off records the response and withholds the push
(`WITHHELD` + a `SYNC_WITHHELD` audit event). A test proves `applyUpdate` is
never called when the provider reports `simulated: false`.

Discovery, account data, contact data, Opportunity Contact Roles, primary
contact resolution, and Needs Attention behavior are **unchanged** by this pass.

**External configuration required:** production Consumer Key/Secret, the Run As
user assigned to the app via Permission Set, and My Domain `SF_LOGIN_URL`.
Validate with `npm run sf:smoke` before switching the provider.

---

## Database — 🟢 (updated 2026-11-23)

**Now:** Production runs on Neon (Postgres 18). The restore window is **7 days**
(raised from 6 hours on 23 Nov), and a point-in-time restore was rehearsed the
same day: a copy one hour back took about a second and matched Production on all
18 tables. Runbook: `docs/runbooks/database-restore.md`. Size and limits:
`docs/runbooks/capacity.md`.

*Original assessment:*

**Code complete.** Prisma 7 with driver adapters; the adapter is chosen from the
`DATABASE_URL` scheme, so SQLite → PostgreSQL is configuration, not code. The
client is a module singleton, cached on `globalThis` in development only, which
is the correct pattern for serverless.

Five migrations are tracked in `prisma/migrations/`. The schema is deterministic.

**Fixed in this pass:** `DATABASE_URL` previously fell back to a local SQLite
file when unset. In production that meant the application would boot, serve
pages, and quietly read an empty local database as though nothing were wrong.
Production now refuses to start without it, and refuses a `file:` URL outright.

**The destructive seed cannot reach production.** `npm run db:seed` deletes every
row, so it now requires all of: both providers `mock`, `NODE_ENV` not
`production`, and `DATABASE_URL` targeting local SQLite or `localhost`. Mock
providers alone were not enough — they say nothing about *which* database is
wiped.

`migrate deploy` is the documented production path; it never generates, prompts,
or resets.

**External configuration required:** provision PostgreSQL with TLS and run
`prisma migrate deploy`. **No production database has been migrated.**

---

## Email — 🟡

**Mock is the default and stays the default.** Invitations are captured in the
in-app outbox; nothing is delivered. This is intentional, not an oversight —
the application is fully demonstrable without a mail provider.

The Resend provider exists and implements the same interface. Every send, real
or simulated, is recorded in the same outbox table, so the audit view is
identical regardless of provider.

The demo test-email path is separate and tightly scoped: it sends to
`DEMO_TEST_EMAIL` and nowhere else. The action takes a recipient *record id*,
never an address, so no browser input can redirect it, and the destination is
re-applied from the server environment immediately before the send. Unset the
variable and the control does not render and the service refuses. Leave it unset
in production.

**External configuration required, when commissioned:** a verified sending
domain (SPF/DKIM/DMARC) and a provider API key.

**Updated 2026-11-23:** the chosen provider is Microsoft Graph, sending as
`hello@idsculpture.com` through the existing sign-in app. Its tenant, client id and
secret fall back to the sign-in settings, so only `GRAPH_SENDER_MAILBOX` is added
at go-live (`docs/runbooks/graph-email-go-live.md`). It waits on IT scoping
Mail.Send to that one mailbox. Production refuses to start with
`EMAIL_PROVIDER=resend` and no `RESEND_API_KEY`.

---

## Check-in tokens — 🟢

- **Cryptographically random**: `randomBytes(32)` — 256 bits, base64url.
- **Non-enumerable**: not derived from an Opportunity ID, a database ID, or any
  sequence.
- **Hashed at rest**: only the SHA-256 hash is persisted. A database leak does
  not hand out working links. *(The Phase 6 brief asked whether hashing should
  be recommended — it is already implemented.)*
- **Validated server-side**: a token resolves to exactly one recipient record.
- **Expiring**: `CHECKIN_TOKEN_TTL_DAYS`, and revocable.
- Only the last 6 characters are shown in admin UI, for support lookups.

**IDOR**: a token resolves to one `CheckInRecipient`, and `saveResponse` requires
the submitted `itemId` to belong to *that* recipient. A valid token for
recipient A cannot read or write recipient B's opportunities, and grants no
access to any admin route.

---

## Input validation — 🟢

| Input | Validation |
|---|---|
| `stage` | Allowlist (`isOpportunityStage`). An unknown value is rejected. |
| `closeDate` | Strict `yyyy-mm-dd` regex; anything else becomes null. |
| `comment` | Trimmed and **capped at 2000 characters** (added this pass — this is the one free-text field an anonymous caller can write). |
| `itemId` | Must belong to the token's recipient. |
| `token` | Minimum length, then hash lookup. |
| `opportunityIds` | Required with no fallback; re-resolved server-side before any send. |
| `campaignId` / `recipientId` | Looked up; a miss is a clean 404, never a crash. |

Server actions never trust the client's selection: `sendDraft` re-resolves every
selection against current Salesforce data and excludes anything that drifted.

---

## Audit logging — 🟢

Append-only `AuditEvent` rows attribute every change to a real signed-in person
(`requireAdminActor()` returns the identity; there is a test asserting no
hardcoded `"admin"` actor remains). Covers campaign creation, sends, opens,
responses, revisions, syncs, withheld syncs, catalog refreshes, report exports,
and test emails.

**Logs contain no secrets.** Verified: no Salesforce client secret, OAuth token,
database credential, or email API key is logged. The mock email provider's log
line now masks the recipient address (`j***@example.com`) rather than printing
a customer's email into the platform log stream.

---

## Analytics — 🟢

Built on the append-only `OpportunitySnapshot` history, so pipeline over time
stays answerable even after Salesforce overwrites its own values. Won/Lost
outcomes are frozen when an opportunity leaves the open set.

No attribution or causality is computed anywhere — a movement after an
intervention is reported as an observed movement, and the UI says so. Values
that are genuinely unknown render as "—", never as a manufactured zero.

---

## Reporting — 🟢

PDF brief and Excel workbook render from **one** server-side snapshot, so the
two exports cannot disagree.

- Both routes call `requireAdmin()` **before** any data is read; unauthenticated
  gets 401, unauthorized gets 403. Verified against a real server with no
  cookies and with a forged cookie.
- **No filesystem persistence.** pdf-lib returns bytes in memory and exceljs
  writes to a buffer; neither touches the disk. Serverless-compatible as-is.
- No publicly accessible file is created — bytes are streamed in the response.
- pdf-lib uses the PDF standard fonts, so nothing is read from disk at runtime
  (the usual cause of server-side PDF failures in bundled deployments).

---

## Deployment — 🟡

Production build succeeds. No localhost assumption remains in a production path:
the single `localhost` default in `env.ts` is now refused at startup in
production.

Check-in URLs are built from `APP_BASE_URL`, which production requires and which
is validated not to be localhost. The Entra callback URL is documented.

**External configuration required:** create the host project, set every
environment variable, point the custom domain, and match the Entra redirect URI.
**Nothing has been deployed.**

---

## Secrets — 🟢

- No `NEXT_PUBLIC_` variable is declared or read anywhere.
- No client component imports `@/lib/env`, `@/lib/db`, or any integration —
  asserted by a test that walks every `"use client"` file.
- The browser never contacts Salesforce or PostgreSQL directly; both are reached
  only from server code.
- **`.env` has never been committed** — verified against the full git history.
  Only `.env.example` is tracked, and it contains placeholders only.
- A scan of every tracked file for API-key, JWT, AWS-key, Salesforce-consumer-key,
  and connection-string patterns returns nothing but a documentation placeholder.

---

## Security headers — 🟢

Added this pass (`next.config.ts`), applied to every response including the
public `/checkin` pages:

`X-Frame-Options: DENY` (a framed check-in could be overlaid to trick a customer
into submitting something they cannot see), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin` (the check-in token is in the
URL path and must not leak to third parties via the referrer),
`Permissions-Policy`, `Strict-Transport-Security`, and `poweredByHeader: false`.

No Content-Security-Policy. Adding one properly needs a nonce pipeline for
Next's inline scripts, which is a larger change than this pass warrants. Worth
doing before any external exposure.

---

## Rate limiting — 🟢 (updated 2026-11-23)

**Enforced since 20 Nov 2026** (`RATE_LIMIT_MODE=enforce`). Per check-in link, per
minute: page 60, save 120, complete 10; unresolved links 20 per client. The
counters live in the database (`RateLimitCounter`), so every serverless instance
shares them. Observed peaks before enforcing were 3, 1 and 1. Code:
`src/server/security/rate-limit.ts`.

The original concern (no limit at all on the three public routes) is closed.
Platform WAF rules remain an optional extra layer, not a requirement.

---

## Monitoring — 🟡 (updated 2026-11-23)

**Now in place:** an hourly health check (`/api/health`, Vercel cron), a Vercel
alert rule that emails the team owner on any Production 5xx (which includes a
failed health check), and a "Problems to fix" banner on the dashboard for failed
or unconfirmed Salesforce updates and failed or unknown invitations, including
rows stuck mid-write for over 15 minutes. A daily cron at 15:00 UTC
(`/api/cron/problems`) answers 500 while any problem is open, so the same alert
emails once a day. It needs `CRON_SECRET` set in Production; until then it
answers 401 and sends nothing. See `docs/runbooks/monitoring.md`.
**Still open:** no structured logging beyond `console.*`, and no error tracking
service.

*Original assessment, kept for the record:*

This is the one item marked RED, because of what it means operationally: if the
Salesforce integration user's secret expires, if the Run As assignment is
removed, or if a nightly catalog refresh starts failing, **nobody finds out**.
The failure is silent — the dashboard simply shows stale data, which looks
exactly like a quiet week in the pipeline.

That risk is specific rather than theoretical: Salesforce Consumer Secrets and
Entra client secrets both expire on a schedule, and the symptom of expiry here
is indistinguishable from normal operation.

**Minimum before production use:**

1. Error tracking (Sentry or the host's equivalent) wired to the server runtime.
2. An alert on repeated `SalesforceSyncError`, which the code already raises with
   a `code` and a `retryable` flag ready to be reported.
3. An uptime check on a cheap authenticated-boundary route.
4. A calendar reminder for both secret expiry dates.

This is a deliberate, small follow-up — not a rewrite.

---

## Blockers

### CODE COMPLETE — nothing further required

Authentication, authorization, Salesforce read integration, database access,
check-in tokens, input validation, audit logging, analytics, reporting, secrets
handling, security headers.

### EXTERNAL CONFIGURATION REQUIRED — not code

| # | Item | Who |
|---|---|---|
| 1 | Entra app registration, client secret, redirect URI, admin consent | Entra admin |
| 2 | ~~App Role created and assigned~~ — **DONE.** Value `Admin`, five administrators verified; do not recreate | Entra admin |
| 3 | Production External Client App; Run As user assigned via Permission Set | Salesforce admin |
| 4 | PostgreSQL provisioned with TLS; `prisma migrate deploy` run | IT / you |
| 5 | Host project created and every environment variable set | You |
| 6 | Custom domain pointed; `APP_BASE_URL` and the Entra redirect URI matched | You |
| 7 | ~~WAF rate limiting~~ — **not needed:** application limits enforced since 20 Nov | — |
| 8 | Graph Mail.Send scoped to the sending mailbox (IT request ready) — **only when email is commissioned** | IT |
| 9 | `CRON_SECRET` in Production, for the daily problems email | Josh |

### OPEN RISK — requires a decision

| # | Item | Severity |
|---|---|---|
| 1 | **Mostly addressed (2026-11-23):** health check, 5xx email alert, dashboard banner, and a daily problems email (once `CRON_SECRET` is set). No error-tracking service. | 🟡 |
| 2 | ~~No Content-Security-Policy~~ — **closed:** a per-request nonce CSP is set in `src/proxy.ts`. | 🟢 |
| 3 | ~~No application-level rate limiting~~ — **closed:** enforced since 20 Nov. | 🟢 |
| 4 | Dependencies: `npm audit` clean on 23 Nov; majors deliberately deferred and `next-auth` is still a beta. See `docs/runbooks/capacity.md`. | 🟡 |

### NOT DONE, DELIBERATELY (updated 2026-11-23)

- **Salesforce write-back.** Commissioned (stage and Closed Lost tested on
  19 Nov).
- **Real customer email.** Still simulated, waiting on the Graph IT request.
- **Deployment.** Production is live on Vercel.
- **Production database migration.** Done; Neon, 7-day restore window.
