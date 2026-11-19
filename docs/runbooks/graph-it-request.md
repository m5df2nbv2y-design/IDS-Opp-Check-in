# IT request: Microsoft Graph Mail.Send for IDS Opportunity Check-In

> **Sent 2026-11-19** to PlayCore IT (request 74383), as a shorter version: scope Mail.Send to hello@idsculpture.com on the **existing sign-in app** and keep its client secret, plus the SPF/DKIM/DMARC question. The longer draft below is kept for reference.

*Draft for Josh to send to IT. It contains no secrets.*

---

**Subject:** Graph Mail.Send for the Opportunity Check-In app, limited to one mailbox

Hi,

Our Opportunity Check-In app (hosted on Vercel, signed in with our Microsoft accounts) needs to send check-in emails to customers from **one** shared mailbox. Please could you set up the following.

**1. App registration (Entra ID)**
- An app registration for "IDS Opportunity Check-In" (or reuse the existing one, if it was already created for sign-in), with a **client secret**. Please tell me its expiry date.
- Please send me the **Directory (tenant) ID** and the **Application (client) ID**. Give me the secret through a secure channel, not email. I'll add it to the app's production settings myself.

**2. Mail.Send limited to the sending mailbox (Exchange RBAC for Applications)**
- Sending mailbox: **hello@idsculpture.com** *(Josh to confirm)*.
- Please grant Mail.Send **only for that mailbox**, using Exchange Online RBAC for Applications, which is Microsoft's replacement for Application Access Policies:
  ```powershell
  New-ServicePrincipal -AppId <Application ID> -ObjectId <Enterprise app Object ID> -DisplayName "IDS Opportunity Check-In"
  New-ManagementScope -Name "IDS Check-In sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'hello@idsculpture.com'"
  New-ManagementRoleAssignment -App <Enterprise app Object ID> -Role "Application Mail.Send" -CustomResourceScope "IDS Check-In sender"
  ```
  (Use the IDs from **Enterprise applications**, not App registrations.)
- **Please do not grant tenant-wide Mail.Send in Entra.** If it's already granted, please remove it: Microsoft adds the two grants together, so a tenant-wide grant would let the app send as any mailbox.
- Please confirm with:
  ```powershell
  Test-ServicePrincipalAuthorization -Identity "IDS Opportunity Check-In" -Resource hello@idsculpture.com
  ```
  It should show `Application Mail.Send` with **InScope = True**, and False for any other mailbox.

**3. Mailbox questions**
- How long are Sent Items retained?
- Who should watch it for bounce (non-delivery) messages?
- Is SPF, DKIM and DMARC already in place for idsculpture.com, so these emails aren't flagged as spam?

The app needs no other permissions: no mailbox reading and no directory access. It only sends.

Reference: https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac

Thanks,
Josh
