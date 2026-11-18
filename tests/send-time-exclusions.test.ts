import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { getOrCreateDraft, sendDraft, setSelection } from "@/server/services/campaign-draft-service";
import { getCampaignSummary, launchCampaign } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

vi.mock("@/server/auth/config", () => ({ auth: async () => null, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const render = async (campaignId: string) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));

/** Selects `take` resolved opportunities, closes the first `drift` of them, then sends. */
async function sendWithDrift(take: number, drift: number) {
  await refreshCatalogFromSalesforce("test");
  const { id: campaignId } = await getOrCreateDraft("test");
  const selected = await prisma.opportunity.findMany({ where: { isOpen: true, resolutionStatus: "RESOLVED" }, orderBy: { id: "asc" }, take });
  await setSelection({ campaignId, opportunityIds: selected.map((o) => o.id), selected: true });
  const drifted = selected.slice(0, drift);
  await prisma.opportunity.updateMany({ where: { id: { in: drifted.map((o) => o.id) } }, data: { isOpen: false } });
  await sendDraft(campaignId, "test");
  return { campaignId, drifted };
}

const note = (campaignId: string) =>
  prisma.auditEvent.findFirstOrThrow({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_CREATED, summary: { contains: "excluded at send" } } });

describe("selections left out at send", () => {
  beforeEach(resetDatabase);

  it("drift at send: lists each as customer · opportunity, then the recorded note; shortfall and status unchanged", async () => {
    const { campaignId, drifted } = await sendWithDrift(4, 2);
    const summary = (await getCampaignSummary(campaignId))!;
    const { detail } = await note(campaignId);
    expect(summary.excludedAtSend.map((r) => r.opportunityId).sort()).toEqual(drifted.map((o) => o.id).sort());
    for (const o of drifted) {
      expect(summary.excludedAtSend).toContainEqual({ opportunityId: o.id, customerName: o.customerName, opportunityName: o.projectName ?? o.opportunityName });
    }
    expect(summary.excludedAtSendNote).toBe(detail);
    expect(summary).toMatchObject({ status: "IN_PROGRESS", unreachedCount: 0, needsReview: [], excluded: [] });

    const html = await render(campaignId);
    expect(html).toContain("2 selections left out at send");
    for (const row of summary.excludedAtSend) expect(html).toContain(`${row.customerName} · ${row.opportunityName}`.replace(/&/g, "&amp;"));
    expect(html).toContain("Recorded at send:");
    expect(html).toContain("These were never sent and are not part of this campaign. To check in on them, include them in a new campaign.");
    // Not an admin exclusion: no "Excluded from this campaign" card and no Restore button.
    expect(html).not.toContain("Excluded from this campaign");
    expect(html).not.toContain("Restore to this campaign");
  });

  it("note missing: shows the list only", async () => {
    const { campaignId } = await sendWithDrift(3, 1);
    await prisma.auditEvent.deleteMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_CREATED, summary: { contains: "excluded at send" } } });
    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.excludedAtSend).toHaveLength(1);
    expect(summary.excludedAtSendNote).toBeNull();
    const html = await render(campaignId);
    expect(html).toContain("1 selection left out at send");
    expect(html).not.toContain("Recorded at send:");
  });

  it("none: no card when nothing was left out", async () => {
    const { campaignId } = await sendWithDrift(3, 0);
    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.excludedAtSend).toEqual([]);
    expect(await render(campaignId)).not.toContain("left out at send");
  });

  it("legacy: no manifest, or an approved legacy routing with excluded: [], shows no card", async () => {
    await refreshCatalogFromSalesforce("test");
    const ids = (await prisma.opportunity.findMany({ where: { isOpen: true, resolutionStatus: "RESOLVED" }, take: 2 })).map((o) => o.id);
    const { campaignId } = await launchCampaign({ opportunityIds: ids, name: "Legacy", period: "Test", actor: "test" });
    await prisma.auditEvent.deleteMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
    expect((await getCampaignSummary(campaignId))!.excludedAtSend).toEqual([]);
    expect(await render(campaignId)).not.toContain("left out at send");
    await prisma.auditEvent.create({ data: { type: AUDIT_EVENTS.CAMPAIGN_ROUTING, summary: "Approved legacy routing", actor: "josh", actorKind: "ADMIN", campaignId,
      detail: JSON.stringify({ version: 1, routes: {}, excluded: [] }) } });
    expect((await getCampaignSummary(campaignId))!.excludedAtSend).toEqual([]);
  });

  it("opportunity row gone: shows the id as its name", async () => {
    const { campaignId, drifted } = await sendWithDrift(3, 1);
    // Drop the cached row without touching the manifest (detach dependents first).
    await prisma.campaignSelection.deleteMany({ where: { opportunityId: drifted[0].id } });
    await prisma.opportunity.delete({ where: { id: drifted[0].id } });
    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.excludedAtSend).toEqual([expect.objectContaining({ opportunityId: drifted[0].id, opportunityName: drifted[0].id, customerName: "Unknown opportunity" })]);
    expect(await render(campaignId)).toContain(drifted[0].id);
  });

  it("unreadable manifest: no card, page still renders", async () => {
    const { campaignId } = await sendWithDrift(3, 1);
    await prisma.auditEvent.updateMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING }, data: { detail: "{not json" } });
    expect((await getCampaignSummary(campaignId))!.excludedAtSend).toEqual([]);
    const html = await render(campaignId);
    expect(html).not.toContain("left out at send");
  });
});
