# IDS Opportunity Check-In

Replaces the manual bi-annual opportunity review — spreadsheets, email chasing,
manual SFX updates — with one button for Sales Operations and a 60-second update
for the external contacts who actually know the answer.

```
Before:  SFX → spreadsheet → email → Excel → chase people → manually update SFX
After:   SFX → SEND CHECK-IN → contact updates → SFX
```

Salesforce/SFX stays the system of record. This is a workflow, UX, and
synchronization layer — not a second CRM.

## What it does

**Sales Operations** opens `/admin`, sees how many open opportunities exist and
which external contacts need to be asked about them, and presses **SEND CHECK-IN
TO ALL**. The system pulls from Salesforce, works out who is responsible for each
opportunity, groups them by contact, and emails each contact one personalized
link.

**The external contact** — someone at an agency, distributor, or client — opens
that link on their phone. No login, no account, no spreadsheet. They see one
opportunity at a time: customer, project, amount, current status, four big
buttons, an optional note. Tap, next, submit. Roughly 60 seconds.

**The system** records every answer, syncs it back to Salesforce, and keeps an
audit trail showing which contact changed what, for which internal IDS rep.

The key design decision: **the recipient is an external contact, not an internal
IDS rep.** One contact receives one email covering every opportunity they are
responsible for — even when those opportunities belong to three different IDS
reps. In the demo data, Marcus Webb at XYZ Agency gets a single check-in for 9
opportunities split across John Smith, Sarah Jones, and Mike Brown.

## Run it locally

```bash
cd ids-checkin
npm install
cp .env.example .env
npx prisma migrate dev
npm run db:seed
npm run dev
```

Open **http://localhost:3000/admin**. No Salesforce credentials, mail server, or
database server needed — the seed loads a mock Salesforce org into SQLite.

### Demo path

1. `/admin` — 36 open opportunities, 12 external contacts, 11 organizations, 1
   opportunity that needs attention. Press **SEND CHECK-IN TO ALL**.
2. Confirm on the preview screen, which names exactly who will be emailed.
3. `/admin/outbox` — open **Jane Doe**'s email, click **Open as Jane →**.
4. Complete her 6 opportunities (try it at phone width).
5. `/admin` — Jane's row shows Complete. `/admin/salesforce` shows the mock org
   updated. `/admin/audit` shows who changed what, and for which IDS rep.

To see error recovery: complete **Dana Whitfield**'s check-in — one of her
records has a simulated validation rule and lands in **Sync Error**. Clear the
rule on `/admin/salesforce`, then press **Retry failed syncs**.

## Architecture

```
src/
  app/
    admin/                 Sales Operations console (campaigns, organizations,
                           outbox, audit, mock Salesforce viewer)
    checkin/[token]/       external contact experience — outside the admin layout
    api/checkin/[token]/   save-response and complete endpoints
  components/              ui/, admin/, checkin/
  lib/                     stages, account types, tokens, formatting, env, db
  server/
    services/              business logic
      campaign-service.ts              preview, launch, reminders, reporting
      recipient-resolution-service.ts  who receives what — pure and isolated
      catalog-service.ts               refresh the cache from Salesforce
      response-service.ts              token → session, save, complete
      sync-service.ts                  push to Salesforce, per-record outcome
      audit-service.ts                 append-only trail
    integrations/
      salesforce/          SalesforceService interface + mock + live providers
      email/               EmailService interface + mock + Resend
```

**Pages render, services decide, integrations talk to the outside world.**

**Data model:** `Account` (external organization) → `ExternalContact` (the
recipient) → `CheckInRecipient` (their tokenized check-in within a `Campaign`) →
`CheckInOpportunity` (one opportunity in front of one recipient). `SalesRep` and
`Opportunity` carry the internal side. `AuditEvent` ties all of it together.

**Providers are swappable by config.** `SALESFORCE_PROVIDER=mock|salesforce` and
`EMAIL_PROVIDER=mock|resend`. The UI and business logic never touch a Salesforce
field directly.

**Security:** check-in links carry a 32-byte random token and nothing else — no
Salesforce ids, organization names, or email addresses. Only a SHA-256 hash is
stored, so a database leak yields no working links. Tokens expire, can be
revoked, and are rotated by reminders. A token resolves to exactly one recipient,
and every write re-verifies ownership — including between two contacts at the
same organization.

Deeper docs: [RECIPIENT-RESOLUTION.md](RECIPIENT-RESOLUTION.md) (how the system
decides who gets each opportunity),
[FIELD-MAPPING.md](src/server/integrations/salesforce/FIELD-MAPPING.md) (every
Salesforce field read and written), [PHASE-2.md](PHASE-2.md) (path to
production).

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build |
| `npm test` | Vitest suite (34 tests) |
| `npm run db:seed` | Reset and rebuild the demo dataset |
| `npm run db:migrate` | Create/apply a migration |
| `npm run typecheck` | `tsc --noEmit` |

Tests cover recipient resolution (every routing branch and edge case), token
security (randomness, hash-only storage, expiry, revocation, cross-recipient
access), and the full workflow (grouping, sync success and failure, retry,
resume, duplicate submission, audit completeness). They run against a throwaway
SQLite database — no dev server needed.

## Current limitations

**Not production-ready as-is. In rough order of importance:**

- **`/admin` has no authentication.** Anyone who can reach the host can launch a
  campaign and email every external contact. Microsoft Entra ID SSO is the
  intended solution; `src/app/admin/layout.tsx` marks the exact insertion point.
  No placeholder auth was added on purpose.
- **Salesforce integration is unproven against a real org.** The live REST
  provider is written but has never run. Four field decisions are blocking —
  most importantly where the partner organization lives on an opportunity, and
  how an inactive contact is represented (Salesforce Contacts have no `IsActive`
  field, so the live provider currently treats every contact as active). See
  FIELD-MAPPING.md.
- **Email is simulated.** Messages are captured in an in-app outbox. A real
  provider plus SPF/DKIM/DMARC is required, and these emails go to people outside
  IDS — deliverability and consent both matter.
- **SQLite locally.** Postgres is a provider change in `schema.prisma` plus a
  connection string; the driver adapter is already selected from `DATABASE_URL`.
- **No rate limiting, structured logging, or alerting.**
- **No per-contact campaign filter**, which a pilot with a handful of contacts
  would need.
- **Reminders are manual** (an admin button). The data model supports automation;
  the scheduler does not exist.
- Demo data is synthetic — all `-demo.com` domains, no real people or companies.

Deliberately not built: AI features, chat, analytics, native apps, recipient
logins, general CRM functionality.
