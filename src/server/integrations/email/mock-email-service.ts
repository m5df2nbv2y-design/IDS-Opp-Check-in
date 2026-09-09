import { prisma } from "@/lib/db";
import type { EmailProviderInfo, EmailSendResult, EmailService, OutboundEmail } from "./types";

/**
 * Development / demo email provider.
 *
 * Nothing leaves the building: every message is written to the outbox table and
 * logged. `/admin/outbox` renders those messages exactly as the rep would see
 * them, with a working check-in button — which is how the demo shows the
 * end-to-end flow without a mailbox.
 */
export class MockEmailService implements EmailService {
  readonly info: EmailProviderInfo = {
    id: "mock",
    label: "Simulated outbox",
    simulated: true,
  };

  async send(message: OutboundEmail): Promise<EmailSendResult> {
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
        status: "SENT",
      },
    });

    console.log(`[email:mock] → ${message.to.email} — ${message.subject}`);
    return { id: row.id, status: "SENT" };
  }
}
