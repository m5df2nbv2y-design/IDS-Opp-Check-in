import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { getOrCreateDraft, sendDraft, setSelection } from "@/server/services/campaign-draft-service";
import { getCampaignSummary, launchCampaign, readReminderRecovery, resumeLaunch, sendReminders } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";
import { ECHO, LEAKS, tokenOk, useGraphProvider } from "./graph-fixtures";

/**
 * The integrated launch, reminder and draft-send code run against the real
 * Graph adapter (fetch stubbed). The point is the whole path: the adapter's
 * answer, what launch and reminders do with it, the counts an administrator is
 * shown, and that nothing the provider echoes survives into storage.
 */

let graph: ReturnType<typeof useGraphProvider>;

beforeEach(async () => {
  await resetDatabase();
  await refreshCatalogFromSalesforce("test");
  graph = useGraphProvider();
});
afterEach(() => {
  graph.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The first open, resolved opportunity of each of `count` distinct contacts. */
async function opportunitiesForContacts(count: number) {
  const all = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    include: { contact: true },
    orderBy: { externalId: "asc" },
  });
  const picked = [...new Map(all.map((opportunity) => [opportunity.contactId, opportunity])).values()].slice(0, count);
  expect(picked).toHaveLength(count);
  return picked;
}

const launch = (opportunities: { id: string }[]) =>
  launchCampaign({ opportunityIds: opportunities.map((o) => o.id), name: "Graph", period: "T", actor: "test" });
const audits = (campaignId: string, type: string) => prisma.auditEvent.findMany({ where: { campaignId, type } });
const recipients = (campaignId: string) => prisma.checkInRecipient.findMany({ where: { campaignId }, include: { contact: true } });

/** Every place text from a send could land: audit rows, recipient rows and the email ledger. */
async function storedText(campaignId: string) {
  return JSON.stringify({
    audits: await prisma.auditEvent.findMany({ where: { campaignId } }),
    recipients: await prisma.checkInRecipient.findMany({ where: { campaignId } }),
    emails: await prisma.emailMessage.findMany({ where: { campaignId } }),
  });
}
function expectNoLeaks(text: string) {
  for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
}

describe("launch through Graph", () => {
  it("an unknown invitation (Graph 503) is UNCERTAIN: counted apart from failures, audited, never replayed", async () => {
    const [opportunity] = await opportunitiesForContacts(1);
    graph.state.sendMail = () => () => new Response(ECHO, { status: 503 });

    const result = await launch([opportunity]);

    expect(result).toMatchObject({ emailsSent: 0, emailsFailed: 0, emailsUncertain: 1 });
    const [recipient] = await recipients(result.campaignId);
    expect(recipient.sendStatus).toBe("UNCERTAIN");
    expect(recipient.sentAt).toBeNull();
    expect(await audits(result.campaignId, AUDIT_EVENTS.INVITE_UNCERTAIN)).toHaveLength(1);
    expect(await audits(result.campaignId, AUDIT_EVENTS.INVITE_FAILED)).toHaveLength(0);
    expect(await audits(result.campaignId, AUDIT_EVENTS.INVITE_SENT)).toHaveLength(0);
    const [email] = await prisma.emailMessage.findMany({ where: { campaignId: result.campaignId } });
    expect(email).toMatchObject({ provider: "graph", status: "UNCERTAIN" });
    expectNoLeaks(await storedText(result.campaignId));

    const summary = (await getCampaignSummary(result.campaignId))!;
    expect(summary).toMatchObject({ emailsSent: 0, emailsFailed: 0, emailsUncertain: 1, unresolvedDeliveryCount: 1 });

    // resumeLaunch must not put a second sendMail request on the wire for the unknown recipient.
    const resumed = await resumeLaunch(result.campaignId, "test");
    expect(resumed.emailsUncertain).toBe(0);
    expect(graph.state.sendMailTo).toHaveLength(1);
  });

  it("an accepted invitation is SENT and counted once", async () => {
    const [opportunity] = await opportunitiesForContacts(1);

    const result = await launch([opportunity]);

    expect(result).toMatchObject({ emailsSent: 1, emailsFailed: 0, emailsUncertain: 0 });
    expect((await recipients(result.campaignId))[0].sendStatus).toBe("SENT");
    expect(await audits(result.campaignId, AUDIT_EVENTS.INVITE_SENT)).toHaveLength(1);
  });

  it.each([
    ["a definite 4xx", () => { graph.state.sendMail = () => () => new Response(ECHO, { status: 400 }); }, 1],
    ["a token failure", () => { graph.state.token = () => new Response(ECHO, { status: 401 }); }, 0],
  ])("%s is FAILED, not unknown", async (_label, arrange, expectedSendMailRequests) => {
    const [opportunity] = await opportunitiesForContacts(1);
    arrange();

    const result = await launch([opportunity]);

    expect(result).toMatchObject({ emailsSent: 0, emailsFailed: 1, emailsUncertain: 0 });
    expect((await recipients(result.campaignId))[0].sendStatus).toBe("FAILED");
    expect(await audits(result.campaignId, AUDIT_EVENTS.INVITE_FAILED)).toHaveLength(1);
    expect(await audits(result.campaignId, AUDIT_EVENTS.INVITE_UNCERTAIN)).toHaveLength(0);
    expect(graph.state.sendMailTo).toHaveLength(expectedSendMailRequests);
    expectNoLeaks(await storedText(result.campaignId));
  });

  it("a deployment refusal is FAILED with no request and no ledger row, not an unknown send", async () => {
    const [opportunity] = await opportunitiesForContacts(1);
    vi.stubEnv("VERCEL_ENV", "preview");

    const result = await launch([opportunity]);

    expect(result).toMatchObject({ emailsSent: 0, emailsFailed: 1, emailsUncertain: 0 });
    const [recipient] = await recipients(result.campaignId);
    expect(recipient.sendStatus).toBe("FAILED");
    expect(recipient.sendError).toMatch(/Refusing/);
    expect(graph.fetchMock).not.toHaveBeenCalled();
    expect(await prisma.emailMessage.count()).toBe(0);
  });

  it("Sent, Failed and Unknown counts for a fully attempted launch, and a reminder-unknown recipient stays in Sent", async () => {
    const opportunities = await opportunitiesForContacts(3);
    const [sent, rejected, unknown] = opportunities.map((o) => o.contact!.email);
    graph.state.sendMail = (to) => (to === sent ? 202 : to === rejected ? 400 : 503);

    const result = await launch(opportunities);

    expect(result).toMatchObject({ emailsSent: 1, emailsFailed: 1, emailsUncertain: 1 });
    const summary = (await getCampaignSummary(result.campaignId))!;
    expect(summary).toMatchObject({ emailsSent: 1, emailsFailed: 1, emailsUncertain: 1, recipientCount: 3 });
    expect(summary.emailsSent + summary.emailsFailed + summary.emailsUncertain).toBe(opportunities.length);

    // The one delivered invitation then gets an unknown REMINDER outcome.
    graph.state.sendMail = () => 503;
    expect(await sendReminders(result.campaignId, "test")).toBe(0);
    const after = (await getCampaignSummary(result.campaignId))!;
    expect(after).toMatchObject({ emailsSent: 1, emailsFailed: 1, emailsUncertain: 1 });
    expect(after.unresolvedDeliveryCount).toBe(2); // the unknown invitation plus the unknown reminder, both in the banner
    expect((await recipients(result.campaignId)).filter((r) => r.contact.email === sent)[0].sendStatus).toBe("REMINDER_UNCERTAIN");
    expect(graph.state.sendMailTo.filter((to) => to === unknown)).toHaveLength(1);
  });

  it("the resumeLaunch early return carries a zero unknown count", async () => {
    const [opportunity] = await opportunitiesForContacts(1);
    const { campaignId } = await launch([opportunity]);

    const resumed = await resumeLaunch(campaignId, "test");

    expect(resumed).toMatchObject({ recipients: 0, emailsSent: 0, emailsFailed: 0 });
    expect(resumed.emailsUncertain).toBe(0);
  });
});

describe("reminders through Graph", () => {
  async function sentCampaign() {
    const [opportunity] = await opportunitiesForContacts(1);
    const { campaignId } = await launch([opportunity]);
    const [original] = await recipients(campaignId);
    expect(original.sendStatus).toBe("SENT");
    return { campaignId, original };
  }

  it("a Graph 503 is REMINDER_UNCERTAIN: recovery evidence kept, the new link kept, and never replayed", async () => {
    const { campaignId, original } = await sentCampaign();
    graph.state.sendMail = () => () => new Response(ECHO, { status: 503 });

    expect(await sendReminders(campaignId, "test")).toBe(0);

    const [after] = await recipients(campaignId);
    expect(after.sendStatus).toBe("REMINDER_UNCERTAIN");
    expect(after.tokenHash).not.toBe(original.tokenHash);
    expect(readReminderRecovery(after.sendError)).not.toBeNull();
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_UNCERTAIN)).toHaveLength(1);
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_FAILED)).toHaveLength(0);
    expectNoLeaks(await storedText(campaignId));

    const requests = graph.state.sendMailTo.length;
    expect(await sendReminders(campaignId, "test")).toBe(0);
    expect(graph.state.sendMailTo).toHaveLength(requests);
  });

  it("a token failure is a definite rejection: the previous link is restored and a later reminder may go out", async () => {
    const { campaignId, original } = await sentCampaign();
    graph.state.token = () => new Response(ECHO, { status: 401 });

    expect(await sendReminders(campaignId, "test")).toBe(0);

    const [after] = await recipients(campaignId);
    expect(after.sendStatus).toBe("SENT");
    expect(after.tokenHash).toBe(original.tokenHash);
    expect(after.reminderCount).toBe(0);
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_FAILED)).toHaveLength(1);
    expect(await audits(campaignId, AUDIT_EVENTS.REMINDER_UNCERTAIN)).toHaveLength(0);
    expectNoLeaks(await storedText(campaignId));

    graph.state.token = tokenOk;
    expect(await sendReminders(campaignId, "test")).toBe(1);
  });
});

describe("sendDraft totals", () => {
  async function selectedDraft(count: number) {
    const draft = await getOrCreateDraft("test");
    const opportunities = await opportunitiesForContacts(count);
    await setSelection({ campaignId: draft.id, opportunityIds: opportunities.map((o) => o.id), selected: true });
    return draft.id;
  }

  it("the normal return reports unknown sends apart from failures", async () => {
    const campaignId = await selectedDraft(2);
    const [first] = (await opportunitiesForContacts(2)).map((o) => o.contact!.email);
    graph.state.sendMail = (to) => (to === first ? 503 : 202);

    const result = await sendDraft(campaignId, "test");

    expect(result).toMatchObject({ campaignId, sent: 2, recipients: 2, emailsFailed: 0, emailsUncertain: 1 });
  });

  it("the early return (nothing sendable) carries a zero unknown count", async () => {
    const draft = await getOrCreateDraft("test");

    expect(await sendDraft(draft.id, "test")).toEqual({
      campaignId: draft.id,
      sent: 0,
      recipients: 0,
      emailsFailed: 0,
      emailsUncertain: 0,
      drifted: [],
    });
    expect(graph.fetchMock).not.toHaveBeenCalled();
  });
});
