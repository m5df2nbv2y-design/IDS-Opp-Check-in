# Runbook: restore the Production database

How to get Production's data back after a bad change, a bad script or accidental deletion. Rehearsed on 23 Nov 2026: a copy restored to a point one hour back took about 1 second to create, and all 18 tables matched Production exactly.

**Database:** Neon project `still-thunder-23570420`, branch `production` (`br-orange-haze-aelu60pm`), Postgres 18, aws-us-east-2.
**Owner:** Josh. Any restore of Production needs Josh's explicit OK.

## The restore window

Neon can rewind Production to any moment inside its **history retention window**. On 23 Nov this was **6 hours** (`history_retention_seconds` = 21600). Older than that, the only way back is a saved branch (for example `backup-before-pilot-cleanup-2026-11-18`, which expires 17 Dec 2026).

Check it: `neon projects get still-thunder-23570420`.

## Before any risky change (manual backup)

```bash
neon branches create --project-id still-thunder-23570420 --name backup-before-<what>-<YYYY-MM-DD> --no-compute --expires-at <date about 4 weeks out>
```

## Step 1: look before you restore (no risk)

Make a temporary read-only copy at the moment you want, and check it has the data you expect:

```bash
neon branches create --project-id still-thunder-23570420 --name restore-check-<YYYY-MM-DD> \
  --parent <ISO timestamp, e.g. 2026-11-23T14:25:00Z> --type read_only \
  --expires-at <tomorrow> --no-secrets
```

Connect with its connection string, piped from `neon connection-string restore-check-<date> --project-id still-thunder-23570420` and never printed. Then count the rows in the tables you care about, or query the records that were lost. This copy never touches Production.

## Step 2: restore Production in place (needs Josh's OK)

Pick a quiet moment (no admin activity, no campaign in flight). Then:

```bash
neon branches restore production ^self@<ISO timestamp> \
  --project-id still-thunder-23570420 \
  --preserve-under-name production-before-restore-<YYYY-MM-DD>
```

- Production's data rewinds to that moment. The app keeps the same connection string, so it needs no change and no redeploy.
- The state just before the restore is kept as `production-before-restore-<date>`, so the restore itself can be undone.
- Anything written after the chosen moment is lost from Production (but still sits in the preserved branch).

## Step 3: check the app

1. `https://ids-opp-check-in.vercel.app/api/health` answers `{"status":"ok"}`.
2. Sign in: the dashboard loads, and the campaigns and the "Last refreshed" line look right.
3. Record what was restored, to which moment, and why, in the vault (a comms report and the changelog).
4. Delete `production-before-restore-<date>` once you're sure, or set it to expire.

## Notes

- Salesforce writes already pushed before the restore point stay in Salesforce. The app's record of them rewinds, so check the affected campaigns before re-approving anything.
- Emails already sent stay sent. Don't re-send invitations from a restored campaign without checking the outbox first.
