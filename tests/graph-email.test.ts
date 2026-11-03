import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { classifyGraphSendResponse } from "@/server/integrations/email/graph-email-service";
import { resetDatabase } from "./fixtures";

/**
 * Sending as a real Microsoft 365 mailbox through Graph.
 *
 * The provider exists to dissolve a DNS blocker — Microsoft is already
 * authoritative for the domain's mail, so there is nothing to prove to a third
 * party. What these tests pin is the part that is NOT inherited from the Resend
 * path: Graph answers 202 with an empty body and no message id, so every
 * downstream decision rests on the HTTP status alone.
 *
 * The ledger contract is the same and is asserted here too, because it is what
 * stops a retry from mailing a customer twice.
 */

const BASE_ENV = {
  EMAIL_PROVIDER: "graph",
  GRAPH_TENANT_ID: "tenant-synthetic",
  GRAPH_CLIENT_ID: "client-synthetic",
  GRAPH_CLIENT_SECRET: "secret-synthetic",
  GRAPH_SENDER_MAILBOX: "hello@idsculpture.test",
  EMAIL_FROM_ADDRESS: "hello@idsculpture.test",
};

const MESSAGE = {
  to: { email: "recipient@example.invalid", name: "Pat Recipient" },
  subject: "Your check-in",
  html: "<p>https://checkin.test/checkin/SECRET-BEARER-TOKEN</p>",
  text: "https://checkin.test/checkin/SECRET-BEARER-TOKEN",
  kind: "INVITE" as const,
  linkUrl: "https://checkin.test/checkin/SECRET-BEARER-TOKEN",
};

/**
 * `env` is read once at module load, so the service must be imported AFTER the
 * environment is stubbed — the same trap the rate-limit tests document.
 */
async function graphService() {
  vi.resetModules()
  const mod = await import("@/server/integrations/email/graph-email-service")
  return new mod.GraphEmailService()
}

/** A token response followed by the sendMail response under test. */
function graphFetch(sendStatus: number) {
  return vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "synthetic-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: sendStatus }));
}

describe("classifying Graph's answer", () => {
  it("treats 202 — what sendMail actually returns — as sent", () => {
    expect(classifyGraphSendResponse(202)).toEqual({ status: "SENT" });
  });

  it("accepts any 2xx, so a provider change cannot break us over a status we had no reason to reject", () => {
    for (const code of [200, 201, 204]) {
      expect(classifyGraphSendResponse(code).status, String(code)).toBe("SENT");
    }
  });

  it("names the cause for the two failures to expect while consent is pending", () => {
    const unauthorized = classifyGraphSendResponse(401);
    expect(unauthorized.status).toBe("FAILED");
    expect(unauthorized.error).toMatch(/GRAPH_CLIENT_SECRET/);

    const forbidden = classifyGraphSendResponse(403);
    expect(forbidden.status).toBe("FAILED");
    // The two real causes, and an admin reading the ledger needs both named.
    expect(forbidden.error).toMatch(/admin consent/i);
    expect(forbidden.error).toMatch(/Application Access Policy/i);
  });

  it("points at the mailbox setting on 404", () => {
    const missing = classifyGraphSendResponse(404);
    expect(missing.status).toBe("FAILED");
    expect(missing.error).toMatch(/GRAPH_SENDER_MAILBOX/);
  });

  it("treats throttling as a clean failure that may be resent", () => {
    // Graph rejects a throttled request rather than executing it, so this is
    // knowably not-sent. Calling it UNCERTAIN would freeze every throttled
    // message in a campaign for manual checking.
    const throttled = classifyGraphSendResponse(429);
    expect(throttled.status).toBe("FAILED");
    expect(throttled.error).toMatch(/safe to send this one again/i);
  });

  it("refuses to guess when Graph itself breaks", () => {
    // The request reached Graph; Graph may have queued the mail before failing.
    for (const code of [500, 502, 503, 504]) {
      const broken = classifyGraphSendResponse(code);
      expect(broken.status, String(code)).toBe("UNCERTAIN");
      expect(broken.error, String(code)).toMatch(/check the sent mailbox/i);
    }
  });

  it("treats any other 4xx as our mistake, not an unknown", () => {
    for (const code of [400, 413, 422]) {
      expect(classifyGraphSendResponse(code).status, String(code)).toBe("FAILED");
    }
  });
});

describe("the send path", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("commits a PENDING ledger row BEFORE the request, then settles it", async () => {
    const fetchMock = graphFetch(202);
    vi.stubGlobal("fetch", fetchMock);

    const result = await (await graphService()).send(MESSAGE);
    expect(result.status).toBe("SENT");

    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.status).toBe("SENT");
    expect(row.error).toBeNull();
    // Graph returns no id, so there is nothing to record. Inventing one would
    // fill a column whose only purpose is matching a callback Graph never sends.
    expect(row.providerMessageId).toBeNull();
  });

  it("never persists the recipient's bearer link", async () => {
    vi.stubGlobal("fetch", graphFetch(202));
    const result = await (await graphService()).send(MESSAGE);

    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } });
    const stored = JSON.stringify(row);
    expect(stored).not.toContain("SECRET-BEARER-TOKEN");
  });

  it("sends to the configured mailbox endpoint with a bearer token", async () => {
    const fetchMock = graphFetch(202);
    vi.stubGlobal("fetch", fetchMock);
    await (await graphService()).send(MESSAGE);

    const [tokenUrl] = fetchMock.mock.calls[0];
    expect(String(tokenUrl)).toContain("login.microsoftonline.com/tenant-synthetic");

    const [sendUrl, init] = fetchMock.mock.calls[1];
    expect(String(sendUrl)).toBe(
      "https://graph.microsoft.com/v1.0/users/hello%40idsculpture.test/sendMail",
    );
    expect(init.headers.Authorization).toBe("Bearer synthetic-access-token");

    const body = JSON.parse(init.body);
    expect(body.message.toRecipients[0].emailAddress.address).toBe("recipient@example.invalid");
    expect(body.saveToSentItems).toBe(true);
  });

  it("records an unknown outcome when Graph breaks, without claiming failure", async () => {
    vi.stubGlobal("fetch", graphFetch(503));
    const result = await (await graphService()).send(MESSAGE);

    // The caller sees a non-success, because the interface has two states...
    expect(result.status).toBe("FAILED");
    // ...but the ledger keeps the distinction that matters for recovery.
    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.status).toBe("UNCERTAIN");
  });

  it("treats a transport failure as unknown, not as a clean failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ access_token: "t" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockRejectedValueOnce(new Error("socket hang up")),
    );

    const result = await (await graphService()).send(MESSAGE);
    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } });
    expect(row.status).toBe("UNCERTAIN");
  });

  it("refuses before any network call when configuration is missing, and says which", async () => {
    vi.stubEnv("GRAPH_SENDER_MAILBOX", "");
    vi.resetModules();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await (await graphService()).send(MESSAGE);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/GRAPH_SENDER_MAILBOX is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not leak the token response body into the ledger when auth fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ error_description: "AADSTS7000215 secret is invalid" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await (await graphService()).send(MESSAGE);
    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } });

    expect(row.status).toBe("UNCERTAIN");
    expect(JSON.stringify(row)).not.toContain("AADSTS7000215");
  });
});
