import { vi } from "vitest";
import { env } from "@/lib/env";
import { getEmailService } from "@/server/integrations/email";
import { GraphEmailService } from "@/server/integrations/email/graph-email-service";

/**
 * Drives the REAL launch, reminder and recovery code through the REAL Graph
 * adapter with `fetch` stubbed, so a test sees exactly what an administrator
 * would see after a Graph answer. Nothing here reaches the network: the GRAPH_*
 * values are dummies and every request is answered by the stub.
 */

const GRAPH_CONFIG = {
  tenantId: "tenant-synthetic",
  clientId: "client-synthetic",
  clientSecret: "secret-synthetic",
  senderMailbox: "hello@idsculpture.test",
};

/** Everything a provider body, a thrown error or a config value could echo. None of it may be stored or shown. */
export const ECHO = `AADSTS7000215 socket hang up https://checkin.test/checkin/SECRET-BEARER-TOKEN Bearer synthetic-access-token ${GRAPH_CONFIG.clientSecret} ${GRAPH_CONFIG.tenantId} ${GRAPH_CONFIG.clientId} ${GRAPH_CONFIG.senderMailbox}`;
export const LEAKS = [
  "SECRET-BEARER-TOKEN",
  "synthetic-access-token",
  GRAPH_CONFIG.clientSecret,
  GRAPH_CONFIG.tenantId,
  GRAPH_CONFIG.clientId,
  GRAPH_CONFIG.senderMailbox,
  "AADSTS7000215",
  "socket hang up",
];

type Answer = number | (() => Response | Promise<Response>);

export const tokenOk = () =>
  new Response(JSON.stringify({ access_token: "synthetic-access-token" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Routes the stubbed `fetch` and swaps the active email service for the Graph
 * adapter. Change `state.sendMail` / `state.token` between steps of one test.
 */
export function useGraphProvider() {
  const state = {
    /** The sendMail answer, chosen per request from the recipient's address. */
    sendMail: ((): Answer => 202) as (to: string) => Answer,
    token: tokenOk as () => Response | Promise<Response>,
    sendMailTo: [] as string[],
  };

  const fetchMock = vi.fn(async (url: unknown, init?: { body?: string }) => {
    if (!String(url).includes("/sendMail")) return state.token();
    const to: string = JSON.parse(init!.body!).message.toRecipients[0].emailAddress.address;
    state.sendMailTo.push(to);
    const answer = state.sendMail(to);
    return typeof answer === "number" ? new Response(null, { status: answer }) : answer();
  });
  vi.stubGlobal("fetch", fetchMock);

  const saved = { ...env.graph };
  Object.assign(env.graph, GRAPH_CONFIG);
  const graph = new GraphEmailService();
  vi.spyOn(getEmailService(), "send").mockImplementation((message) => graph.send(message));

  return {
    state,
    fetchMock,
    /** Put the real GRAPH_* values back; pair with vi.restoreAllMocks() and vi.unstubAllGlobals(). */
    restore: () => void Object.assign(env.graph, saved),
  };
}
