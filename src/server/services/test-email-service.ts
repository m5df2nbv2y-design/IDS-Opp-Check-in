import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { formatShortDate } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import { ResendEmailService } from "@/server/integrations/email/resend-email-service";
import { buildTestCheckInEmail } from "@/server/integrations/email/templates/test-check-in-email";
import { AUDIT_EVENTS, recordAudit } from "./audit-service";

/**
 * The demo test-email path.
 *
 * This is the ONLY place in the application that sends real mail, and it is
 * deliberately narrow:
 *
 *   - The recipient is read from DEMO_TEST_EMAIL on the server. The caller
 *     passes a recipient *record id*, never an address, so there is no input
 *     through which the browser could redirect a send.
 *   - A contact's real Salesforce email is never used as the destination. It is
 *     shown in the body as context and nothing more.
 *   - With DEMO_TEST_EMAIL unset the action fails closed and sends nothing.
 *   - It reuses the check-in link already minted for the real recipient, so the
 *     response lands in the existing campaign exactly like the mock flow. No new
 *     token, no new recipient, no new campaign, nothing added to engagement
 *     counts.
 *
 * It calls Resend directly rather than through getEmailService(), because the
 * configured provider stays "mock" — the normal flow must remain simulated even
 * while this action can send for real.
 */

export type TestEmailResult =
  | { ok: true; sentTo: string; opportunityName: string; alreadySent?: boolean }
  | {
      ok: false;
      reason: "NOT_CONFIGURED" | "RECIPIENT_NOT_FOUND" | "NO_CHECKIN_LINK" | "SEND_FAILED";
      message: string;
    };

/** A second click inside this window is treated as the same send. */
const DUPLICATE_WINDOW_MS = 30_000;

export async function sendDemoTestEmail(
  recipientId: string,
  actor: string,
): Promise<TestEmailResult> {
  const deliverTo = env.demoTestEmail.trim();
  if (!deliverTo) {
    return {
      ok: false,
      reason: "NOT_CONFIGURED",
      message: "DEMO_TEST_EMAIL is not set, so no test email was sent.",
    };
  }

  const recipient = await prisma.checkInRecipient.findUnique({
    where: { id: recipientId },
    include: {
      contact: { include: { account: true } },
      campaign: true,
      items: { orderBy: { amount: "desc" } },
    },
  });
  if (!recipient || recipient.items.length === 0) {
    return {
      ok: false,
      reason: "RECIPIENT_NOT_FOUND",
      message: "That check-in recipient no longer exists.",
    };
  }

  // The raw token is never stored — only its hash — so the live link is
  // recovered from the invitation that was already sent, rather than minted
  // again. Re-minting would invalidate the real recipient's link.
  const invite = await prisma.emailMessage.findFirst({
    where: {
      campaignId: recipient.campaignId,
      contactId: recipient.contactId,
      kind: { in: ["INVITE", "REMINDER"] },
      linkUrl: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!invite?.linkUrl) {
    return {
      ok: false,
      reason: "NO_CHECKIN_LINK",
      message: "No check-in link exists for this recipient yet. Send the campaign first.",
    };
  }

  const recent = await prisma.emailMessage.findFirst({
    where: {
      kind: "TEST",
      contactId: recipient.contactId,
      campaignId: recipient.campaignId,
      status: "SENT",
      createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    },
  });
  const headline = recipient.items[0];
  const opportunityName = headline.projectName ?? headline.opportunityName;

  if (recent) {
    // A double-click is not an instruction to send twice.
    return { ok: true, sentTo: deliverTo, opportunityName, alreadySent: true };
  }

  const message = buildTestCheckInEmail({
    contactName: recipient.contact.name,
    organizationName: recipient.contact.account.name,
    deliverTo,
    opportunityName,
    currentStage: stageLabel(headline.previousStatus),
    closeDate: headline.previousCloseDate
      ? formatShortDate(headline.previousCloseDate)
      : "Not set in Salesforce",
    opportunityCount: recipient.items.length,
    checkInUrl: invite.linkUrl,
    campaignId: recipient.campaignId,
    contactId: recipient.contactId,
  });

  // Final guard: whatever the template produced, the destination is the
  // configured address. Nothing between here and the provider can change it.
  message.to = { name: message.to.name, email: deliverTo };

  const result = await new ResendEmailService().send(message);

  await recordAudit({
    type: AUDIT_EVENTS.TEST_EMAIL_SENT,
    summary:
      result.status === "SENT"
        ? `${actor} sent a demo test email to ${deliverTo} for ${opportunityName}`
        : `${actor} attempted a demo test email to ${deliverTo} — send failed`,
    actor,
    actorKind: "ADMIN",
    detail: result.error ?? null,
    campaignId: recipient.campaignId,
    contactId: recipient.contactId,
    accountId: recipient.contact.accountId,
  });

  if (result.status === "FAILED") {
    return {
      ok: false,
      reason: "SEND_FAILED",
      message: result.error ?? "The email provider rejected the send.",
    };
  }

  return { ok: true, sentTo: deliverTo, opportunityName };
}
