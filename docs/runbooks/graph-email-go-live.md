# Runbook: Microsoft Graph email go-live

Turns on real email (Microsoft Graph) in Production. Everything else is already live. Salesforce writes were commissioned on 19 Nov 2026.

**Owner:** Josh (sole approver). **Time:** about 30 minutes, plus up to 2 hours if IT has just changed permissions (Exchange caches them).
**Never:** put `GRAPH_*` values in Preview or Development, in chat, or in any doc. Production only.

---

## 0. Before IT responds (done now)

- [x] The app supports Graph sending, with three outcomes (sent, failed, unknown) and no automatic re-send of an unknown.
- [x] Readiness check: Outbox → **Email readiness → Run check**. It sends nothing.
- [ ] Confirm the sending mailbox. Current plan: `hello@idsculpture.com` as sender and Reply-To, from the confirmed pilot settings in `docs/live-integration-commissioning.md`.
- [ ] Send IT the request: `docs/runbooks/graph-it-request.md`.

## 1. IT completes the request

IT confirms:
1. The app registration exists, and you have its **Directory (tenant) ID**, **Application (client) ID** and a **client secret**, with its expiry date.
2. Mail.Send is granted **only for the sending mailbox**, with Exchange **RBAC for Applications**, and **no tenant-wide Mail.Send consent in Entra**.
3. `Test-ServicePrincipalAuthorization -Identity <app> -Resource <mailbox>` shows `Application Mail.Send` with **InScope = True** for the sending mailbox, and False for a mailbox it must not use.

## 2. Add the settings (Production only)

In Vercel, under project `ids-opp-check-in` → Settings → Environment Variables, set the scope to **Production** only:

| Name | Value |
|---|---|
| `GRAPH_TENANT_ID` | from IT |
| `GRAPH_CLIENT_ID` | from IT |
| `GRAPH_CLIENT_SECRET` | from IT (mark as Sensitive) |
| `GRAPH_SENDER_MAILBOX` | the sending mailbox, e.g. `hello@idsculpture.com` |
| `EMAIL_REPLY_TO` | the reply address (optional; usually the same mailbox) |

Leave `EMAIL_PROVIDER=mock` for now. Redeploy Production so the new values load: Deployments → latest → Redeploy.

## 3. Run the readiness check

Outbox → **Email readiness → Run check**. Expected:

- **"Token OK. The internal test send is still required."**
- Settings: all present. Sender mailbox: the one you chose.
- Token roles: **none**. That is correct with RBAC for Applications, because the permission lives in Exchange, not in the token.
  - If the card **warns that Mail.Send is tenant-wide**, stop. The app could send as any mailbox. Ask IT to remove the Entra grant, then run the check again.
- **"Not ready" / HTTP 400 or 401:** a wrong tenant, client ID or secret. Re-enter the values, redeploy, and run the check again.

## 4. Internal test send (the real path, to yourself only)

The synthetic Salesforce opportunity "IDS SYNTHETIC WRITE TEST — 2026-11-04 — NOT A REAL DEAL" has **Josh Young** as its primary contact. A campaign with only that opportunity sends exactly one invitation, to Josh.

1. In Vercel, set `EMAIL_PROVIDER=graph` (Production) and redeploy. **From now on, every launch sends real email.** No one else should launch a campaign until step 6.
2. Dashboard: refresh from Salesforce, filter for "SYNTHETIC", and select **only** that opportunity. Review the recipients: Josh Young is the only one.
3. Confirm and launch.
4. Expected:
   - the campaign page shows the invitation as **Sent**;
   - the email arrives in Josh's inbox from the sending mailbox;
   - a copy is in that mailbox's **Sent Items**.
5. Open the link, complete the check-in without changing the stage (so nothing is written to Salesforce), and confirm that the campaign completes.

**If it fails:**

| What you see | Meaning | Do |
|---|---|---|
| **Failed**, "admin consent" or "scoping" (HTTP 403) | The permission is missing or not yet active | Wait up to 2 h for Exchange's cache, then ask IT to re-run `Test-ServicePrincipalAuthorization`. Use **Re-send invitation** on the campaign page. |
| **Failed**, mailbox (HTTP 404) | `GRAPH_SENDER_MAILBOX` is wrong | Fix the value, redeploy, re-send. |
| **Failed**, secret (HTTP 401) | A wrong or expired secret | Fix the value, redeploy, re-send. |
| **Send outcome unknown** | Microsoft may have accepted it | Check Sent Items **before** anything else. Then, on the campaign page, record what you found ("It was sent" or "It was not sent"). |
| Throttled (HTTP 429) | Microsoft is limiting the rate | Nothing was sent. Re-send later. Note it for the capacity check. |

## 5. Roll back at any time

Set `EMAIL_PROVIDER=mock` and redeploy Production. Email goes back to simulated immediately, and nothing else changes. The `GRAPH_*` values can stay.

## 6. After a passing test

- Record the result in the vault: a comms report and the changelog.
- Decide: either keep `EMAIL_PROVIDER=graph` for the customer pilot, or go back to `mock` until the pilot day.
- Customer pilot: choose a small first set, launch, and watch the campaign page (opens, completions, Salesforce approvals) and the mailbox (non-delivery reports).

## Owners to settle before the customer pilot

- Client secret expiry and rotation: who, and the expiry date in a calendar.
- Watching the sending mailbox for non-delivery reports.
- Mailbox access and retention. Sent Items holds the full message, including each recipient's live check-in link.

References: [RBAC for Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac) · `docs/live-integration-commissioning.md` (Graph outcomes)
