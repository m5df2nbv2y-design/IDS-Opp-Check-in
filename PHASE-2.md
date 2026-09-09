# Phase 2 — what stands between this MVP and a real IDS deployment

The workflow is complete and tested end to end against a mock Salesforce org and
a simulated outbox. Everything below is about connecting it to real systems —
and to real people outside IDS, which raises the stakes on several items.

Items 1–5 are blocking. Items 6–8 must be done before a pilot. Items 9–10 are
the rollout itself.

---

## 1. Microsoft Entra ID (SSO) for admins — **BLOCKING**

**Today:** `/admin` is unauthenticated. Anyone who can reach the host can launch
a campaign and email every external contact IDS works with. The admin banner
says so on every page.

The target architecture is already the shape of the app:

```
IDS employee    → Microsoft SSO   → /admin
External contact → secure token   → /checkin/[token]
```

**What has to happen**

1. Register the application in Entra ID (Azure AD):
   - Redirect URI `https://<host>/api/auth/callback/microsoft-entra-id`
   - Delegated scopes `openid profile email`
   - Note the tenant id, client id, and client secret.
2. Add an OIDC library — Auth.js/NextAuth ships a `microsoft-entra-id`
   provider — with its route handler at `src/app/api/auth/[...nextauth]/route.ts`.
3. Guard the layout. `src/app/admin/layout.tsx` carries a comment block marking
   the exact insertion point; every `/admin` page renders through it and nothing
   else does:
   ```ts
   const session = await auth();
   if (!session) redirect("/api/auth/signin");
   ```
4. **Guard the server actions too.** A layout check does not protect a POST.
   Each export in `src/app/admin/actions.ts` must assert the session itself.
   This is the step most likely to be missed, and `launchCampaignAction` sends
   real email to real customers.
5. Add `proxy.ts` with a `/admin/:path*` matcher so a future admin route cannot
   be added outside the check.
6. Authorize by Entra **group or app role** (a "Sales Operations" group), read
   from the token claim — not by an allow-list of email addresses.

**Must not change:** `/checkin/[token]` stays outside all of this. External
contacts authenticate with the emailed token and must never see a login screen
or a Microsoft prompt. After wiring SSO, verify in a private window that a token
link still works end to end.

**Done when:** an unauthenticated request to `/admin` and a forged POST to a
server action both redirect/401, while a token link still completes a check-in.

## 2. Production Salesforce / SFX configuration — **BLOCKING**

**Today:** `SALESFORCE_PROVIDER=mock`. The live REST implementation exists and is
complete but has never run against an org.

**What has to happen**

Work through
[`FIELD-MAPPING.md`](src/server/integrations/salesforce/FIELD-MAPPING.md) with
the org owner. Four decisions are blocking, and two of them determine **who
receives email**:

1. **Where does the partner organization live on an opportunity?** The provider
   reads a `Partner_Account__c` lookup and falls back to `Opportunity.AccountId`.
   If IDS models agency/distributor relationships differently, this must change.
   *Get this wrong and check-ins go to the wrong company.*
2. **How is the check-in contact identified?** A lookup field, or Opportunity
   Contact Roles? Both are supported; the org has to say which.
3. **How is an inactive contact represented?** Salesforce Contacts have no
   `IsActive` field, and **the live provider currently treats every contact as
   active** — the one place it is knowingly less strict than the mock. Until IDS
   names the field, the app can email someone who has left the company.
4. **Where does the recipient's note go?** Currently `Opportunity.Description`,
   which the live provider overwrites. A dedicated `IDS_CheckIn_Note__c` field or
   a Task is usually correct — and it should make clear the note came from an
   external contact, not an IDS employee.

Then:

5. Create the integration user and Connected App; issue OAuth credentials.
6. Audit validation rules and required-on-stage fields against the four stages
   the app writes.
7. Run the three validation queries in FIELD-MAPPING.md §9 — especially the one
   listing open opportunities whose account has no contact with an email. Every
   row is a "needs attention" item on day one.
8. **Rehearse in a sandbox.** Run one campaign against two or three friendly
   contacts and check the Organizations page: every opportunity should route to
   the contact Sales Ops expects, and the page says *why*.

**Also decide:** whether the OAuth password grant is acceptable to IDS security.
Many orgs require the JWT bearer flow instead — that changes only
`authenticate()`.

**Done when:** a sandbox campaign completes and the changes are visible on the
Salesforce records.

## 3. Production email provider — **BLOCKING**

**Today:** `EMAIL_PROVIDER=mock` — messages are captured in the in-app outbox,
nothing is delivered.

This is higher-stakes than an internal tool: these emails go to **customers,
agencies, and distributors**, from an IDS domain, asking them to click a link.

**What has to happen**

1. Pick the provider. Microsoft 365 (Graph `sendMail`) is the natural fit
   alongside Entra; Resend/SendGrid are simpler. `resend-email-service.ts` is
   the worked example — implement `EmailService`, register it in
   `email/index.ts`, done.
2. **Deliverability is the real risk.** SPF, DKIM, and DMARC on the sending
   domain. A check-in that lands in an external spam filter is a check-in that
   never happens, and IDS will not know why.
3. Choose the From address and make sure replies reach a human — the templates
   tell recipients to reply if their link doesn't work, and external people will.
4. Wire up delivery/open tracking if the provider reports it: the schema already
   has `deliveredAt` and `openedAt` on `EmailMessage` and the recipient record.
5. Test rendering in Outlook desktop, Outlook mobile, Gmail, and iOS Mail. The
   template is table-based with inline styles for exactly this reason.
6. Decide the reminder cadence and who triggers it (today: an admin button;
   `remindedAt` and `reminderCount` are already tracked).
7. **Confirm the commercial and legal position on emailing these contacts** —
   consent, opt-out, and whether a distributor's contact should be asked about
   every project. See item 7.

**Done when:** a real invitation arrives at an external mailbox, is not flagged
as spam, renders correctly, and its button opens the check-in.

## 4. Production database — **BLOCKING**

**Today:** SQLite file. Fine for the demo, wrong for a serverless deployment
where the filesystem is ephemeral.

**What has to happen**

1. Provision Postgres (Vercel Postgres, Azure Database for PostgreSQL — Azure is
   the natural pick alongside Entra).
2. Change the datasource provider in `prisma/schema.prisma` to `postgresql`.
   No model changes needed; `src/lib/db.ts` already picks the driver adapter
   from the `DATABASE_URL` scheme.
3. Run `npx prisma migrate deploy`. **Do not run `db:seed` in production** — it
   deletes everything and loads demo data. Consider removing it from the
   production build entirely.
4. Set up backups and test a restore. This database holds the audit trail;
   opportunity data can be re-pulled from Salesforce, but the record of which
   external contact said what, when, cannot.
5. Configure connection pooling appropriate to the host.

**Done when:** migrations apply cleanly to production Postgres and a restore has
actually been tested once.

## 5. Environment variables and secrets — **BLOCKING**

**Today:** a local `.env`, documented in `.env.example`.

**What has to happen**

1. Move every secret into the platform's secret store (Vercel environment
   variables, Azure Key Vault). Nothing in git — `.env*` is already ignored.
2. Set per environment (dev / sandbox / production):
   - `DATABASE_URL`
   - `APP_BASE_URL` — **must** be the real public origin; it is baked into every
     emailed link, and a wrong value sends every external contact to a dead URL
   - `SALESFORCE_PROVIDER` + the six `SF_*` values
   - `EMAIL_PROVIDER` + provider credentials + `EMAIL_FROM_*`
   - `CHECKIN_TOKEN_TTL_DAYS`
   - the Entra client id/secret/tenant from item 1
3. Keep sandbox and production Salesforce credentials in genuinely separate
   environments. A preview deployment pointed at production Salesforce could
   write real stage changes — or email real customers.
4. Establish secret rotation ownership.

**Done when:** a fresh deploy works with no local file, and no secret exists in
the repository or in CI logs.

## 6. Logging and monitoring

**Today:** `console.log`/`console.warn`, plus a durable audit trail.

**What has to happen**

1. Structured logging with a campaign correlation id, shipped somewhere
   queryable (Vercel log drain, Azure Monitor, Datadog).
2. Error tracking (Sentry or equivalent), server and client.
3. Alert on what actually matters:
   - any `SYNC_FAILED` event
   - a campaign where sync failures exceed a threshold
   - `INVITE_FAILED` — an external contact who never got their email
   - Salesforce auth failures (`AUTH_FAILED` / `NOT_CONFIGURED`)
   - a rise in unresolved opportunities (contact data rotting in Salesforce)
   - a campaign where nobody has opened a link after 48 hours — almost always
     deliverability, not apathy
4. Health check covering database reachability and Salesforce auth.
5. Decide who receives these alerts. Sales Ops, most likely, not IT.

**Done when:** a deliberately broken sync in a sandbox raises an alert to a real
person.

## 7. Security and privacy review

**Today:** the token design is documented and covered by automated tests
(`tests/token-security.test.ts`): randomness, hash-only storage, no data in
URLs, expiry, revocation, reminder rotation, and cross-recipient access —
including between two contacts at the same organization.

**What has to happen**

1. Independent review of the token flow against those assertions.
2. Rate limiting on `/checkin/[token]` and the two API routes. Tokens carry ~256
   bits of entropy so brute force is unrealistic, but an unauthenticated
   endpoint should still be throttled at the edge.
3. Security headers — CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`.
   The outbox preview renders stored email HTML in a `sandbox=""` iframe; keep
   that attribute.
4. Confirm token links are not leaked via `Referer` or analytics. There is no
   third-party script in the recipient flow today — keep it that way.
5. **Privacy review, which is new now that recipients are external.** The
   database holds names, email addresses, and commercial data belonging to other
   companies. Confirm with legal: lawful basis for emailing these contacts,
   opt-out handling, retention period for completed campaigns and audit events,
   what happens on a deletion request, and whether encryption at rest beyond the
   platform default is required.
6. **Confirm what a recipient can see.** By design a contact sees only their own
   organization's opportunities and never an internal IDS rep's name — this is
   tested, but it should be reviewed as a business rule too. Would a distributor
   object to seeing an amount? To seeing a project at a site they do not manage?
7. Penetration test if IDS policy requires one for an internet-facing app.

**Done when:** review is signed off, rate limiting is live, and legal has
approved emailing external contacts.

## 8. Salesforce contact data validation

Distinct from item 2's configuration: this is proving the routing is right with
real data before any external person receives an email. **This is the item most
likely to be underestimated.**

**What has to happen**

1. Run a catalog refresh against the sandbox and open the **Organizations**
   page. For every opportunity it shows the contact it routed to and the reason.
   Walk it with Sales Ops.
2. Work the **needs attention** list to zero, or accept each remaining item
   knowingly. Every entry is an opportunity nobody will be asked about.
3. Check the `AMBIGUOUS_ACTIVE_CONTACTS` warnings — each is an account with
   several active contacts and no primary flag, where the app picked one. Those
   accounts need a primary contact set in Salesforce.
4. Check the duplicate-collapse count on the catalog refresh audit event.
   Confirm the survivors are the right people.
5. Verify a sample of contacts are still at those companies. Contact data decays
   faster than anything else in a CRM, and this app turns stale contacts into
   bounced or misdirected email.
6. Reconcile counts against a Salesforce report of open opportunities; any
   difference must be a known exclusion from FIELD-MAPPING.md §8.
7. Write one record end to end and inspect field history to confirm the app
   touched only `StageName` and the note field.

**Done when:** Sales Ops has reviewed the full routing list and signed off on
who will be emailed.

## 9. Pilot with a small group

**What has to happen**

1. Pick 3–5 external contacts — ideally a mix: one distributor with a single
   contact, one agency spanning several IDS reps, one direct client. Warn them
   it is a pilot and that a human is watching.
2. Run a real campaign against production Salesforce for those contacts only.
   **This needs a recipient filter that does not exist yet** — the smallest
   version is an optional `contactIds` argument to `launchCampaign()`, a
   contained change to `campaign-service.ts`.
3. Measure what matters:
   - time from open to submit (the 60-second claim)
   - completion rate without a reminder
   - how many needed a second link
   - sync failures
   - **anyone who replied confused about who was asking** — these are external
     people who did not ask for this email
4. Ask each pilot contact one question: *did you need anyone to explain it?* If
   the answer is ever yes, that is a UX bug, not a training problem.
5. Verify the audit trail against what the contacts say they did, and check that
   the internal IDS reps agree with the updates now on their opportunities.
6. Fix what the pilot surfaces before widening.

**Done when:** every pilot contact completed unaided and the owning IDS reps
agree their Salesforce records are correct.

## 10. Production deployment

**What has to happen**

1. Deploy to the IDS-approved host. Vercel is what the app is built for; Azure
   Container Apps also works with a standard Next.js standalone build.
2. Custom domain plus TLS. The domain appears in every emailed link and it is
   being sent to people outside IDS — it should look unmistakably like IDS, or
   recipients will treat it as phishing.
3. Set `APP_BASE_URL` to that origin. Re-check it; it cannot be corrected after
   emails go out.
4. CI: run `npm run typecheck`, `npm run lint`, and `npm test` on every push, and
   `prisma migrate deploy` on release.
5. Protect preview deployments so they cannot reach production Salesforce or
   send real mail.
6. Write the runbook Sales Ops will use: how to launch a campaign, how to read
   the dashboard, what "needs attention" means and how to fix it, what a Sync
   Error means, when to retry versus escalate, and who to call.
7. Schedule the bi-annual run. Automating it is a small change (a cron route
   calling `launchCampaign()`), but do the first one or two manually — an
   automated campaign that emails every external contact is impossible to recall.

**Done when:** Sales Ops has run a full campaign themselves, without engineering
in the room.

---

## Explicitly not in Phase 2

Deferred on purpose, and none of it is needed to replace the spreadsheet:
manager dashboards, opportunity aging alerts, AI-generated follow-up questions,
AI detection of stale opportunities, reporting/export, historical trend
analysis, native mobile apps, and any kind of recipient login.

Automated scheduling and automatic reminders are the first two features worth
adding once the manual process is trusted — the data model already supports both.
