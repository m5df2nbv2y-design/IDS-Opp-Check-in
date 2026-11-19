# Runbook: monitoring and alerts

What tells us the app is broken, and what to do about it.

## What is in place

| Signal | How | Who hears |
|---|---|---|
| App or database down | `GET /api/health` runs `SELECT 1` and returns 503 on failure. A Vercel cron calls it every hour (`vercel.json`). | Vercel alert email (below) |
| Any server error in Production | Vercel alert rule **"Production server errors"**: a custom threshold monitor on project `ids-opp-check-in`, counting requests with `httpStatus >= 500`, more than 0 in a 15-minute window, severity high, team-owner notifications on | The team owner, by email (Josh) |
| Salesforce update failed or unconfirmed; invitation failed or unknown | "Problems to fix" banner at the top of the dashboard, per campaign, with a link | Whoever opens `/admin` |

Vercel's built-in **Default Alert Rule** (all built-in triggers, minimum severity high, team-owner notifications) also stays on.

## When the email arrives

1. Open the alert link. It names the path and the time.
2. **`/api/health`:** the database or the app is down. Check Vercel → Deployments (did a deploy just fail or roll out?) and the Neon console (is the endpoint up?). Roll back with Instant Rollback if a deploy caused it.
3. **Any other path:** open Vercel → Logs, filtered to that path and time, for the error. Production pages show a generic error, so the log is the only place with the detail.
4. Record what happened in the vault (a comms report and the changelog).

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

- No email when a Salesforce write fails. It shows only in the dashboard banner. A later step could have the hourly check report open problems.
- Rows stuck mid-write (SYNCING, or PENDING sends after a crash) don't appear in the banner. Campaign pages show them.
- No structured logging beyond `console.*`.
