# Salesforce / SFX field contract

Everything the check-in application reads from Salesforce, everything it writes
back, and what must be true before `SALESFORCE_PROVIDER=salesforce` is turned
on. Hand this to whoever owns the IDS org.

The application never references a Salesforce field outside the two files this
document describes:

- `src/server/integrations/salesforce/live/salesforce-service.ts` — queries and writes
- `src/lib/stages.ts` and `src/lib/account-types.ts` — the picklist mappings

Everything else speaks only the domain types in `types.ts`.

## Object mapping

| Salesforce | IDS Check-In | Role |
| --- | --- | --- |
| `Account` | Organization | Standard `Opportunity.AccountId`. **There is no partner-account relationship** — confirmed. |
| `Contact` | External contact | **Receives the check-in email** |
| `OpportunityContactRole` | Recipient link | `IsPrimary = true` — **the canonical recipient signal** |
| `User` | Internal IDS sales rep | Owns the opportunity; internal context only |
| `Opportunity` | Opportunity | The unit reviewed and synced |

## THE CANONICAL RECIPIENT RULE — CONFIRMED

```
Opportunity → Primary Opportunity Contact Role → Contact → Email
```

IDS deliberately maintains a primary contact role on each opportunity, and that
person is the intended recipient. Implemented in
`src/server/services/recipient-resolution-service.ts`.

1. `OpportunityContactRole.IsPrimary = true` identifies the recipient.
2. That contact has an email → **Resolved**.
3. That contact has no email → **Needs Attention**.
4. No primary contact role → **Needs Attention**.

**Never** fall back to another contact on the account. **Never** select on
`Contact_Type__c`. **Never** substitute another person. An opportunity that
cannot be routed confidently is surfaced for a human.

Measured against the production org (1,144 open opportunities):

| Outcome | Count | |
| --- | ---: | ---: |
| Resolved | 888 | 77.6% |
| Needs attention — no primary contact role | 245 | 21.4% |
| Needs attention — primary contact has no email | 11 | 1.0% |

326 distinct contact records, 325 distinct email addresses.

---

## 1. Read: internal IDS sales reps

```sql
SELECT Id, Name, Email, IsActive FROM User WHERE IsActive = true
```

| App field (`SalesforceRep`) | Salesforce field | Notes |
| --- | --- | --- |
| `externalId` | `User.Id` | 18-char id. **The join key**, stored on `SalesRep.externalId`. |
| `name` | `User.Name` | Shown in the admin audit trail. **Never shown to external contacts.** |
| `email` | `User.Email` | Internal reference only — the app does not email reps. |
| `active` | `User.IsActive` | Opportunities owned by an inactive user are excluded entirely. |

**Decision needed:** every active user is currently treated as a sales rep. IDS
likely wants a narrower set — a Role, Profile, Permission Set, or a
`Sales_Rep__c` flag. Add that filter in `getSalesReps()`.

## 2. Read: organizations

```sql
SELECT Id, Name, Type FROM Account WHERE IsDeleted = false
```

| App field (`SalesforceAccount`) | Salesforce field | Notes |
| --- | --- | --- |
| `externalId` | `Account.Id` | **The join key** for contacts and opportunities. |
| `name` | `Account.Name` | Shown throughout the admin UI. |
| `type` | `Account.Type` | Mapped through `src/lib/account-types.ts`. Unknown values become `OTHER` rather than being dropped. |

Account type mapping:

| App value | `Account.Type` |
| --- | --- |
| `AGENCY` | `Agency` |
| `DISTRIBUTOR` | `Distributor` |
| `DIRECT_CLIENT` | `Direct Client` |
| `OTHER` | anything else |

Type is presentational — it does not change routing. If IDS's picklist differs,
edit `salesforceValue` in `account-types.ts`.

## 3. Read: external contacts — the recipients

```sql
SELECT Id, AccountId, Name, Email
FROM Contact
WHERE AccountId != null
```

| App field (`SalesforceContact`) | Salesforce field | Notes |
| --- | --- | --- |
| `externalId` | `Contact.Id` | **The join key**, stored on `ExternalContact.externalId`. |
| `accountExternalId` | `Contact.AccountId` | Contacts with no account are skipped. |
| `name` | `Contact.Name` | The greeting: "Hi Jane 👋". |
| `email` | `Contact.Email` | **Where the check-in is sent.** Also the deduplication key. |
| `isPrimary` | *(not used)* | **Resolved:** no such field exists, and resolution does not need one — the primary role lives on the Opportunity. |
| `active` | *(not used)* | Salesforce Contacts have no `IsActive`. Not currently filtered. |

Contacts **without** an email are deliberately queried, so resolution can tell
"primary contact has no email" (11 opportunities) apart from "contact not
found". Filtering them out in SOQL would collapse those into a single
indistinguishable failure.

`Contact_Type__c` exists (13 values) but is **58.8% blank** and is deliberately
NOT used for recipient selection — see the canonical rule above.

**Open, non-blocking:** Salesforce has no standard way to mark a contact as
departed. If IDS adopts one (a status picklist, `Inactive__c`,
`HasOptedOutOfEmail`), filter it in `getExternalContacts()`.

## 4. Read: open opportunities

```sql
SELECT Id, Name, Amount, StageName, CloseDate, OwnerId,
       AccountId, Account.Name,
       (SELECT ContactId FROM OpportunityContactRoles WHERE IsPrimary = true)
FROM Opportunity
WHERE IsClosed = false
```

| App field (`SalesforceOpportunity`) | Salesforce field | Notes |
| --- | --- | --- |
| `externalId` | `Opportunity.Id` | **The join key.** Never appears in a URL a recipient sees. |
| `opportunityName` | `Opportunity.Name` | The project line on the card. |
| `projectName` | `Opportunity.Name` | Same field today; split if IDS captures a project separately. |
| `customerName` | `Account.Name` | The end customer / project site — the card headline. |
| `amount` | `Opportunity.Amount` | Null → `0`. Display only; never written back. |
| `stage` | `Opportunity.StageName` | Mapped through `src/lib/stages.ts`. **Unmapped stages are skipped.** |
| `closeDate` | `Opportunity.CloseDate` | Display only in the admin views. |
| `ownerExternalId` | `Opportunity.OwnerId` | The internal IDS rep. |
| `accountExternalId` | `AccountId` | Grouping and display only. **Confirmed: no partner-account lookup exists.** |
| `primaryContactExternalId` | `(SELECT ContactId FROM OpportunityContactRoles WHERE IsPrimary = true)` | **The recipient.** |
| `url` | derived | `{instanceUrl}/lightning/r/Opportunity/{Id}/view` — admin-only. |

**Resolved:** "open" is `IsClosed = false`. Verified against the org — all 1,144
open opportunities sit in the four mapped stages, so nothing is skipped for an
unmapped stage.

The org's only Opportunity custom fields are `shopbuilt_or_sitebuilt__c` (97.1%
"shopbuilt") and `Project_Type__c` (72.4% "Components"). Neither is used —
low information value for check-in routing.

## 5. Stage / picklist mapping

`src/lib/stages.ts` is the single source of truth, both directions.

| App value (stored, audited) | `Opportunity.StageName` |
| --- | --- |
| `QUALIFICATION` | `Qualification` |
| `PROPOSAL` | `Proposal` |
| `SPECIFIED` | `Specified` |
| `NEGOTIATION` | `Negotiation` |

Reads are matched case-insensitively and trimmed. If the org's labels differ
(`Spec'd In`, `Negotiation/Review`), change only the `salesforceValue` entries —
stored values, audit history, and the UI stay stable.

## 6. Write: what the check-in pushes back

One PATCH per opportunity, only for contacts who completed their check-in:

```
PATCH /services/data/v61.0/sobjects/Opportunity/{Id}
{ "StageName": "Negotiation",
  "Description": "[Fall 2026 Check-In] Waiting on the CFO signature." }
```

| App value | Salesforce field | Notes |
| --- | --- | --- |
| `updatedStatus` | `Opportunity.StageName` | Only ever one of the four controlled values. |
| *(planned)* | `Opportunity.CloseDate` | In scope. 87.7% of open opportunities are already past their close date. |

**CONFIRMED WRITE SCOPE: `StageName` and `CloseDate` ONLY.**

**Notes/comments are explicitly descoped.** No `Description` write-back, and no
custom check-in note field. The `NOTE_FIELD` constant and
`updateOpportunityComment()` remain in the codebase for the mock provider's demo
but are **not** part of the confirmed write scope and must not be pointed at the
production org.

Nothing else is ever written. The app never creates, deletes, reassigns, or
closes an opportunity, and never writes `Amount`, `OwnerId`, or any Account or
Contact field.

### Writes that are deliberately skipped

If a contact confirms the stage already in Salesforce **and** leaves no note,
nothing is sent. The confirmation is still recorded locally and appears in the
audit trail as `SYNC_SKIPPED`. This keeps `LastModifiedDate` and field history
clean — a bi-annual check-in should not touch 200 unchanged records.

## 7. What happens when a Salesforce update fails

Each opportunity syncs independently. One rejection never blocks another record,
another recipient, or the campaign.

On failure the app:

1. Marks that `CheckInOpportunity` as `syncStatus = FAILED`, stores the org's own
   error message verbatim in `syncError`, and increments `syncAttempts`.
2. Writes a `SYNC_FAILED` audit event including the attempted transition, the
   external contact, and the internal IDS rep.
3. Surfaces it in the admin dashboard: the recipient's row flips to **Sync
   Error**, the campaign's counter increments, and a **Retry N failed syncs**
   button appears with the raw error text per record.
4. Leaves the answer intact. **The external contact is never shown the error and
   never has to redo anything** — their submission is stored regardless of
   whether Salesforce accepted it.

Retry re-sends only `PENDING` and `FAILED` records, so it is safe to press
repeatedly. `SalesforceSyncError.retryable` distinguishes transient failures
(5xx, 429, validation rules ops can clear) from permanent ones (record deleted,
opportunity closed).

| Code | Cause | Retryable |
| --- | --- | --- |
| `NOT_CONFIGURED` | Credentials missing | No |
| `AUTH_FAILED` | OAuth rejected | No (fix config) |
| `QUERY_FAILED` | SOQL rejected | Depends |
| `UPDATE_FAILED` | PATCH rejected — validation rules, required fields, field-level security | 5xx/429 yes, else no |
| `ENTITY_IS_DELETED` | Record gone since the campaign launched | No |

**The failure that will actually happen at IDS:** a validation rule or a
required-on-stage field blocks the PATCH. Rehearse it — the mock provider
simulates exactly this (`syncBlocked` in `mock/mock-data.ts`), and the demo
shows the full error-to-retry-to-clear path.

## 8. Records the app intentionally excludes

| Situation | Behaviour | Why |
| --- | --- | --- |
| `StageName` outside the four controlled values | Opportunity skipped | Better to omit than guess and write a wrong stage |
| Owner is inactive or not in the rep set | Opportunity skipped | No internal owner to act on the answer |
| `IsClosed = true` | Never included | Not an open opportunity |
| No usable external contact | **Kept and flagged for admin attention** | Never silently dropped — see RECIPIENT-RESOLUTION.md |
| Opportunity closes mid-campaign | Kept, flagged `isOpen = false`, excluded from new campaigns | Audit trail must survive |
| Owner or contact changes mid-campaign | The campaign keeps what it snapshotted | The contact who was asked is the contact who answers |

Nothing is skipped silently. Owner-related skips are counted on the
`CATALOG_REFRESHED` audit event (visible at /admin/audit); unmapped stages are
logged per record as `[salesforce] skipped {Id} — unmapped stage "{StageName}"`;
unresolved contacts appear on the dashboard. Check all three after the first
sandbox run.

## 9. Required before production

**Org configuration**

- [ ] Integration user with API Enabled; Read on `User`, `Account`, `Contact`,
      `Opportunity`; Edit on `Opportunity.StageName` and the chosen note field.
- [ ] External Client App with the Client Credentials flow enabled, a Run As
      user set to the integration user, and Consumer Key + Secret issued.
- [ ] Decide the rep set (§1).
- [ ] Confirm the account type picklist (§2).
- [ ] **Create/identify the primary-contact flag and the contact-inactive
      field (§3).** Both are blocking.
- [ ] **Confirm where the partner organization lives on the opportunity (§4).**
      Blocking — this determines who gets emailed.
- [ ] Decide whether contacts are named via a lookup or Opportunity Contact
      Roles (§4).
- [ ] Confirm the stage picklist (§5).
- [ ] Decide the note field (§6) and create it if custom.
- [ ] Review validation rules and required-on-stage fields against the four
      stages the app writes (§7).

**Validation queries** — run in the Developer Console before go-live:

```sql
-- What the app will pick up, and what it will skip
SELECT StageName, COUNT(Id) FROM Opportunity WHERE IsClosed = false GROUP BY StageName

-- Open opportunities whose account has no contact with an email:
-- every row here becomes a "needs attention" item
SELECT Id, Name, Account.Name FROM Opportunity
WHERE IsClosed = false
  AND AccountId NOT IN (SELECT AccountId FROM Contact WHERE Email != null)

-- Accounts with several contacts: each needs a primary flag,
-- or the app will pick one for you
SELECT AccountId, COUNT(Id) FROM Contact WHERE Email != null GROUP BY AccountId HAVING COUNT(Id) > 1
```

**Application configuration**

```bash
SALESFORCE_PROVIDER=salesforce
SF_AUTH_FLOW=client_credentials
SF_LOGIN_URL=https://idsculpture.my.salesforce.com   # My Domain host, not login.salesforce.com
SF_CLIENT_ID=…                                       # External Client App Consumer Key
SF_CLIENT_SECRET=…                                   # External Client App Consumer Secret
```

**Authentication** — the app uses the OAuth 2.0 **client credentials** flow
against an External Client App. The integration identity
(`ids.opportunitycheckin@idsculpture.com`) is configured in Salesforce as the
app's **Run As** user and is never sent in the request, so there is no user
password to rotate or leak. This requires, on the External Client App:

- OAuth Settings → Flow Enablement → **Enable Client Credentials Flow**
- Policies → Client Credentials Flow → **Run As** = the integration user

Set `SF_AUTH_FLOW=password` (plus `SF_USERNAME`/`SF_PASSWORD`) only if org
policy forbids client credentials. The flow logic is isolated in
`live/auth.ts`; adding JWT bearer later means adding a branch there and
nothing else.

Verify any org before switching the provider on:

```bash
npm run sf:smoke     # read-only: authenticates, confirms identity, describes objects
```

**Rehearsal** — point at a **sandbox** first and run one campaign against two or
three friendly contacts. Verify on the Organizations page that every opportunity
routed to the contact Sales Ops expects, then check that stage writes land, the
note lands where intended, and a deliberately blocked record shows as Sync Error
and clears on retry.
