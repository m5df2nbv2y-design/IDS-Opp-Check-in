import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { resetDatabase } from "./fixtures";

/**
 * Real HTTP, loopback only. A stubbed Response cannot show whether the runtime's
 * fetch FOLLOWS a redirect, so these tests run the adapter's own request options
 * through the real fetch against 127.0.0.1 servers. Credentials are synthetic.
 */

const BASE_ENV = {
  EMAIL_PROVIDER: "graph",
  GRAPH_TENANT_ID: "tenant-synthetic",
  GRAPH_CLIENT_ID: "client-synthetic",
  GRAPH_CLIENT_SECRET: "secret-synthetic",
  GRAPH_SENDER_MAILBOX: "hello@idsculpture.test",
  EMAIL_FROM_ADDRESS: "hello@idsculpture.test",
};
const LINK = "https://checkin.test/checkin/SECRET-BEARER-TOKEN";
const MESSAGE = {
  to: { email: "recipient@example.invalid", name: "Pat Recipient" },
  subject: "Your check-in",
  html: `<p>${LINK}</p>`,
  text: LINK,
  kind: "INVITE" as const,
  linkUrl: LINK,
};

const realFetch = fetch;
const servers: Server[] = [];

type Seen = { method?: string; url?: string; body: string };

async function listen(handler: (req: IncomingMessage, body: string, res: import("node:http").ServerResponse) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      handler(req, body, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Sends the two Graph hosts to the fixture, with the adapter's own init and the real fetch. */
function routeGraphTo(token: string, graph: string) {
  vi.stubGlobal(
    "fetch",
    (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const target = u.startsWith("https://login.microsoftonline.com") ? u.replace("https://login.microsoftonline.com", token) : u.replace("https://graph.microsoft.com", graph);
      return realFetch(target, init);
    },
  );
}

const tokenOk = (_req: IncomingMessage, _body: string, res: import("node:http").ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "synthetic-access-token" }));
};

async function graphService() {
  vi.resetModules();
  const mod = await import("@/server/integrations/email/graph-email-service");
  return new mod.GraphEmailService();
}

beforeEach(async () => {
  await resetDatabase();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(BASE_ENV)) vi.stubEnv(key, value);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
});

describe("redirects against a real HTTP server", () => {
  it("control: default fetch follows a 302 to the sink, so the fixture can tell following from not following", async () => {
    const sink = await listen((_r, _b, res) => res.writeHead(202).end());
    const hop = await listen((_r, _b, res) => res.writeHead(302, { location: `${sink.origin}/sink` }).end());

    const response = await realFetch(`${hop.origin}/start`, { method: "POST", body: "x" });

    expect(response.status).toBe(202);
    expect(sink.seen).toHaveLength(1);
  });

  it.each([302, 307, 308])("sendMail HTTP %s: UNCERTAIN, and the Location target receives no request", async (code) => {
    const sink = await listen((_r, _b, res) => res.writeHead(202).end());
    const token = await listen(tokenOk);
    const graph = await listen((_r, _b, res) => res.writeHead(code, { location: `${sink.origin}/sink` }).end());
    routeGraphTo(token.origin, graph.origin);

    const result = await (await graphService()).send(MESSAGE);

    expect(result.status).toBe("UNCERTAIN");
    expect(graph.seen).toHaveLength(1);
    expect(graph.seen[0].method).toBe("POST");
    expect(sink.seen).toHaveLength(0);
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id: result.id } })).status).toBe("UNCERTAIN");
  });

  it.each([302, 307, 308])("token HTTP %s: FAILED, no sendMail, and neither the secret nor the Location target is contacted", async (code) => {
    const sink = await listen((_r, _b, res) => res.writeHead(200).end("{}"));
    const token = await listen((_r, _b, res) => res.writeHead(code, { location: `${sink.origin}/sink` }).end());
    const graph = await listen((_r, _b, res) => res.writeHead(202).end());
    routeGraphTo(token.origin, graph.origin);

    const result = await (await graphService()).send(MESSAGE);

    expect(result.status).toBe("FAILED");
    expect(token.seen).toHaveLength(1);
    expect(sink.seen).toHaveLength(0);
    expect(graph.seen).toHaveLength(0);
  });

  it("an accepted 202 is still SENT", async () => {
    const token = await listen(tokenOk);
    const graph = await listen((_r, _b, res) => res.writeHead(202).end());
    routeGraphTo(token.origin, graph.origin);

    expect((await (await graphService()).send(MESSAGE)).status).toBe("SENT");
  });
});
