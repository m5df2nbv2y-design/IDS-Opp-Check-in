import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { liveEmailRefusal } from "@/lib/deployment-environment";
import { env } from "@/lib/env";
import { recordOutboundEmail } from "./outbox";
import type { EmailProviderInfo, EmailSendResult, EmailService, OutboundEmail } from "./types";

/**
 * Sending as a real Microsoft 365 mailbox, through Graph.
 *
 * WHY THIS EXISTS. The Resend path was blocked on DNS: proving control of
 * idsculpture.com means adding DKIM and CNAME records to an Azure zone nobody
 * could reach. Graph needs no such proof, because Microsoft is already
 * authoritative for that domain's mail — we authenticate as the tenant that
 * owns the mailbox instead of proving ownership to a third party.
 *
 * It also fixes replies by construction. Sending AS hello@idsculpture.com means
 * a customer's reply lands in that existing mailbox with no Reply-To
 * indirection and no MX change. The app still implements no inbound reader;
 * it no longer needs to pretend otherwise.
 *
 * WHAT IT GIVES UP. Graph has no delivery-event webhook for mail you send.
 * There is no delivered/bounced/complained callback — a bounce returns as an
 * NDR message INTO the sending mailbox, which only a mailbox reader would see.
 * So `deliveredAt` does not populate on this path, and that is a deliberate,
 * known trade rather than an oversight.
 *
 * The ledger discipline is identical to the Resend path and deliberately so:
 * a redacted PENDING row is committed BEFORE the request, the request key is a
 * digest that never persists the bearer link, and an unknown outcome is never
 * replayed automatically.
 */
export class GraphEmailService implements EmailService {
  readonly info: EmailProviderInfo = { id: "graph", label: "Microsoft Graph", simulated: false };

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    const refusal = liveEmailRefusal({ ...process.env, EMAIL_PROVIDER: "graph" });
    if (refusal) throw new Error(refusal);

    const payload = JSON.stringify({
      message: {
        subject: message.subject,
        body: { contentType: "HTML", content: message.html },
        toRecipients: [{ emailAddress: { address: message.to.email, name: message.to.name } }],
        ...(env.emailReplyTo
          ? { replyTo: [{ emailAddress: { address: env.emailReplyTo } }] }
          : {}),
      },
      // Keep a copy in the mailbox: it is the only place a human can later see
      // what was actually sent, since we redact the link from our own row.
      saveToSentItems: true,
    });

    // Same contract as the Resend path: identical concurrent calls collapse
    // onto one durable row, and the digest never persists the bearer link.
    const requestKey = createHash("sha256").update(payload).digest("hex");

    let row;
    try {
      row = await recordOutboundEmail({ message, info: this.info, status: "PENDING", requestKey });
    } catch (caught) {
      const existing = await prisma.emailMessage.findUnique({ where: { requestKey } });
      if (!existing) throw caught;
      return {
        id: existing.id,
        status: existing.status === "SENT" ? "SENT" : "FAILED",
        error:
          existing.status === "SENT"
            ? undefined
            : existing.error ??
              "This send is already recorded. Verify its status before sending again.",
      };
    }

    let status: "SENT" | "FAILED" | "UNCERTAIN" = "FAILED";
    let error: string | undefined;

    const missing = this.missingConfiguration();
    if (missing) {
      error = `${missing} is not configured.`;
    } else {
      try {
        const token = await this.accessToken();
        const response = await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.graph.senderMailbox)}/sendMail`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: payload,
            signal: AbortSignal.timeout(15_000),
          },
        );

        const outcome = classifyGraphSendResponse(response.status);
        status = outcome.status;
        // Never persist provider bodies: a Graph error payload can echo the
        // request, and the request contains the recipient's bearer link.
        error = outcome.error;
      } catch {
        // A timeout or transport failure after the request left us. Graph may
        // have accepted it, so this is not a clean failure.
        status = "UNCERTAIN";
        error = "Email acceptance could not be confirmed. Check the sent mailbox before sending again.";
      }
    }

    /**
     * No providerMessageId is stored. Graph's sendMail answers 202 with an
     * empty body and no id — there is nothing to record, and inventing one
     * would put a value in a column whose whole purpose is to match a provider
     * callback that this provider never sends.
     */
    await prisma.emailMessage.update({ where: { id: row.id }, data: { status, error } });

    return { id: row.id, status: status === "SENT" ? "SENT" : "FAILED", error };
  }

  /** Named so the ledger error says which value is absent, without printing any. */
  private missingConfiguration(): string | null {
    if (!env.graph.tenantId) return "GRAPH_TENANT_ID";
    if (!env.graph.clientId) return "GRAPH_CLIENT_ID";
    if (!env.graph.clientSecret) return "GRAPH_CLIENT_SECRET";
    if (!env.graph.senderMailbox) return "GRAPH_SENDER_MAILBOX";
    return null;
  }

  /**
   * App-only client credentials.
   *
   * Deliberately not cached: a cache would need invalidation on tenant or
   * secret rotation, and the send path is already dominated by the send itself.
   * Correctness first; cache later if measurement says it matters.
   */
  private async accessToken(): Promise<string> {
    const response = await fetch(
      `https://login.microsoftonline.com/${encodeURIComponent(env.graph.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.graph.clientId,
          client_secret: env.graph.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      // The body carries AADSTS detail that can name the tenant and app; the
      // status alone is enough to act on.
      throw new Error(`Microsoft token request failed with HTTP ${response.status}.`);
    }

    const data: unknown = await response.json();
    if (
      typeof data !== "object" ||
      !data ||
      !("access_token" in data) ||
      typeof data.access_token !== "string" ||
      !data.access_token
    ) {
      throw new Error("Microsoft token response contained no access token.");
    }
    return data.access_token;
  }
}

/**
 * Turn Graph's HTTP status into a ledger outcome.
 *
 * This is the judgement call of the whole provider, because Graph does not
 * answer the way Resend does. Resend returns 200 with a message id — a receipt.
 * Graph's sendMail returns **202 Accepted with an empty body and no id**: it has
 * taken responsibility for delivery, but has told you nothing you can later use
 * to look the message up.
 *
 * The three states mean specific things to everything downstream:
 *   SENT      — terminal success. The recipient row is marked sent, and nothing
 *               will try again.
 *   FAILED    — terminal, and safe to retry deliberately: we know Graph did NOT
 *               take it.
 *   UNCERTAIN — Graph may or may not have accepted. Never retried
 *               automatically, because a retry risks a duplicate customer email.
 *               It requires a human to check the sent mailbox.
 */
export function classifyGraphSendResponse(
  httpStatus: number,
): { status: "SENT" | "FAILED" | "UNCERTAIN"; error?: string } {
  // 202 is what sendMail actually returns. Accepting any 2xx costs nothing and
  // avoids a provider change breaking us over a status we had no reason to
  // reject.
  if (httpStatus >= 200 && httpStatus < 300) return { status: "SENT" };

  // The two failures to expect while consent is still pending. Both are
  // terminal — retrying changes nothing until someone changes the tenant —
  // so they are FAILED rather than UNCERTAIN, and the message names the fix.
  if (httpStatus === 401) {
    return {
      status: "FAILED",
      error:
        "Microsoft rejected the credentials (HTTP 401). Check GRAPH_CLIENT_SECRET and that " +
        "GRAPH_TENANT_ID and GRAPH_CLIENT_ID belong to the same app registration.",
    };
  }
  if (httpStatus === 403) {
    return {
      status: "FAILED",
      error:
        "Microsoft refused the send (HTTP 403). Either admin consent for Mail.Send has not been " +
        "granted, or the Exchange Application Access Policy does not include this mailbox.",
    };
  }
  if (httpStatus === 404) {
    return {
      status: "FAILED",
      error:
        "Microsoft could not find the sending mailbox (HTTP 404). Check GRAPH_SENDER_MAILBOX.",
    };
  }

  /**
   * Throttling. Graph rejects a throttled request rather than executing it and
   * reporting back, so this is a clean failure that a person can deliberately
   * resend — which is exactly what FAILED means here.
   *
   * It is tempting to call this UNCERTAIN on the "never risk a duplicate"
   * principle, but that would freeze every throttled message in a campaign for
   * manual checking, and throttling is the one failure we should expect at
   * volume. Treating a documented rejection as unknown would make UNCERTAIN
   * routine, and a state that occurs routinely stops being investigated.
   */
  if (httpStatus === 429) {
    return {
      status: "FAILED",
      error:
        "Microsoft throttled the send (HTTP 429) and did not accept the message. " +
        "It is safe to send this one again.",
    };
  }

  // The request reached Graph and Graph broke. It may have queued the mail
  // before failing, so we do not know — and must not guess, because the cost
  // of guessing wrong is a duplicate email to a customer.
  if (httpStatus >= 500) {
    return {
      status: "UNCERTAIN",
      error:
        `Microsoft returned HTTP ${httpStatus} and the outcome is unknown. ` +
        "Check the sent mailbox before sending this again.",
    };
  }

  // Any other 4xx is our mistake: a malformed payload or an invalid address.
  return {
    status: "FAILED",
    error: `Microsoft rejected the request (HTTP ${httpStatus}). The message was not sent.`,
  };
}
