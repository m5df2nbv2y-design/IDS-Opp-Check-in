# Capacity and dependencies

Checked 23 Nov 2026 (item 6 of the pre-Graph work). Re-check before a campaign much larger than the catalogue below, and after any major upgrade.

## Today's size (Production, read-only counts)

| What | Count |
|---|---|
| Open opportunities ready to send | 925 |
| Contacts they reach (one email each) | **339** |
| Most opportunities on one contact | 97 (median 1) |
| Database size | about 36 MB |

So the biggest possible campaign today is **339 emails**.

## Limits that matter

| Limit | Value | Effect on a 339-email launch |
|---|---|---|
| Vercel function time (admin pages and their actions) | **800 s** (`maxDuration` in `src/app/admin/layout.tsx`; Vercel Pro maximum). The default was 300 s. | Launch sends one email at a time. At about 0.5–1 s each that is 3–6 minutes: inside 800 s, with room to spare. |
| Exchange Online, per mailbox | 30 messages a minute; 10,000 recipients a day | Messages over 30 a minute are queued by Exchange and delivered in later minutes, not refused. Expect delivery spread over about 12 minutes. |
| Exchange Online, whole tenant | A separate limit on external recipients for the whole PlayCore tenant | Not a concern at this volume. Over it, sends bounce with `5.7.233`. |
| Re-send all failed | Stops after 180 s and says how many are left | Press it again for the rest. |
| Neon database | 0.25–2 compute units (autoscaling), 7-day restore window | Far above what one admin and a few hundred contacts need. |
| Contact-facing rate limits | Enforced (20 Nov): page 60/min, save 120/min, complete 10/min per link | Observed peaks were 3, 1 and 1. |

## If a launch stops part-way

If the function still runs out of time or crashes, the emails already sent stay sent and nobody gets a second one:
- Contacts not reached yet: on the campaign page, **Resume unsent invitations**.
- An email cut off mid-send shows as **unknown** after 15 minutes. Check hello@idsculpture.com's **Sent Items** before you record what happened.

## Not measured yet

- **Real Graph send time per email.** Email is still simulated. Note how long the single invitation takes during the internal test send (`graph-email-go-live.md`, step 4).
- **Salesforce API use.** A catalogue refresh takes about 20 s and uses few API calls. The org's daily allowance was not checked; Salesforce → Setup → System Overview shows it.

## Dependency review (23 Nov 2026)

- `npm audit`: **0 vulnerabilities**. The one finding was a ReDoS in `effect`, a build-time helper inside the Prisma command-line tool, not in the app's runtime. Fixed by pinning `effect` to its patched 3.x release in `package.json` → `overrides`. Remove the override once Prisma ships a newer `effect` itself.
- Patch and minor updates within the existing ranges were applied: `pg`, `svix`, Tailwind, Vitest, Prisma adapters and `tsx`.
- **Deliberately not upgraded:** these are major versions, each a separate job if wanted:
  - TypeScript 7
  - ESLint 10
  - Prisma 8 (still a release candidate)
  - dotenv 18
  - `@types/node` 26 (Vercel runs Node 24)
  - React 19.3 (Next 16.4.6 pins 19.2)
- **Watch:** `next-auth` 5 is still published as a beta (`5.0.0-beta.32`, the newest). It has been stable for sign-in here; take new betas only with a sign-in test.
- `next` 16.4.6 is the newest release.
