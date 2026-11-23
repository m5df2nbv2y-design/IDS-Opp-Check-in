# Runbook: monitoring and alerts

What tells us the app is broken, and what to do about it.

## What is in place

| Signal | How | Who hears |
|---|---|---|
| App or database down | `GET /api/health` runs `SELECT 1` and returns 503 on failure. A Vercel cron calls it every hour (`vercel.json`). | Vercel alert email (below) |
| Any server error in Production | Vercel alert rule **"Production server errors"**: a custom threshold monitor on project `ids-opp-check-in`, counting requests with `httpStatus >= 500`, more than 0 in a 15-minute window, severity high, team-owner notifications on | The team owner, by email (Josh) |
| Salesforce update failed or unconfirmed; invitation failed or unknown | "Problems to fix" banner at the top of the dashboard, per campaign, with a link. Rows stuck mid-write count too: a Salesforce update SYNCING for over 15 minutes, an invitation PENDING for over 15 minutes, and any reminder still REMINDER_PENDING. | Whoever opens `/admin` |
| Problems still open, daily | `GET /api/cron/problems`, a Vercel cron at 15:00 UTC (`vercel.json`). Returns 500 with counts only (`{status:"problems", salesforce, invitations}`) when the banner would show anything, 200 otherwise, so the "Production server errors" rule emails once a day while problems stay open. | The team owner, by email (Josh) |

Vercel's built-in **Default Alert Rule** (all built-in triggers, minimum severity high, team-owner notifications) also stays on.

## When the email arrives

1. Open the alert link. It names the path and the time.
2. **`/api/health`:** the database or the app is down. Check Vercel → Deployments (did a deploy just fail or roll out?) and the Neon console (is the endpoint up?). Roll back with Instant Rollback if a deploy caused it.
3. **`/api/cron/problems`:** problems are open. Open `/admin` and work through the "Problems to fix" banner. The email repeats each day until the banner is empty.
4. **Any other path:** open Vercel → Logs, filtered to that path and time, for the error. Production pages show a generic error, so the log is the only place with the detail.
5. Record what happened in the vault (a comms report and the changelog).

## The daily problems check

- **Time:** 15:00 UTC is 08:00 MST. During daylight time (mid-March to early November) it runs at 09:00 MDT. Vercel crons are UTC-only.
- **`CRON_SECRET`:** must be set in Production. Vercel then sends `Authorization: Bearer $CRON_SECRET` with each cron call. Any call without that header, or any call while `CRON_SECRET` is unset, gets 401 and never a 5xx, so nobody can trigger the alert from outside. Until it is set, the check answers 401 and no email is sent.
- **A single alert that has cleared when you look:** a reminder batch running at the moment of the check can count briefly, because REMINDER_PENDING has no timestamp to age it by. If the banner is empty by the time you open `/admin`, no action is needed.
- **Body:** counts only. No campaign names, contacts, emails or ids.
- **Run it by hand:** `curl -i -H "Authorization: Bearer $CRON_SECRET" https://ids-opp-check-in.vercel.app/api/cron/problems`. A 500 here also triggers the alert email.

## Test the alert (once, after setup)

This test uses a temporary rule on 404s, so the app and database are never touched.

1. Add a temporary rule like the real one, but with `httpStatus = 404` and a 5-minute window.
2. Open a page that doesn't exist, for example `https://ids-opp-check-in.vercel.app/no-such-page`, a few times.
3. The alert email should arrive within about 5 to 10 minutes.
4. Remove the temporary rule: `vercel monitors remove <id>`.

If no email arrives, check Vercel → Settings → Alerts: the rule is enabled and team-owner notifications are on.

## Managing the rule

```bash
vercel monitors ls --project ids-opp-check-in --scope ids-0fdde211
```

The rule is created with `vercel monitors add` from a JSON body (see `vercel monitors schema --type custom`). It belongs to the Vercel team, not the repo, so changing it doesn't need a deploy.

## Not covered yet

- The problems email is daily, not immediate. A problem is reported at the next 15:00 UTC check: the same day if it starts before then, otherwise the next day (worst case about 24 hours), unless someone opens the dashboard first.
- No structured logging beyond `console.*`.
