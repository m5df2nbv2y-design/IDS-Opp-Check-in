import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { liveEmailRefusal } from "@/lib/deployment-environment";
import { env } from "@/lib/env";
import { recordOutboundEmail } from "./outbox";
import type { EmailProviderInfo, EmailSendResult, EmailService, OutboundEmail } from "./types";

const UNCONFIRMED = "Email acceptance could not be confirmed. Check the sent mailbox before sending again.";
const NOT_RECORDED = "Email acceptance could not be recorded. Check the sent mailbox before sending again.";
const DUPLICATE_FAILED =
  "This send was already attempted and was not accepted. An identical retry is refused as a duplicate, " +
  "so a resend needs a new send (a reminder issues a new link).";

/**
 * Sending as a real Microsoft 365 mailbox, through Graph.
 *
 * WHY THIS EXISTS. The Resend path was blocked on DNS: proving control of
 * idsculpture.com means adding DKIM and CNAME records to an Azure zone nobody
 * could reach. Graph does not need Resend's DNS proof. Sender-domain
 * authentication is a Microsoft 365 tenant matter to confirm with IT.
 *
 * Replies. The message is sent as GRAPH_SENDER_MAILBOX and the payload sets no
 * `from`. Without EMAIL_REPLY_TO a customer's reply goes to that mailbox; when
 * EMAIL_REPLY_TO is set the payload adds it as Reply-To and replies go there.
 * The app still implements no inbound reader.
 *
 * WHAT IT GIVES UP. Graph has no delivery-event webhook for mail you send.
 * There is no delivered/bounced/complained callback — a bounce returns as an
 * NDR message INTO the sending mailbox, which only a mailbox reader would see.
 * So `deliveredAt` does not populate on this path, and that is a deliberate,
 * known trade rather than an oversight.
 *
 * SENT ITEMS. saveToSentItems is requested, so the sending mailbox keeps the
 * complete message, including the live check-in link; our own ledger row has the
 * link redacted. Who may read that mailbox, and how long it retains the message,
 * are for IT to settle.
 *
 * The ledger discipline is identical to the Resend path and deliberately so:
 * a redacted PENDING row is committed BEFORE the request, the request key is a
 * digest that never persists the bearer link, and an unknown outcome is never
 * replayed automatically. If the initial PENDING row cannot be written and no
 * row exists for the request, send rethrows; callers read a thrown send as an
 * unknown send.
 *
 * THE THREE OUTCOMES REACH THE CALLER UNCHANGED. Launch and reminders treat
 * FAILED as "definitely not accepted", so FAILED is returned only where no
 * sendMail request could have left (a deployment refusal, missing configuration,
 * or any failure to obtain a token) or Graph documented a rejection (a 4xx).
 * Once the sendMail request may have left without a definite answer, a 5xx,
 * 408, 1xx, unfollowed 3xx, timeout or transport failure is UNCERTAIN, and so is
 * a stored PENDING/UNCERTAIN row for the same request.
 *
 * FAILED does not mean an identical call may go again: a stored FAILED row is
 * returned as FAILED with no request, so a resend needs a new send (a reminder
 * issues a new link).
 *
 * Every error is a fixed string built from this file's constants and an HTTP
 * status number. Provider bodies, thrown text, tokens, links and configured
 * values are never returned, stored or audited — a Graph error body can echo the
 * request, and the request carries the recipient's bearer link.
 */
export class GraphEmailService implements EmailService {
  readonly info: EmailProviderInfo = { id: "graph", label: "Microsoft Graph", simulated: false };

  async send(message: OutboundEmail): Promise<EmailSendResult> {
    const refusal = liveEmailRefusal({ ...process.env, EMAIL_PROVIDER: "graph" });
    // Returned, not thrown: nothing has left, so this is a definite FAILED. A
    // throw is read by callers as an unknown send.
    if (refusal) return { id: "", status: "FAILED", error: refusal };

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
      // Fixed text, never the stored text. PENDING means another call is in
      // flight or was interrupted: unknown, exactly like UNCERTAIN.
      return existing.status === "SENT"
        ? { id: existing.id, status: "SENT" }
        : existing.status === "FAILED"
          ? { id: existing.id, status: "FAILED", error: DUPLICATE_FAILED }
          : { id: existing.id, status: "UNCERTAIN", error: UNCONFIRMED };
    }

    const outcome = await this.attempt(payload);

    /**
     * No providerMessageId is stored. Graph's sendMail answers 202 with an
     * empty body and no id — there is nothing to record, and inventing one
     * would put a value in a column whose whole purpose is to match a provider
     * callback that this provider never sends.
     */
    try {
      await prisma.emailMessage.update({ where: { id: row.id }, data: { status: outcome.status, error: outcome.error } });
    } catch {
      // The row is still PENDING, and that is what blocks a replay. Report the
      // state the ledger is actually in; never SENT or FAILED, and never throw.
      return { id: row.id, status: "UNCERTAIN", error: NOT_RECORDED };
    }

    return { id: row.id, ...outcome };
  }

  /** Everything between the PENDING row and the ledger update. Never throws. */
  private async attempt(payload: string): Promise<Pick<EmailSendResult, "status" | "error">> {
    const missing = this.missingConfiguration();
    if (missing) return { status: "FAILED", error: `${missing} is not configured.` };

    // Token stage: no sendMail request exists yet, so any failure here is a
    // definite FAILED.
    const token = await this.accessToken();
    if ("error" in token) return { status: "FAILED", error: token.error };

    try {
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.graph.senderMailbox)}/sendMail`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(15_000),
        },
      );
      // Never persist provider bodies: a Graph error payload can echo the
      // request, and the request contains the recipient's bearer link.
      return classifyGraphSendResponse(response.status);
    } catch {
      // A timeout or transport failure after the request left us. Graph may
      // have accepted it, so this is not a clean failure.
      return { status: "UNCERTAIN", error: UNCONFIRMED };
    }
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
   *
   * Returns a fixed error instead of throwing. The token body carries AADSTS
   * detail that can name the tenant and app, and a thrown transport error can
   * carry anything, so neither is ever read into a message: the HTTP status
   * alone is enough to act on.
   */
  private async accessToken(): Promise<{ value: string } | { error: string }> {
    let response: Response;
    try {
      response = await fetch(
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
    } catch {
      return { error: "Microsoft token request did not complete. No email was sent." };
    }

    if (!response.ok) {
      return { error: `Microsoft token request failed (HTTP ${response.status}). No email was sent.` };
    }

    try {
      const data: unknown = await response.json();
      if (typeof data === "object" && data && "access_token" in data && typeof data.access_token === "string" && data.access_token) {
        return { value: data.access_token };
      }
    } catch {
      // Falls through to the same fixed message as a body without a token.
    }
    return { error: "Microsoft token response contained no access token. No email was sent." };
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
 *   FAILED    — terminal: we know Graph did NOT take it. An identical retry is
 *               refused as a duplicate, so a resend needs a new send.
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
        "Microsoft refused the send (HTTP 403). Check that admin consent for Mail.Send has been " +
        "granted and that the mailbox scoping applied to this app includes this mailbox.",
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
   * reporting back, so this is a clean failure: the message was not accepted.
   * An identical retry is refused as a duplicate, so a resend needs a new send.
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
        "An identical retry is refused as a duplicate, so a resend needs a new send (a reminder issues a new link).",
    };
  }

  // Any other 4xx is our mistake: a malformed payload or an invalid address.
  // 408 is the exception: a request timeout says nothing about whether Graph
  // had already begun to process the send.
  if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
    return {
      status: "FAILED",
      error: `Microsoft rejected the request (HTTP ${httpStatus}). The message was not sent.`,
    };
  }

  // Everything else reached Graph without a definite answer: a 5xx, 408, a 1xx,
  // an unfollowed 3xx, anything unrecognised. Graph may have queued the mail, so
  // we do not know — and must not guess, because the cost of guessing wrong is a
  // duplicate email to a customer.
  return {
    status: "UNCERTAIN",
    error:
      `Microsoft returned HTTP ${httpStatus} and the outcome is unknown. ` +
      "Check the sent mailbox before sending this again.",
  };
}
