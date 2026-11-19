import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { saveResponse } from "@/server/services/response-service";
import { syncCampaignResponses } from "@/server/services/sync-service";
import { getSalesforceService } from "@/server/integrations/salesforce";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** A completed Closed Lost answer can be approved when its loss reason can travel with it. */

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const ADMIN = { user: { id: "u1", name: "Admin", email: "admin@example.com", roles: ["SalesOps.Admin"], oid: "oid-1" } };
// Restore the original property descriptors afterwards, not just the values.
const saved = [
  [env.salesforce, "writeEnabled"],
  [env.salesforce.write, "closedLost"],
  [env.salesforce.write, "lossReasonField"],
].map(([target, key]) => [target, key, Object.getOwnPropertyDescriptor(target, key as string)!] as const);
const set = (key: string, target: object, value: unknown) => Object.defineProperty(target, key, { value, configurable: true });
const APPROVE = "Approve Salesforce update";

async function closedLostAnswer(lossReason: string | null, stage = "CLOSED_LOST") {
  const { campaignId, tokens } = await launchCampaignAndCollectTokens("Closed Lost approval");
  const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId }, include: { contact: true, items: { orderBy: { position: "asc" } } } });
  const token = tokens.get(recipient.contact.name)!;
  // Only the first item is answered, so its button is the only one on the page.
  const [first] = recipient.items;
  if (stage !== "CLOSED_LOST") {
    expect(await saveResponse({ token, itemId: first.id, stage, closeDate: "2027-12-31" })).toMatchObject({ ok: true });
  } else if (lossReason) {
    expect(await saveResponse({ token, itemId: first.id, stage: "CLOSED_LOST", lossReason })).toMatchObject({ ok: true });
  } else {
    // A Closed Lost answer without a reason cannot be saved through the form; seed it directly.
    await prisma.checkInOpportunity.update({ where: { id: first.id }, data: { updatedStatus: "CLOSED_LOST", lossReason: null, submittedAt: new Date() } });
  }
  await prisma.checkInRecipient.update({ where: { id: recipient.id }, data: { completedAt: new Date() } });
  await prisma.checkInOpportunity.update({ where: { id: first.id }, data: { syncStatus: "WITHHELD" } });
  return { campaignId, itemId: first.id };
}

const render = async ({ campaignId }: { campaignId: string }) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));

describe("approving a Closed Lost answer", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    session.current = ADMIN;
    set("writeEnabled", env.salesforce, true);
    set("closedLost", env.salesforce.write, true);
    set("lossReasonField", env.salesforce.write, "Loss_Reason__c");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const [target, key, descriptor] of saved) Object.defineProperty(target, key as string, descriptor);
  });

  it("offers Approve and shows the loss reason under the answer", async () => {
    const html = await render(await closedLostAnswer("DEMO_BUDGET"));
    expect(html).toContain(APPROVE);
    expect(html).toMatch(/Closed Lost/);
    expect(html).toContain("DEMO_BUDGET");
  });

  it("explains, and offers no Approve, when Closed Lost writes are off", async () => {
    set("closedLost", env.salesforce.write, false);
    const html = await render(await closedLostAnswer("DEMO_BUDGET"));
    expect(html).toContain("SF_WRITE_CLOSED_LOST");
    expect(html).not.toContain(APPROVE);
  });

  it("explains, and offers no Approve, when no loss-reason field is configured", async () => {
    set("lossReasonField", env.salesforce.write, "");
    const html = await render(await closedLostAnswer("DEMO_BUDGET"));
    expect(html).toContain("SF_FIELD_LOSS_REASON");
    expect(html).not.toContain(APPROVE);
  });

  it("explains, and offers no Approve, when the answer has no loss reason", async () => {
    const html = await render(await closedLostAnswer(null));
    expect(html).toContain("records no loss reason");
    expect(html).not.toContain(APPROVE);
  });

  it("still offers Approve for an ordinary stage change", async () => {
    const html = await render(await closedLostAnswer(null, "PROPOSAL"));
    expect(html).toContain(APPROVE);
    expect(html).not.toContain("Loss reason:");
  });

  it("an approved Closed Lost answer is written once, with its loss reason", async () => {
    const service = getSalesforceService();
    const info = Object.getOwnPropertyDescriptor(service, "info");
    Object.defineProperty(service, "info", { value: { ...service.info, simulated: false }, configurable: true });
    const patch = vi.spyOn(service, "applyUpdate").mockResolvedValue();
    try {
      const { campaignId, itemId } = await closedLostAnswer("DEMO_BUDGET");
      const item = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemId } });
      await syncCampaignResponses({ campaignId, itemIds: [itemId] }, "admin", { itemId, revision: item.updatedAt.toISOString() });
      expect(patch).toHaveBeenCalledTimes(1);
      expect(patch.mock.calls[0][0]).toMatchObject({ stage: "CLOSED_LOST", lossReason: "DEMO_BUDGET" });
      expect((await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemId } })).syncStatus).toBe("SYNCED");
    } finally {
      if (info) Object.defineProperty(service, "info", info);
    }
  });

  it("an approved Closed Lost answer is withheld, not written, when Closed Lost writes are off", async () => {
    set("closedLost", env.salesforce.write, false);
    const service = getSalesforceService();
    const info = Object.getOwnPropertyDescriptor(service, "info");
    Object.defineProperty(service, "info", { value: { ...service.info, simulated: false }, configurable: true });
    const patch = vi.spyOn(service, "applyUpdate").mockResolvedValue();
    try {
      const { campaignId, itemId } = await closedLostAnswer("DEMO_BUDGET");
      const item = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemId } });
      await syncCampaignResponses({ campaignId, itemIds: [itemId] }, "admin", { itemId, revision: item.updatedAt.toISOString() });
      expect(patch).not.toHaveBeenCalled();
      expect((await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemId } })).syncStatus).toBe("WITHHELD");
    } finally {
      if (info) Object.defineProperty(service, "info", info);
    }
  });
});
