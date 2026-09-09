import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import type { EmailProviderInfo, EmailSendResult, EmailService, OutboundEmail } from "./types";

/**
 * Example real provider. Kept deliberately thin: it is here to prove the
 * abstraction holds, and to be the template for a Microsoft 365 / SendGrid /
 * IDS-approved provider. Set EMAIL_PROVIDER=resend and RESEND_API_KEY to use it.
 *
 * Every send is still recorded in the outbox table, so the admin audit view is
 * identical regardless of provider.
 */
export class ResendEmailService implements EmailService {
  readonly info: EmailProviderInfo = {
    id: "resend",
    label: "Resend",
    simulated: false,
  };

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    let status: "SENT" | "FAILED" = "SENT";
    let error: string | undefined;

    try {
      if (!env.resendApiKey) {
        throw new Error("RESEND_API_KEY is not configured.");
      }

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: `${env.emailFromName} <${env.emailFromAddress}>`,
          to: [message.to.email],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Resend responded ${response.status}: ${await response.text()}`);
      }
    } catch (caught) {
      status = "FAILED";
      error = caught instanceof Error ? caught.message : String(caught);
    }

    const row = await prisma.emailMessage.create({
      data: {
        provider: this.info.id,
        kind: message.kind,
        toEmail: message.to.email,
        toName: message.to.name,
        subject: message.subject,
        html: message.html,
        text: message.text,
        linkUrl: message.linkUrl ?? null,
        campaignId: message.campaignId ?? null,
        contactId: message.contactId ?? null,
        status,
        error: error ?? null,
      },
    });

    return { id: row.id, status, error };
  }
}
