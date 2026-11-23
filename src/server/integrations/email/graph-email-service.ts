import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { liveEmailRefusal } from "@/lib/deployment-environment";
import { env, missingGraphSettingNames } from "@/lib/env";
import { recordOutboundEmail } from "./outbox";
import type { EmailProviderInfo, EmailSendResult, EmailService, OutboundEmail } from "./types";

const UNCONFIRMED = "Email acceptance could not be confirmed. Check the sent mailbox before sending again.";
const NOT_RECORDED = "Email acceptance could not be recorded. Check the sent mailbox before sending again.";

/**
 * One cached app-only token per instance, held until five minutes before
 * Microsoft's stated expiry and dropped when sendMail answers 401 or 403 (a
 * rejected or under-consented token). GRAPH_* values are read once at startup,
 * so rotated credentials arrive with a new instance, which starts empty.
 * shortcut: concurrent sends on an empty cache each fetch a token; launches send
 * one at a time, so share one pending request only if sends become parallel.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

/** Graph's Retry-After in seconds, capped so a launch loop stays inside the function time limit. */
const retryAfterMs = (header: string | null): number => {
  const seconds = header === null ? NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 10) * 1000 : 1000;
};
const TOKEN_MARGIN_MS = 5 * 60_000;

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
 * FAILED means nothing went out, so an identical call may go again: the stored
 * FAILED row is reclaimed as PENDING (one caller wins) and the send is retried.
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
    // Before the ledger row, so a missing value does not consume the request
    // identity and a corrected retry of the same message can still send.
    const missing = this.missingConfiguration();
    if (missing) return { id: "", status: "FAILED", error: `${missing} is not configured.` };

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
      // A definite rejection sent nothing, so it may be retried. The conditional
      // update is the claim: only one concurrent caller turns FAILED into PENDING.
      const reclaimed = existing.status === "FAILED"
        ? (await prisma.emailMessage.updateMany({ where: { id: existing.id, status: "FAILED" }, data: { status: "PENDING", error: null } })).count === 1
        : false;
      if (!reclaimed) {
        // Re-read: a concurrent retry may have won the claim and settled it.
        // Fixed text, never the stored text. PENDING means another call is in
        // flight or was interrupted: unknown, exactly like UNCERTAIN.
        const current = existing.status === "FAILED" ? await prisma.emailMessage.findUnique({ where: { id: existing.id } }) : existing;
        return current?.status === "SENT"
          ? { id: existing.id, status: "SENT" }
          : { id: existing.id, status: "UNCERTAIN", error: UNCONFIRMED };
      }
      row = existing;
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
      // The update failed, but the commit may still have landed with a lost
      // acknowledgment, so the row's state is not known here. Either way a repeat
      // makes no network call: PENDING or a stored status returns UNCERTAIN or
      // that status. Report UNCERTAIN, never SENT or FAILED, and never throw.
      return { id: row.id, status: "UNCERTAIN", error: NOT_RECORDED };
    }

    return { id: row.id, ...outcome };
  }

  /** Everything between the PENDING row and the ledger update. Never throws. */
  private async attempt(payload: string): Promise<Pick<EmailSendResult, "status" | "error">> {
    // Token stage: no sendMail request exists yet, so any failure here is a
    // definite FAILED.
    const token = await this.accessToken();
    if ("error" in token) return { status: "FAILED", error: token.error };

    try {
      const sendMail = () => fetch(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.graph.senderMailbox)}/sendMail`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/json" },
          body: payload,
          // A redirect must be classified, not followed: it could turn the POST into a GET or forward the message and bearer link.
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        },
      );
      let response = await sendMail();
      // 429 means Graph did not take the message, so one paced retry cannot
      // duplicate it; without it a throttled invitation is lost for good.
      if (response.status === 429) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs(response.headers.get("retry-after"))));
        response = await sendMail();
      }
      // Never persist provider bodies: a Graph error payload can echo the
      // request, and the request contains the recipient's bearer link.
      // A rejected or under-consented token must not be reused for the rest of a
      // launch (it costs this one send; the next fetches a fresh token).
      if (response.status === 401 || response.status === 403) cachedToken = null;
      return classifyGraphSendResponse(response.status);
    } catch {
      // A timeout or transport failure after the request left us. Graph may
      // have accepted it, so this is not a clean failure.
      return { status: "UNCERTAIN", error: UNCONFIRMED };
    }
  }

  /**
   * Readiness without sending: settings present, an app token issued, and which
   * application roles it carries. Works while EMAIL_PROVIDER is still mock.
   * `mailSend` means a TENANT-WIDE Entra grant (any mailbox). Its absence is
   * expected when IT scopes Mail.Send with Exchange RBAC for Applications, which
   * puts the permission in Exchange, not the token. Only the internal test send
   * proves the app can send as the mailbox.
   */
  async checkReadiness(): Promise<GraphReadiness> {
    const result: GraphReadiness = {
      missing: missingGraphSettingNames(env.graph),
      mailbox: env.graph.senderMailbox,
      roles: [],
      mailSend: false,
    };
    if (liveEmailRefusal({ ...process.env, EMAIL_PROVIDER: "graph" })) {
      return { ...result, error: "The Graph readiness check runs only in Production." };
    }
    if (result.missing.length) return result;
    // Always a fresh token: a cached one predates any consent IT granted since.
    cachedToken = null;
    const token = await this.accessToken();
    if ("error" in token) return { ...result, error: token.error };
    const roles = tokenRoles(token.value);
    return { ...result, roles, mailSend: roles.includes("Mail.Send") };
  }

  /** Named so the ledger error says which value is absent, without printing any. */
  private missingConfiguration(): string | null {
    return missingGraphSettingNames(env.graph)[0] ?? null;
  }

  /**
   * App-only client credentials.
   *
   * Cached (see `cachedToken`): fetching one per send doubled the external calls
   * in a launch loop bounded by the function time limit (PR #13 finding 8).
   *
   * Returns a fixed error instead of throwing. The token body carries AADSTS
   * detail that can name the tenant and app, and a thrown transport error can
   * carry anything, so neither is ever read into a message: the HTTP status
   * alone is enough to act on.
   */
  private async accessToken(): Promise<{ value: string } | { error: string }> {
    if (cachedToken && Date.now() < cachedToken.expiresAt) return { value: cachedToken.value };
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
          // Never forward the client secret to a redirect target; a 3xx takes the non-ok path below.
          redirect: "manual",
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
        // Cache only with a stated lifetime longer than the safety margin.
        const lifetimeMs = "expires_in" in data && typeof data.expires_in === "number" ? data.expires_in * 1000 : 0;
        cachedToken = lifetimeMs > TOKEN_MARGIN_MS ? { value: data.access_token, expiresAt: Date.now() + lifetimeMs - TOKEN_MARGIN_MS } : null;
        return { value: data.access_token };
      }
    } catch {
      // Falls through to the same fixed message as a body without a token.
    }
    return { error: "Microsoft token response contained no access token. No email was sent." };
  }
}

export type GraphReadiness = {
  /** Labels of absent Graph settings, naming any fallback; values are never returned. */
  missing: string[];
  mailbox: string;
  /** Application roles on our own app token (e.g. Mail.Send). */
  roles: string[];
  mailSend: boolean;
  /** A fixed message: not Production, or why no token was issued (HTTP status, transport, empty response). */
  error?: string;
};

/** The `roles` claim of our own access token. Read only, never verified: it came straight from Microsoft. */
function tokenRoles(accessToken: string): string[] {
  try {
    const claims: unknown = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    const roles = typeof claims === "object" && claims && "roles" in claims ? claims.roles : [];
    return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
  } catch {
    return [];
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
 *   FAILED    — we know Graph did NOT take it. An identical call later retries
 *               it on the same ledger row.
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
        "Microsoft rejected the credentials (HTTP 401). Check the client secret " +
        "(AUTH_MICROSOFT_ENTRA_ID_SECRET, or its GRAPH_CLIENT_SECRET override) and that the tenant " +
        "(in AUTH_MICROSOFT_ENTRA_ID_ISSUER, or GRAPH_TENANT_ID) and client id " +
        "(AUTH_MICROSOFT_ENTRA_ID_ID, or GRAPH_CLIENT_ID) belong to the same app registration.",
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
   * An identical call later may retry it.
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
        "Microsoft throttled the send (HTTP 429) and did not accept the message. Nothing was sent.",
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
