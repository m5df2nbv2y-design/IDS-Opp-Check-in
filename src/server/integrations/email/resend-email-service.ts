import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { liveEmailRefusal } from "@/lib/deployment-environment";
import { env } from "@/lib/env";
import { recordOutboundEmail } from "./outbox";
import type { EmailProviderInfo, EmailSendResult, EmailService, OutboundEmail } from "./types";

/** Durable, redacted send ledger. Unknown outcomes require provider reconciliation. */
export class ResendEmailService implements EmailService {
  readonly info: EmailProviderInfo = { id: "resend", label: "Resend", simulated: false };

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    const refusal = liveEmailRefusal({ ...process.env, EMAIL_PROVIDER: "resend" });
    if (refusal) throw new Error(refusal);
    const payload = JSON.stringify({
      from: `${env.emailFromName} <${env.emailFromAddress}>`,
      to: [message.to.email], subject: message.subject, html: message.html, text: message.text,
      ...(env.emailReplyTo ? { reply_to: env.emailReplyTo } : {}),
    });
    // The digest does not persist the bearer link. Identical concurrent calls
    // share one durable row; never replay an uncertain send automatically.
    const requestKey = createHash("sha256").update(payload).digest("hex");
    let row;
    try {
      row = await recordOutboundEmail({ message, info: this.info, status: "PENDING", requestKey });
    } catch (caught) {
      const existing = await prisma.emailMessage.findUnique({ where: { requestKey } });
      if (!existing) throw caught;
      return { id: existing.id, status: existing.status === "SENT" ? "SENT" : "FAILED",
        error: existing.status === "SENT" ? undefined : existing.error ?? "This send is already recorded. Verify its status before sending again." };
    }
    let status: "SENT" | "FAILED" | "UNCERTAIN" = "FAILED";
    let error: string | undefined;
    let providerMessageId: string | undefined;
    if (!env.resendApiKey) {
      error = "RESEND_API_KEY is not configured.";
    } else {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST", headers: { Authorization: `Bearer ${env.resendApiKey}`,
            "Content-Type": "application/json", "Idempotency-Key": requestKey },
          body: payload, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          status = response.status >= 500 ? "UNCERTAIN" : "FAILED";
          // Never persist provider bodies: they may echo tokens or credentials.
          error = `Resend returned HTTP ${response.status}. ${status === "UNCERTAIN" ? "Check Resend before sending again." : "The request was rejected."}`;
        } else {
          const data: unknown = await response.json();
          if (typeof data !== "object" || !data || !("id" in data) || typeof data.id !== "string" || !data.id) throw new Error("Missing provider receipt");
          providerMessageId = data.id;
          status = "SENT";
        }
      } catch {
        status = "UNCERTAIN";
        error = "Email acceptance could not be confirmed. Check Resend before sending again.";
      }
    }
    await prisma.emailMessage.update({ where: { id: row.id }, data: { status, error, providerMessageId } });
    return { id: row.id, status: status === "SENT" ? "SENT" : "FAILED", error };
  }
}
