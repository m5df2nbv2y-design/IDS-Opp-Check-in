import { createHash, randomUUID } from "node:crypto";
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
    let idempotencyKey = requestKey;
    try {
      row = await recordOutboundEmail({ message, info: this.info, status: "PENDING", requestKey });
    } catch (caught) {
      const existing = await prisma.emailMessage.findUnique({ where: { requestKey } });
      if (!existing) throw caught;
      // A definite rejection (including a missing API key) sent nothing, so it may
      // be retried; the conditional update is the claim, so only one caller retries.
      const reclaimed = existing.status === "FAILED"
        && (await prisma.emailMessage.updateMany({ where: { id: existing.id, status: "FAILED" }, data: { status: "PENDING", error: null } })).count === 1;
      if (!reclaimed) {
        // Re-read: a concurrent retry may have won the claim and settled it. A lost
        // FAILED claim means a retry is in flight, so its old rejection text is stale.
        const current = existing.status === "FAILED" ? await prisma.emailMessage.findUnique({ where: { id: existing.id } }) : existing;
        if (current?.status === "SENT") return { id: existing.id, status: "SENT" };
        return { id: existing.id, status: "UNCERTAIN",
          error: existing.status === "FAILED" ? "A retry of this send is in progress. Verify its status before sending again."
            : existing.error ?? "This send is already recorded. Verify its status before sending again." };
      }
      row = existing;
      // A fresh key, so Resend cannot replay its rejection of the first attempt.
      idempotencyKey = `${requestKey}-${randomUUID()}`;
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
            "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body: payload, signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          // 408 and 409 (request timeout, idempotent request in progress) do not
          // prove nothing was sent, and a FAILED row may be retried, so they are unknown.
          status = response.status >= 500 || response.status === 408 || response.status === 409 ? "UNCERTAIN" : "FAILED";
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
    return { id: row.id, status, error };
  }
}
