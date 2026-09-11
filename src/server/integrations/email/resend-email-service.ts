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
      error = redactKey(caught instanceof Error ? caught.message : String(caught));
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

/**
 * Provider errors are shown in the admin UI and stored on the outbox row, so
 * they must never carry the API key.
 *
 * A malformed key is the case that matters: fetch rejects the Authorization
 * header and puts its ENTIRE value — the key — into the exception message,
 * which would otherwise be rendered on screen and written to the database.
 */
function redactKey(message: string): string {
  const key = env.resendApiKey;
  let safe = key ? message.split(key).join("[redacted]") : message;
  // Belt and braces: drop any bearer credential the provider echoes back,
  // whatever its shape.
  safe = safe.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  // A rejected header can embed the whole value in quotes rather than after
  // "Bearer", so an over-long single-line message is truncated rather than
  // surfaced verbatim.
  return safe.length > 300 ? `${safe.slice(0, 300)}…` : safe;
}
