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
 * stops a retry from mailing a customer twice. The adapter must hand callers the
 * TRUE outcome: launch and reminders treat FAILED as definitely not accepted,
 * so an unknown send reported as FAILED is a duplicate customer email waiting to
 * happen. No test here touches the network; `fetch` is always stubbed.
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

/** Everything a provider body, a thrown error or a config value could echo back. Nothing here may be returned or stored. */
const LEAKS = [
  "SECRET-BEARER-TOKEN",
  "synthetic-access-token",
  "secret-synthetic",
  "tenant-synthetic",
  "client-synthetic",
  "hello@idsculpture.test",
  "AADSTS7000215",
  "socket hang up",
];
const ECHO = `AADSTS7000215 socket hang up https://checkin.test/checkin/SECRET-BEARER-TOKEN Bearer synthetic-access-token secret-synthetic tenant-synthetic client-synthetic hello@idsculpture.test`;

/**
 * `env` is read once at module load, so the service must be imported AFTER the
 * environment is stubbed — the same trap the rate-limit tests document.
 */
async function graphService() {
  vi.resetModules();
  const mod = await import("@/server/integrations/email/graph-email-service");
  return new mod.GraphEmailService();
}

const isSendMail = (url: unknown) => String(url).includes("/sendMail");
const sendMailCalls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => isSendMail(url)).length;
const tokenOk = () =>
  new Response(JSON.stringify({ access_token: "synthetic-access-token" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

/** Routes by URL, so a test states only the token answer and the sendMail answer it cares about. */
function graphFetch(sendMail: number | (() => Response | Promise<Response>), token: () => Response | Promise<Response> = tokenOk) {
  return vi.fn(async (url: unknown) => {
    if (isSendMail(url)) return typeof sendMail === "number" ? new Response(null, { status: sendMail }) : sendMail();
    return token();
  });
}

/** Strings a caller or an admin could ever see for one send: the result and the whole ledger row. */
async function everythingVisible(result: { id: string; error?: string }) {
  const rows = await prisma.emailMessage.findMany();
  return JSON.stringify({ result, rows });
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
    expect(forbidden.error).toMatch(/admin consent/i);
    // How the tenant narrows Mail.Send to one mailbox is not established here, so no mechanism is asserted.
    expect(forbidden.error).not.toMatch(/Application Access Policy/i);
    expect(forbidden.error).toMatch(/scoping/i);
  });

  it("points at the mailbox setting on 404", () => {
    const missing = classifyGraphSendResponse(404);
    expect(missing.status).toBe("FAILED");
    expect(missing.error).toMatch(/GRAPH_SENDER_MAILBOX/);
  });

  it("treats throttling as a clean failure: not accepted, and an identical retry is refused as a duplicate", () => {
    // Graph rejects a throttled request rather than executing it, so this is
    // knowably not-sent. Calling it UNCERTAIN would freeze every throttled
    // message in a campaign for manual checking.
    const throttled = classifyGraphSendResponse(429);
    expect(throttled.status).toBe("FAILED");
    expect(throttled.error).toMatch(/did not accept the message/i);
    expect(throttled.error).toMatch(/refused as a duplicate/i);
    expect(throttled.error).toMatch(/needs a new send/i);
    expect(throttled.error).not.toMatch(/safe to send/i);
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
    for (const code of [400, 409, 410, 413, 422]) {
      expect(classifyGraphSendResponse(code).status, String(code)).toBe("FAILED");
    }
  });

  it("refuses to guess on a status the request may already have been processed under", () => {
    // A 1xx, an unfollowed 3xx and 408 reached Graph without a definite answer.
    for (const code of [100, 199, 300, 302, 304, 399, 408]) {
      const unknown = classifyGraphSendResponse(code);
      expect(unknown.status, String(code)).toBe("UNCERTAIN");
      expect(unknown.error, String(code)).toMatch(/check the sent mailbox/i);
    }
  });

  it("builds every error from constants and the status number alone", () => {
    for (const code of [401, 403, 404, 400, 429, 500, 503]) {
      expect(classifyGraphSendResponse(code).error, String(code)).toMatch(/^[A-Za-z0-9 ().,_;'-]+$/);
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("commits a PENDING ledger row BEFORE the request, then settles it", async () => {
    const seen: string[] = [];
    const fetchMock = graphFetch(async () => {
      seen.push(...(await prisma.emailMessage.findMany()).map((row) => row.status));
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await (await graphService()).send(MESSAGE);
    expect(result.status).toBe("SENT");
    expect(seen).toEqual(["PENDING"]);

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

  type SendMailInit = RequestInit & { headers: Record<string, string>; body: string };
  const sendMailCall = (fetchMock: ReturnType<typeof graphFetch>) =>
    fetchMock.mock.calls[1] as unknown as [string, SendMailInit];

  it("requests an app-only token with the client credentials grant", async () => {
    const fetchMock = graphFetch(202);
    vi.stubGlobal("fetch", fetchMock);
    await (await graphService()).send(MESSAGE);

    const [tokenUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string>; body: URLSearchParams }];
    expect(String(tokenUrl)).toBe("https://login.microsoftonline.com/tenant-synthetic/oauth2/v2.0/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.body).toBeInstanceOf(URLSearchParams);
    expect(init.body.get("grant_type")).toBe("client_credentials");
    expect(init.body.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(init.body.get("client_id")).toBe("client-synthetic");
    expect(init.body.get("client_secret")).toBe("secret-synthetic");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends to the configured mailbox endpoint with a bearer token and the full message payload", async () => {
    vi.stubEnv("EMAIL_REPLY_TO", "");
    const fetchMock = graphFetch(202);
    vi.stubGlobal("fetch", fetchMock);
    await (await graphService()).send(MESSAGE);

    const [sendUrl, init] = sendMailCall(fetchMock);
    expect(String(sendUrl)).toBe(
      "https://graph.microsoft.com/v1.0/users/hello%40idsculpture.test/sendMail",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer synthetic-access-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = JSON.parse(init.body);
    expect(body.message.subject).toBe(MESSAGE.subject);
    expect(body.message.body).toEqual({ contentType: "HTML", content: MESSAGE.html });
    expect(body.message.toRecipients).toEqual([
      { emailAddress: { address: "recipient@example.invalid", name: "Pat Recipient" } },
    ]);
    expect(body.message).not.toHaveProperty("replyTo");
    expect(body.message).not.toHaveProperty("from");
    expect(body.saveToSentItems).toBe(true);
  });

  it("adds Reply-To only when EMAIL_REPLY_TO is set", async () => {
    vi.stubEnv("EMAIL_REPLY_TO", "replies@idsculpture.test");
    const fetchMock = graphFetch(202);
    vi.stubGlobal("fetch", fetchMock);
    await (await graphService()).send(MESSAGE);

    const body = JSON.parse(sendMailCall(fetchMock)[1].body);
    expect(body.message.replyTo).toEqual([{ emailAddress: { address: "replies@idsculpture.test" } }]);
    expect(body.message).not.toHaveProperty("from");
  });

  describe("an unknown outcome is returned as UNCERTAIN and never replayed", () => {
    const unknowns: [string, () => ReturnType<typeof graphFetch>][] = [
      ["HTTP 500", () => graphFetch(500)],
      ["HTTP 502", () => graphFetch(502)],
      ["HTTP 503 with an echoing body", () => graphFetch(() => new Response(ECHO, { status: 503 }))],
      ["HTTP 504", () => graphFetch(504)],
      ["HTTP 302 (an unfollowed redirect)", () => graphFetch(302)],
      ["HTTP 304", () => graphFetch(304)],
      ["HTTP 408", () => graphFetch(408)],
      ["a timeout", () => graphFetch(() => Promise.reject(timeout()))],
      ["a transport failure echoing secrets", () => graphFetch(() => Promise.reject(new Error(ECHO)))],
    ];

    it.each(unknowns)("%s", async (_label, makeFetch) => {
      const fetchMock = makeFetch();
      vi.stubGlobal("fetch", fetchMock);
      const service = await graphService();

      const result = await service.send(MESSAGE);

      expect(result.status).toBe("UNCERTAIN");
      expect(result.error).toMatch(/sent mailbox/i);
      expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } })).status).toBe("UNCERTAIN");
      const visible = await everythingVisible(result);
      for (const leak of LEAKS) expect(visible, leak).not.toContain(leak);

      const callsBefore = fetchMock.mock.calls.length;
      const repeat = await service.send(MESSAGE);
      expect(repeat.status).toBe("UNCERTAIN");
      expect(repeat.id).toBe(result.id);
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
      expect(sendMailCalls(fetchMock)).toBe(1);
    });
  });

  describe("a definite rejection is FAILED with fixed text", () => {
    it.each([400, 401, 403, 404, 413, 422, 429])("HTTP %s", async (code) => {
      const fetchMock = graphFetch(() => new Response(ECHO, { status: code }));
      vi.stubGlobal("fetch", fetchMock);

      const result = await (await graphService()).send(MESSAGE);

      expect(result.status).toBe("FAILED");
      expect(result.error).toContain(String(code));
      expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } })).status).toBe("FAILED");
      const visible = await everythingVisible(result);
      for (const leak of LEAKS) expect(visible, leak).not.toContain(leak);
    });
  });

  describe("a duplicate", () => {
    it("arriving while the first is in flight returns UNCERTAIN, makes no second sendMail request, and the first completes SENT", async () => {
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fetchMock = graphFetch(async () => {
        entered();
        await gate;
        return new Response(null, { status: 202 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const service = await graphService();

      const first = service.send(MESSAGE);
      await ready;
      let second;
      try {
        second = await service.send(MESSAGE);
      } finally {
        release();
      }
      expect(second.status).toBe("UNCERTAIN");
      expect(sendMailCalls(fetchMock)).toBe(1);

      const done = await first;
      expect(done.status).toBe("SENT");
      expect(second.id).toBe(done.id);
      expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: done.id } })).status).toBe("SENT");
      expect(sendMailCalls(fetchMock)).toBe(1);
      // Once settled, the same request is reported SENT and still not replayed.
      expect((await service.send(MESSAGE)).status).toBe("SENT");
      expect(sendMailCalls(fetchMock)).toBe(1);
    });

    it("identical concurrent calls make exactly one sendMail request", async () => {
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const fetchMock = graphFetch(async () => {
        entered();
        await gate;
        return new Response(null, { status: 202 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const service = await graphService();

      // Started together; the two that lose the race must settle while the winner is still waiting on Graph.
      const settledEarly: string[] = [];
      const calls = [1, 2, 3].map(() => service.send(MESSAGE).then((result) => { settledEarly.push(result.status); return result; }));
      await ready;
      await vi.waitFor(() => expect(settledEarly).toHaveLength(2));
      expect(settledEarly).toEqual(["UNCERTAIN", "UNCERTAIN"]);
      release();
      const results = await Promise.all(calls);

      expect(sendMailCalls(fetchMock)).toBe(1);
      expect(results.filter((result) => result.status === "SENT")).toHaveLength(1);
      expect(await prisma.emailMessage.count()).toBe(1);
    });

    it.each([
      ["SENT", "SENT"],
      ["FAILED", "FAILED"],
      ["UNCERTAIN", "UNCERTAIN"],
      ["PENDING", "UNCERTAIN"],
    ])("of a stored %s row returns %s with no network request and fixed text, not the stored text", async (stored, expected) => {
      const fetchMock = graphFetch(202);
      vi.stubGlobal("fetch", fetchMock);
      const service = await graphService();
      const original = await service.send(MESSAGE);
      await prisma.emailMessage.update({
        where: { id: original.id },
        data: { status: stored, error: `stored text ${ECHO}` },
      });
      const callsBefore = fetchMock.mock.calls.length;

      const repeat = await service.send(MESSAGE);

      expect(repeat.status).toBe(expected);
      expect(repeat.id).toBe(original.id);
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
      expect(repeat.error ?? "").not.toContain("stored text");
      for (const leak of LEAKS) expect(repeat.error ?? "", leak).not.toContain(leak);
      if (expected === "SENT") expect(repeat.error).toBeUndefined();
      else expect(repeat.error).toBeTruthy();
      if (stored === "FAILED") {
        expect(repeat.error).toMatch(/was not accepted/i);
        expect(repeat.error).toMatch(/refused as a duplicate/i);
        expect(repeat.error).toMatch(/needs a new send/i);
      }
    });
  });

  it("returns a deployment refusal as FAILED — no request, no ledger row, nothing thrown", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await (await graphService()).send(MESSAGE);

    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/Refusing/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await prisma.emailMessage.count()).toBe(0);
    for (const leak of LEAKS) expect(JSON.stringify(result), leak).not.toContain(leak);
  });

  describe("any failure before sendMail is FAILED and no sendMail request is made", () => {
    const stages: [string, () => ReturnType<typeof graphFetch>][] = [
      ["token HTTP 401 with an echoing body", () => graphFetch(202, () => new Response(ECHO, { status: 401 }))],
      ["token HTTP 500", () => graphFetch(202, () => new Response(ECHO, { status: 500 }))],
      ["token body that is not JSON", () => graphFetch(202, () => new Response(ECHO, { status: 200 }))],
      ["token body without an access token", () => graphFetch(202, () => Response.json({ error_description: ECHO }))],
      ["token body with an empty access token", () => graphFetch(202, () => Response.json({ access_token: "" }))],
      ["a token transport failure echoing secrets", () => graphFetch(202, () => Promise.reject(new Error(ECHO)))],
      ["a token timeout", () => graphFetch(202, () => Promise.reject(timeout()))],
    ];

    it.each(stages)("%s", async (_label, makeFetch) => {
      const fetchMock = makeFetch();
      vi.stubGlobal("fetch", fetchMock);
      const service = await graphService();

      const result = await service.send(MESSAGE);

      expect(result.status).toBe("FAILED");
      expect(sendMailCalls(fetchMock)).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } });
      expect(row.status).toBe("FAILED");
      expect(row.error).toBeTruthy();
      const visible = await everythingVisible(result);
      for (const leak of LEAKS) expect(visible, leak).not.toContain(leak);
    });
  });

  it.each([
    ["GRAPH_TENANT_ID"],
    ["GRAPH_CLIENT_ID"],
    ["GRAPH_CLIENT_SECRET"],
    ["GRAPH_SENDER_MAILBOX"],
  ])("refuses before any network call when %s is missing, and names only the variable", async (name) => {
    vi.stubEnv(name, "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await (await graphService()).send(MESSAGE);

    expect(result.status).toBe("FAILED");
    expect(result.error).toBe(`${name} is not configured.`);
    expect(fetchMock).not.toHaveBeenCalled();
    // The other three values are still configured and must not appear anywhere.
    const visible = await everythingVisible(result);
    for (const leak of LEAKS) expect(visible, leak).not.toContain(leak);
  });

  it.each([
    ["GRAPH_TENANT_ID"],
    ["GRAPH_CLIENT_ID"],
    ["GRAPH_CLIENT_SECRET"],
    ["GRAPH_SENDER_MAILBOX"],
  ])("counts a whitespace-only %s as not configured: FAILED naming the variable, no network call", async (name) => {
    vi.stubEnv(name, " \t ");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await (await graphService()).send(MESSAGE);

    expect(result.status).toBe("FAILED");
    expect(result.error).toBe(`${name} is not configured.`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims padded GRAPH_* values before they reach the token request and the sendMail URL", async () => {
    vi.stubEnv("GRAPH_TENANT_ID", "  tenant-synthetic\n");
    vi.stubEnv("GRAPH_CLIENT_ID", " client-synthetic ");
    vi.stubEnv("GRAPH_CLIENT_SECRET", "\tsecret-synthetic  ");
    vi.stubEnv("GRAPH_SENDER_MAILBOX", " hello@idsculpture.test ");
    const fetchMock = graphFetch(202);
    vi.stubGlobal("fetch", fetchMock);

    const result = await (await graphService()).send(MESSAGE);

    expect(result.status).toBe("SENT");
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(String(tokenUrl)).toBe("https://login.microsoftonline.com/tenant-synthetic/oauth2/v2.0/token");
    expect(tokenInit.body.get("client_id")).toBe("client-synthetic");
    expect(tokenInit.body.get("client_secret")).toBe("secret-synthetic");
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://graph.microsoft.com/v1.0/users/hello%40idsculpture.test/sendMail");
  });

  describe("when the final ledger update fails", () => {
    it("returns UNCERTAIN with a fixed message, never throws, and leaves the row PENDING so a repeat cannot replay", async () => {
      const fetchMock = graphFetch(202);
      vi.stubGlobal("fetch", fetchMock);
      const service = await graphService();
      const { prisma: servicePrisma } = await import("@/lib/db");
      vi.spyOn(servicePrisma.emailMessage, "update").mockRejectedValueOnce(new Error(`db down ${ECHO}`));

      const result = await service.send(MESSAGE);

      expect(result.status).toBe("UNCERTAIN");
      expect(result.error).toMatch(/sent mailbox/i);
      const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } });
      expect(row.status).toBe("PENDING");
      const visible = await everythingVisible(result);
      for (const leak of LEAKS) expect(visible, leak).not.toContain(leak);

      const callsBefore = fetchMock.mock.calls.length;
      const repeat = await service.send(MESSAGE);
      expect(repeat.status).toBe("UNCERTAIN");
      expect(fetchMock.mock.calls.length).toBe(callsBefore);
      expect(sendMailCalls(fetchMock)).toBe(1);
    });

    it("also holds for a definite FAILED, because the PENDING row is what blocks replay", async () => {
      vi.stubGlobal("fetch", graphFetch(400));
      const service = await graphService();
      const { prisma: servicePrisma } = await import("@/lib/db");
      vi.spyOn(servicePrisma.emailMessage, "update").mockRejectedValueOnce(new Error("db down"));

      const result = await service.send(MESSAGE);

      expect(result.status).toBe("UNCERTAIN");
      expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } })).status).toBe("PENDING");
    });
  });

  it("rethrows when the initial PENDING row cannot be written and no row exists", async () => {
    const fetchMock = graphFetch(202);
    vi.stubGlobal("fetch", fetchMock);
    const service = await graphService();
    const { prisma: servicePrisma } = await import("@/lib/db");
    vi.spyOn(servicePrisma.emailMessage, "create").mockRejectedValueOnce(new Error("db down"));

    await expect(service.send(MESSAGE)).rejects.toThrow("db down");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
