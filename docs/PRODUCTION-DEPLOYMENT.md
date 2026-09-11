# Production deployment

How to stand up IDS Opportunity Check-In for internal production use.

No secret values appear in this document. Every credential below is created by
you and entered directly into the host's environment settings.

> **Scope note.** Salesforce remains **read-only** in this release.
> `SALESFORCE_WRITE_ENABLED` stays `false`. The eventual write scope is
> `Opportunity.StageName` and `Opportunity.CloseDate` only, and commissioning it
> is a separate, deliberate change.

---

## 1. Required services

| Service | Purpose | Who provisions |
|---|---|---|
| Next.js host (Vercel or equivalent) | Runs the application | You |
| PostgreSQL 14+ | Campaigns, selections, responses, analytics history | You / IT |
| Microsoft Entra ID app registration | Employee sign-in and authorization | Entra admin |
| Salesforce External Client App | Read-only pipeline access | Salesforce admin |
| Salesforce integration user | The identity the app acts as | Salesforce admin |
| Transactional email provider | Customer check-in email | You (deferred) |

Email stays on the mock provider until customer email is deliberately
commissioned. The application is fully functional without it — invitations are
captured in the in-app outbox.

---

## 2. Required environment variables

The canonical list with inline explanation is [`.env.example`](../.env.example).
Everything is server-side; nothing is prefixed `NEXT_PUBLIC_`.

**Production refuses to start if any of these is missing or unsafe.** The check
runs at server startup (`instrumentation.ts` → `src/lib/production-config.ts`)
and names every problem at once.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL only. A `file:` URL is refused — it would silently serve an empty database. |
| `AUTH_SECRET` | `npx auth secret`. Signs session cookies. |
| `AUTH_MICROSOFT_ENTRA_ID_ID` | Application (client) ID. |
| `AUTH_MICROSOFT_ENTRA_ID_SECRET` | Client secret **value**, not the secret ID. |
| `AUTH_MICROSOFT_ENTRA_ID_ISSUER` | Set to the IDS tenant to prevent multi-tenant sign-in. |
| `AUTH_REQUIRED_APP_ROLE` | `SalesOps.Admin`. Without this (or the group fallback) nobody is admitted. |
| `APP_BASE_URL` | Public origin. A localhost value is refused — customers open these links. |
| `SALESFORCE_PROVIDER` | Must be `salesforce`. The mock org is refused in production. |
| `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | External Client App Consumer Key / Secret. |
| `SF_LOGIN_URL` | The org's My Domain host, **not** `login.salesforce.com`. |
| `SALESFORCE_WRITE_ENABLED` | Leave `false`. |
| `EMAIL_PROVIDER` | Leave `mock` until customer email is commissioned. |

`AUTH_DEV_BYPASS` must **not** be set in production. The local sign-in provider
is not registered in a production build at all, and setting the variable is
refused at startup.

---

## 3. Microsoft Entra configuration

1. **App registration** → note the Application (client) ID and Directory
   (tenant) ID.
2. **Certificates & secrets** → new client secret. Copy the **value** now; it is
   shown once.
3. **Authentication** → add the Web redirect URI:
   `https://<your-host>/api/auth/callback/microsoft-entra-id`
4. **API permissions** → `openid`, `profile`, `email` (delegated). Grant admin
   consent.
5. **App roles** → create a role:
   - Display name: `Sales Operations Admin`
   - Value: `SalesOps.Admin` ← this exact string goes in `AUTH_REQUIRED_APP_ROLE`
   - Allowed member types: Users/Groups
6. **Enterprise application → Users and groups** → assign the Sales Operations
   security group to that App Role.

App Roles are used rather than raw group claims on purpose: a user who belongs
to more than 200 groups triggers Entra's "groups overage", which silently drops
the `groups` claim and would lock that person out. The `roles` claim has no such
limit.

---

## 4. Salesforce External Client App

1. **Setup → External Client App Manager → New External Client App.**
2. **OAuth Settings → Flow Enablement** → enable **Client Credentials Flow**.
3. **Scopes**: `api`, `refresh_token`. No write scope is needed for this release.
4. **Policies → Client Credentials Flow → Run As** → the dedicated integration
   user (below).
5. **Deploy** the app — leaving it in Draft produces `invalid_client`.
6. Grant the integration user access to the app: **Setup → Permission Sets →**
   your set **→ External Client App Access →** enable the app **→** assign the
   set to the user. Skipping this produces `invalid_app_access`.
7. Copy the **Consumer Key** and **Consumer Secret** into `SF_CLIENT_ID` /
   `SF_CLIENT_SECRET`.
8. Set `SF_LOGIN_URL` to the org's My Domain host, e.g.
   `https://idsculpture.my.salesforce.com`.

Verify before switching the provider on — this is read-only and writes nothing:

```bash
npm run sf:smoke
```

Set `SF_EXPECTED_USERNAME` and the smoke test asserts the authenticated identity
matches exactly, catching a Run As user that has been changed to a personal
account.

---

## 5. Salesforce integration-user permissions

A dedicated user (e.g. `ids.opportunity.checkin@idsculpture.com`) — never a
human's account, and never a human's credentials.

**Read** on: `Opportunity`, `Account`, `Contact`, `OpportunityContactRole`,
`User`.

Field-level read on: `Opportunity.Name`, `AccountId`, `StageName`, `Amount`,
`CloseDate`, `OwnerId`, `IsClosed`, `IsWon`; `Account.Name`, `Type`;
`Contact.Name`, `Email`, `AccountId`; `OpportunityContactRole.ContactId`,
`IsPrimary`.

No write permission is required for this release. When write-back is
commissioned, it needs edit on `Opportunity.StageName` and
`Opportunity.CloseDate` **only**.

Recommended: restrict the user's login IP ranges to the host's egress addresses.

---

## 6. Production database setup

1. Provision PostgreSQL 16 with TLS (`?sslmode=require`). The Prisma schema
   targets PostgreSQL and the migration history is PostgreSQL-native, so
   `migrate deploy` applies cleanly — local development runs the same engine
   via `npm run db:up`.
2. Set `DATABASE_URL` in the host's environment. It is never committed and never
   reaches the browser.
3. Apply migrations from a machine that can reach the database:

```bash
DATABASE_URL="<production-url>" npx prisma migrate deploy
```

`migrate deploy` applies committed migrations only. It never generates, never
prompts, and never resets — unlike `migrate dev`, which must never be pointed at
production.

**The seed script cannot touch production.** `npm run db:seed` refuses unless
both providers are `mock`, `NODE_ENV` is not `production`, and `DATABASE_URL`
targets a local SQLite file or `localhost`. It deletes every row, so this is
enforced rather than documented.

### Migration workflow

| Situation | Command |
|---|---|
| Develop a schema change | `npm run db:migrate` (local only) |
| Review before shipping | commit the generated folder in `prisma/migrations/` |
| Apply to production | `npx prisma migrate deploy` |
| Inspect production state | `npx prisma migrate status` |

Never run `migrate dev`, `migrate reset`, or `db push` against production.

---

## 7. Email provider setup

Deferred. Keep `EMAIL_PROVIDER="mock"`.

When customer email is commissioned:

1. Choose the provider (Resend is implemented; M365/SendGrid follow the same
   interface in `src/server/integrations/email/`).
2. Verify the sending domain with the provider — SPF, DKIM, DMARC. Sending from
   an unverified domain is rejected.
3. Set `EMAIL_FROM_ADDRESS` to an address on that verified domain.
4. Set the provider's API key, then `EMAIL_PROVIDER="resend"`.

The demo test-email action is separate and stays locked to `DEMO_TEST_EMAIL`.
Leave `DEMO_TEST_EMAIL` unset in production and the control does not render.

---

## 8. Vercel deployment configuration

- **Framework preset**: Next.js. Build `npm run build`; install runs
  `prisma generate` via `postinstall`.
- **Node version**: 20+.
- **Environment variables**: add every variable from section 2 to the Production
  environment. Mark the secrets as sensitive.
- **Region**: pick one close to the database to keep query latency down.
- Salesforce and PostgreSQL are reached only from server code. The browser never
  contacts either.

If the Salesforce integration user is IP-restricted, the host's egress addresses
must be allow-listed, which on serverless platforms may require a static-egress
add-on.

---

## 9. Production callback URL

```
https://<your-host>/api/auth/callback/microsoft-entra-id
```

This must match the Entra redirect URI exactly — scheme, host, and path.
`APP_BASE_URL` must be the same origin, because check-in links inside customer
email are built from it.

Using a custom domain? Set both the Entra redirect URI and `APP_BASE_URL` to the
custom domain, not the generated deployment URL.

---

## 10. Post-deployment smoke tests

Run in order. Stop at the first failure.

1. **Boot** — the deployment starts without a `ProductionConfigError`. A failure
   here names every missing variable.
2. **Unauthenticated** — visit `/admin`; expect a redirect to `/signin`.
3. **Sign-in** — sign in with an Entra account **in** the Sales Operations group.
   Expect the dashboard.
4. **Authorization** — sign in with an account **not** in the group. Expect
   `/not-authorized`, never the dashboard.
5. **Salesforce read** — the dashboard shows real open opportunities, real
   account names, and real owners.
6. **Recipient resolution** — "Needs attention" counts opportunities with no
   primary contact role. A non-zero count is normal and correct.
7. **Selection** — select an account, open review, and confirm the recipient
   list is what you expect. **Do not send** until email is commissioned.
8. **Reports** — export the Executive Brief and the Excel workbook. Both should
   download and contain real figures.
9. **Export authorization** — request
   `/api/admin/reports/executive-brief` while signed out. Expect **401**.
10. **No writes** — confirm in Salesforce that no Opportunity was modified.
    Check the audit trail for `SYNC_WITHHELD` entries if any response was
    recorded.

---

## 11. Rollback procedure

**Application** — redeploy the previous build (Vercel: *Deployments →* previous
*→ Promote to Production*). The application is stateless; nothing else is needed.

**Database** — migrations are forward-only. To roll back a schema change, write
a new migration that reverses it and deploy that. Do not hand-edit the
`_prisma_migrations` table.

**Emergency stop** — to halt all outbound activity without redeploying:

| Action | Effect |
|---|---|
| `SALESFORCE_WRITE_ENABLED="false"` | Responses are recorded but never pushed. Already the default. |
| `EMAIL_PROVIDER="mock"` | No mail leaves the building. Already the default. |
| Remove `AUTH_REQUIRED_APP_ROLE` | Locks everyone out of `/admin` — fails closed. |
| Disable the Entra Enterprise Application | Blocks all sign-in immediately. |

Existing check-in links keep working during an application rollback: tokens live
in the database, not in the build.

---

## 12. Security checklist

Confirm before going live.

- [ ] No `.env` file is committed. Only `.env.example` is tracked.
- [ ] Every secret is set in the host's environment, not in source.
- [ ] No variable is prefixed `NEXT_PUBLIC_`.
- [ ] `AUTH_SECRET` is unique to production, not copied from development.
- [ ] `AUTH_DEV_BYPASS` is unset in production.
- [ ] `AUTH_REQUIRED_APP_ROLE` is set; an unauthorized user reaches
      `/not-authorized`.
- [ ] `AUTH_MICROSOFT_ENTRA_ID_ISSUER` pins the IDS tenant.
- [ ] `SALESFORCE_WRITE_ENABLED` is `false`.
- [ ] The Salesforce integration user is dedicated, not a person, and holds read
      permission only.
- [ ] `DATABASE_URL` uses TLS and is not reachable from the public internet.
- [ ] `APP_BASE_URL` is the real public origin over HTTPS.
- [ ] The Entra redirect URI matches the deployed origin exactly.
- [ ] Rotate the Salesforce Consumer Secret and the Entra client secret on the
      schedule IT requires; note their expiry dates.
- [ ] Read [`PRODUCTION-READINESS.md`](./PRODUCTION-READINESS.md) for the items
      still open — notably rate limiting and monitoring.
