# Recipient resolution

**How the system decides who receives the check-in for each opportunity.**

```
Opportunity → Primary Opportunity Contact Role → Contact → Email
```

That is the whole rule. It is confirmed IDS business process — the primary
contact role is maintained deliberately on each opportunity, and that person is
who the check-in is for.

The logic lives in exactly one place —
`src/server/services/recipient-resolution-service.ts` — as pure functions with
no database or UI access. Nothing else in the application decides who gets an
email.

---

## The rule

For each open opportunity:

1. `OpportunityContactRole.IsPrimary = true` identifies the recipient.
2. That contact has an email address → **Resolved**.
3. That contact has no email address → **Needs Attention**.
4. No primary contact role exists → **Needs Attention**.

If the role points at a contact record that cannot be read at all, that is also
**Needs Attention** (`PRIMARY_CONTACT_NOT_FOUND`).

## What the rule deliberately does NOT do

These are refusals, not gaps. Each is covered by a test asserting the refusal:

- **No fallback to other contacts on the account.** An account can have a
  single obvious emailable contact sitting right there; if the opportunity does
  not name them, they are not used.
- **No selection based on `Contact_Type__c`.** The field exists (13 values) but
  is 58.8% blank, and "which type is the right recipient" is not a question the
  data can answer.
- **No substituting a different person**, ever — including when the named
  primary contact has no email address.
- **No collapsing of duplicate contact records.** The role names one specific
  record; a different record is a different person as far as this service is
  concerned. Duplicates sharing an email are *reported*, never merged.

### Why the earlier cascade was removed

An earlier version cascaded: named contact → account primary → sole active
contact → deterministic pick among several. Measured against the production org
that reached **80.4%** coverage versus **77.6%** for the primary role alone.

The extra 2.8% was guesswork — it emailed whoever happened to be attached to the
account. Being right matters more than being resolved, so an opportunity that
cannot be routed confidently is surfaced for a human instead of being sent to a
plausible stranger.

## Measured against the production org

1,144 open opportunities:

| Outcome | Count | |
| --- | ---: | ---: |
| **Resolved** | **888** | **77.6%** |
| Needs attention — no primary contact role | 245 | 21.4% |
| Needs attention — primary contact has no email | 11 | 1.0% |

326 distinct contact records → 325 distinct email addresses (one person holds
two records and is reported, not merged).

Re-measure any time with `npm run sf:preview` — read-only, sends nothing.

## Resolution is not authorization to send

Resolving a recipient makes an opportunity **eligible**, never **queued**. The
send lifecycle (`src/lib/send-states.ts`) is:

```
DISCOVERED → ELIGIBLE → SELECTED → QUEUED → SENT
                 ↑
          NEEDS_ATTENTION   (terminal until the Salesforce data is fixed)
```

Only an opportunity a human has explicitly selected can advance past `ELIGIBLE`.
Needs-attention opportunities have no recipient, so they are structurally
unsendable: the UI renders no checkbox for them, and the selection service
independently refuses them server-side.

Selections are re-validated at the moment of send — see "Selection drift" below.

## Selection drift

Salesforce changes between selection and send. Every selected opportunity is
re-resolved server-side at launch, and anything that no longer qualifies is
excluded and reported to the reviewer rather than sent:

| Drift | Detected as |
| --- | --- |
| Opportunity closed | `OPPORTUNITY_CLOSED` |
| Primary contact role removed | `NO_PRIMARY_CONTACT_ROLE` |
| Primary contact's email removed | `PRIMARY_CONTACT_NO_EMAIL` |
| Contact record deleted or unreadable | `PRIMARY_CONTACT_NOT_FOUND` |

The client's selection is never trusted on its own; the send set is always
recomputed from server state.

## Edge cases handled explicitly

**Duplicate contact records.** Reported, never merged. If two records share an
email and both are named as primary on different opportunities, that person
receives two emails — surfaced in the preview so it is a known consequence
rather than a silent one.

**Contacts with no email.** Deliberately queried rather than filtered out in
SOQL, so "primary contact has no email" is distinguishable from "contact not
found". Filtering them would collapse two different problems into one.

**Opportunities owned by an inactive IDS rep.** Excluded from the catalog —
there is no internal owner to act on the answer. Note: 3 inactive users own 54
open opportunities in production; this is an open decision.

**Ownership or contact changes mid-campaign.** A campaign snapshots what was
asked at launch, so the audit trail stays truthful even if Salesforce changes
underneath it.

## Salesforce mapping

The recipient comes from a subquery, not a custom field:

```sql
SELECT Id, Name, Amount, StageName, CloseDate, OwnerId,
       AccountId, Account.Name,
       (SELECT ContactId FROM OpportunityContactRoles WHERE IsPrimary = true)
FROM Opportunity
WHERE IsClosed = false
```

Confirmed against the org: there is **no** partner-account lookup and **no**
custom check-in contact field. Standard `AccountId` and `OpportunityContactRole`
are the real model. Full field contract in
[FIELD-MAPPING.md](src/server/integrations/salesforce/FIELD-MAPPING.md).

## Still open

- **Is the primary contact role always the right person to ask?** 78.6%
  populated proves it is *maintained*, not that it is correct. Worth
  spot-checking a handful against reality.
- **The 245 opportunities with no primary contact role** — a data-quality
  campaign for Sales Ops, not a code change.
- **No way to mark a contact as departed.** Salesforce Contacts have no
  `IsActive`. If IDS adopts a convention, filter it in `getExternalContacts()`.
