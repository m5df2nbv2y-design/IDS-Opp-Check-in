# Recipient resolution

**How the system decides who receives the check-in for each opportunity.**

This is the single biggest real-world dependency in the product. Salesforce
contact data is never as tidy as a data model suggests, so the logic lives in
exactly one place — `src/server/services/recipient-resolution-service.ts` — as
pure functions with no database or UI access. Nothing else in the application
is allowed to decide who gets an email.

---

## The core idea

The recipient is an **external contact at a partner organization**, never an
internal IDS sales rep.

```
Opportunity ──owned by──> Internal IDS rep     (internal context only)
     │
     └──belongs to──> Account (agency/distributor/direct client)
                          │
                          └──has──> Contacts ──> ONE receives the check-in
```

Consequences that fall out of this, and that the product depends on:

| Relationship | Result |
| --- | --- |
| One contact, many opportunities | One email, one check-in, many cards |
| One account, many contacts | Only the resolved contact(s) are emailed |
| One account, opportunities owned by several IDS reps | Still **one** email |
| One IDS rep, opportunities across many accounts | Their work is spread across several contacts' check-ins |

The worked example: **XYZ Agency** has 9 open opportunities — 4 owned by John
Smith, 3 by Sarah Jones, 2 by Mike Brown. Marcus Webb receives **one** email
containing all 9. He never learns that IDS splits them between three people.

## The resolution rules, in order

For each open opportunity:

1. **Contact named on the opportunity.**
   A Salesforce Opportunity Contact Role or custom lookup. If that contact is
   active, they win — this is the most specific signal available.
   → `OPPORTUNITY_CONTACT`

2. **The account's primary check-in contact.**
   The contact flagged as primary on the account, if active.
   → `ACCOUNT_PRIMARY`

3. **The account's only active contact.**
   Nobody is flagged primary, but there is exactly one active contact.
   → `ONLY_ACTIVE_CONTACT`

4. **Several active contacts, none primary.**
   Deterministic pick (active > primary > lowest Salesforce id) and a warning
   is attached. Guessing beats dropping the opportunity, but Sales Ops is told.
   → `AMBIGUOUS_ACTIVE_CONTACTS`

If none of these produces an active contact, the opportunity is **UNRESOLVED**.

## When resolution fails

An unresolved opportunity is **never silently dropped**. It is:

- excluded from the campaign (nobody can be emailed about it),
- stored with `resolutionStatus = "UNRESOLVED"` and the reason,
- surfaced on the admin dashboard under **Needs attention**, with the
  organization, the internal IDS rep who owns it, and a link to fix it in
  Salesforce,
- counted on the confirmation screen before anything is sent.

| Reason | Meaning | Fix |
| --- | --- | --- |
| `NO_ACCOUNT` | The opportunity has no partner organization | Set the account/partner lookup in Salesforce |
| `NO_CONTACTS` | The account exists but has no contact records | Add a contact in Salesforce |
| `ALL_CONTACTS_INACTIVE` | Every contact at the account is inactive | Reactivate one, or add a replacement |

## Edge cases the service handles explicitly

**Duplicate contact records.** Salesforce routinely holds several Contact
records for one human. Contacts are collapsed per account by normalized
(lowercased, trimmed) email before resolution, preferring active over inactive,
then primary over non-primary, then the oldest id. The duplicates map onto the
survivor, so a contact role pointing at the duplicate still resolves. **One
human receives one email.**

**Named contact has left.** If the opportunity names a contact who is inactive,
the system falls back to the account rules and records a warning naming both
people: *"Greta Sims is named on this opportunity but is no longer active; sent
to Felix Moreau instead."*

**Primary contact has left.** An inactive primary is skipped entirely and the
next rule applies.

**Contacts with no opportunities.** A contact who owns nothing is never emailed,
even if they are active and primary. Recipients are derived from opportunities,
not from the contact list.

**Opportunities owned by an inactive IDS rep.** Excluded from the catalog
entirely — there is no internal owner to act on the answer.

**Ownership changes mid-campaign.** A campaign snapshots the recipient and the
stage at launch. Re-assignment in Salesforce afterwards is not reflected until
the next campaign, which keeps the audit trail truthful.

## How this is exercised in the demo

The mock org contains exactly one example of each case, so `npm test` pins every
branch and the demo shows every outcome:

| Organization | Type | Case demonstrated | Outcome |
| --- | --- | --- | --- |
| ABC Distribution | Distributor | Primary contact; 6 opportunities from 3 IDS reps | Jane Doe, one email |
| XYZ Agency | Agency | 9 opportunities from 3 IDS reps | Marcus Webb, one email |
| Northstar Agency | Agency | Per-opportunity contact roles | Elena Ruiz (3), Tom Becker (2) |
| Cornerstone Health Partners | Direct client | Only active contact, no primary flag | Alan Pierce |
| Trailhead Imaging Partners | Agency | Primary contact is inactive | Falls through to Morgan Lee |
| Gulf Coast Medical Distributors | Distributor | Two Contact records, one human | Sam Whitaker, one email |
| Harborview Health System | Direct client | Opportunity names a contact who has left | Falls back to Felix Moreau, warned |
| Ridgeline Health Advisors | Agency | Account has no contacts | **Needs attention** |

Tests: `tests/recipient-resolution.test.ts`.

## What to confirm with Salesforce before production

The rules above are only as good as the fields they read. Before switching to
the live provider, settle these four questions with whoever owns the org — they
are the difference between this working and quietly emailing the wrong people:

1. **Which account is the "partner" on an opportunity?** The live provider reads
   a `Partner_Account__c` lookup and falls back to `Opportunity.AccountId`. If
   IDS models agency and distributor relationships differently (partner records,
   a junction object, an account hierarchy), that is the change to make.

2. **How is the check-in contact identified?** The provider reads an
   `IDS_CheckIn_Contact__c` lookup and an `IDS_Primary_CheckIn_Contact__c`
   checkbox. Opportunity Contact Roles are the more standard mechanism — if IDS
   uses those, swap the field for a subquery on `OpportunityContactRoles` and
   map the role marked primary.

3. **How is an inactive contact represented?** Salesforce Contacts have no
   `IsActive` field. The live provider currently treats every contact as active,
   which is the one place it is knowingly less strict than the mock. IDS must
   name the field (a status picklist, `Inactive__c`, or an email-opt-out flag)
   and it must be filtered in `getExternalContacts()`.

4. **Is emailing this contact appropriate?** These are external people. Confirm
   opt-out/consent handling and that the chosen contacts are the right ones
   commercially — a distributor's primary contact may not want a check-in about
   every project.

Until those are answered, run against a sandbox and compare the
**Organizations** page against what Sales Ops expects. That page shows, for
every opportunity, which contact it routed to **and why**.
