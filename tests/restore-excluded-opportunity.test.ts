import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreExcludedAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { ActionButton } from "@/components/admin/action-button";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import {
  excludeShortfallOpportunity,
  getCampaignSummary,
  getRecoverableOpportunityIds,
  launchCampaign,
  resumeLaunch,
  RESTORE_EXCLUDED_REFUSALS,
  restoreExcludedOpportunity,
} from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const FIRST = "Jane Doe";

/** Launched for Jane only, with one other opportunity selected and routed but never reached. */
async function shortfallCampaign() {
  await refreshCatalogFromSalesforce("test");
  const all = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    select: { id: true, contactId: true, contact: { select: { name: true } } },
  });
  const mine = all.filter((o) => o.contact!.name === FIRST);
  const target = all.find((o) => o.contact!.name !== FIRST)!;
  const { campaignId } = await launchCampaign({ opportunityIds: mine.map((o) => o.id), name: "Shortfall", period: "Test", actor: "test" });
  await prisma.campaignSelection.create({ data: { campaignId, opportunityId: target.id } });
  await prisma.auditEvent.updateMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING }, data: {
    detail: JSON.stringify({ version: 1, routes: Object.fromEntries([...mine, target].map((o) => [o.id, o.contactId])) }),
  } });
  return { campaignId, target, jane: mine[0].contactId! };
}

/** Closed: the target was excluded as no eligible contact and Jane finished, so the campaign is COMPLETE. */
async function closedWithExclusion() {
  const setup = await shortfallCampaign();
  await prisma.opportunity.update({ where: { id: setup.target.id }, data: { isOpen: false } });
  await prisma.checkInRecipient.updateMany({ where: { campaignId: setup.campaignId }, data: { completedAt: new Date() } });
  expect(await excludeShortfallOpportunity(setup.campaignId, setup.target.id, "NO_ELIGIBLE_CONTACT", "josh")).toEqual({ ok: true });
  expect(await campaign(setup.campaignId)).toMatchObject({ status: "COMPLETE" });
  return setup;
}

const campaign = (campaignId: string) => prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
const restores = (campaignId: string) =>
  prisma.auditEvent.findMany({ where: { campaignId, type: AUDIT_EVENTS.SELECTION_RESTORED } });
const render = async (campaignId: string) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));

/** The restore buttons the page renders, with the exact action and confirm text each carries. */
async function restoreButtons(campaignId: string) {
  const tree = await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never);
  const found: { action: () => Promise<void | { error: string }>; confirm: string }[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement(node)) return;
    const props = node.props as Record<string, unknown>;
    if (node.type === ActionButton && props.children === "Restore to this campaign") found.push(props as never);
    walk(props.children as ReactNode);
  };
  walk(tree);
  return found;
}

describe("restore an excluded shortfall opportunity", () => {
  beforeEach(resetDatabase);

  it("still blocked: leaves the excluded card, back in needs review with its current reason, audited", async () => {
    const { campaignId, target, jane } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { contactId: jane } });
    await excludeShortfallOpportunity(campaignId, target.id, "ALREADY_INVITED", "josh");
    // The cause changed while excluded: the current reason is shown, not the old one.
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    expect(await restoreExcludedOpportunity(campaignId, target.id, "Josh Young")).toEqual({ ok: true });
    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.excluded).toEqual([]);
    expect(summary.needsReview).toEqual([expect.objectContaining({ opportunityId: target.id, reason: "NO_ELIGIBLE_CONTACT" })]);
    expect(summary.status).toBe("IN_PROGRESS");
    const [row] = await restores(campaignId);
    expect(row).toMatchObject({ actor: "Josh Young", actorKind: "ADMIN", opportunityId: target.id });
    expect(JSON.parse(row.detail!)).toMatchObject({ version: 1, opportunityId: target.id });
    // Nothing else changed: selection kept, routing record untouched, exclusion kept, no new recipient.
    expect(await prisma.campaignSelection.count({ where: { campaignId, opportunityId: target.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { campaignId, type: AUDIT_EVENTS.SELECTION_EXCLUDED } })).toBe(1);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(1);
  });

  it("now resumable: counts as recoverable, sends nothing itself, and Resume invites its contact", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh");
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: true } });
    expect(await getRecoverableOpportunityIds(campaignId)).toEqual([]);
    const invites = await prisma.emailMessage.count({ where: { campaignId } });
    expect(await restoreExcludedOpportunity(campaignId, target.id, "josh")).toEqual({ ok: true });
    expect(await prisma.emailMessage.count({ where: { campaignId } })).toBe(invites);
    expect(await getRecoverableOpportunityIds(campaignId)).toEqual([target.id]);
    expect((await resumeLaunch(campaignId, "josh")).emailsSent).toBe(1);
    const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId, contactId: target.contactId! }, include: { items: true } });
    expect(recipient.items.map((i) => i.opportunityId)).toEqual([target.id]);
  });

  it("reopens a COMPLETE campaign when the opportunity is unreached, and says so in the audit", async () => {
    const { campaignId, target } = await closedWithExclusion();
    const { completedAt } = await campaign(campaignId);
    expect(await restoreExcludedOpportunity(campaignId, target.id, "Josh Young")).toEqual({ ok: true });
    expect(await campaign(campaignId)).toMatchObject({ status: "IN_PROGRESS", completedAt: null });
    const [row] = await restores(campaignId);
    expect(row.summary).toContain("reopened");
    expect(row.summary).toContain(completedAt!.toISOString());
    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.needsReview).toEqual([expect.objectContaining({ opportunityId: target.id })]);
    expect(await render(campaignId)).toContain("Needs review");
    // The trail shows both steps with the admin's name.
    const trail = await prisma.auditEvent.findMany({
      where: { campaignId, opportunityId: target.id, type: { in: [AUDIT_EVENTS.SELECTION_EXCLUDED, AUDIT_EVENTS.SELECTION_RESTORED] } },
      orderBy: { createdAt: "asc" },
    });
    expect(trail.map((e) => [e.type, e.actor])).toEqual([[AUDIT_EVENTS.SELECTION_EXCLUDED, "josh"], [AUDIT_EVENTS.SELECTION_RESTORED, "Josh Young"]]);
  });

  it("already reached: restored, and a COMPLETE campaign stays COMPLETE", async () => {
    const { campaignId, target } = await closedWithExclusion();
    const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId } });
    // Reached by some other path: give it an invitation item copied from Jane's.
    const item = await prisma.checkInOpportunity.findFirstOrThrow({ where: { recipientId: recipient.id } });
    await prisma.checkInOpportunity.create({ data: { ...item, id: undefined, createdAt: undefined, updatedAt: undefined, opportunityId: target.id } });
    expect(await restoreExcludedOpportunity(campaignId, target.id, "josh")).toEqual({ ok: true });
    expect(await campaign(campaignId)).toMatchObject({ status: "COMPLETE" });
    expect((await restores(campaignId))[0].summary).not.toContain("reopened");
  });

  it("exclude again after a restore: the card shows it once, with the newest exclusion", async () => {
    const { campaignId, target, jane } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "first");
    await restoreExcludedOpportunity(campaignId, target.id, "josh");
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: true, contactId: jane } });
    expect(await excludeShortfallOpportunity(campaignId, target.id, "ALREADY_INVITED", "second")).toEqual({ ok: true });
    const { excluded, needsReview } = (await getCampaignSummary(campaignId))!;
    expect(needsReview).toEqual([]);
    expect(excluded).toEqual([expect.objectContaining({ opportunityId: target.id, reason: "ALREADY_INVITED", actor: "second" })]);
    expect(await restoreButtons(campaignId)).toHaveLength(1);
  });

  it("a full exclude → restore → exclude → restore cycle ends not excluded, with four audit rows", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    for (let i = 0; i < 2; i++) {
      expect(await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh")).toEqual({ ok: true });
      expect(await restoreExcludedOpportunity(campaignId, target.id, "josh")).toEqual({ ok: true });
    }
    const { excluded, needsReview } = (await getCampaignSummary(campaignId))!;
    expect(excluded).toEqual([]);
    expect(needsReview).toEqual([expect.objectContaining({ opportunityId: target.id, reason: "NO_ELIGIBLE_CONTACT" })]);
    expect(await prisma.auditEvent.count({ where: { campaignId, type: AUDIT_EVENTS.SELECTION_EXCLUDED } })).toBe(2);
    expect(await restores(campaignId)).toHaveLength(2);
  });

  it("a restore of an unrecognised exclusion does not cancel a later valid one", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    for (const type of [AUDIT_EVENTS.SELECTION_EXCLUDED, AUDIT_EVENTS.SELECTION_RESTORED]) {
      await prisma.auditEvent.create({ data: {
        type, summary: "seeded", actor: "old", actorKind: "ADMIN", campaignId, opportunityId: target.id,
        detail: JSON.stringify({ version: 1, opportunityId: target.id, reason: "NOT_A_REASON" }),
      } });
    }
    expect(await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh")).toEqual({ ok: true });
    const { excluded, needsReview } = (await getCampaignSummary(campaignId))!;
    expect(needsReview).toEqual([]);
    expect(excluded).toEqual([expect.objectContaining({ opportunityId: target.id, actor: "josh" })]);
  });

  it("not excluded, or a double click: refused with nothing written", async () => {
    const { campaignId, target } = await shortfallCampaign();
    expect(await restoreExcludedOpportunity(campaignId, target.id, "josh")).toEqual({ ok: false, message: RESTORE_EXCLUDED_REFUSALS.NOT_EXCLUDED });
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh");
    const results = await Promise.all([
      restoreExcludedOpportunity(campaignId, target.id, "a"),
      restoreExcludedOpportunity(campaignId, target.id, "b"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, message: RESTORE_EXCLUDED_REFUSALS.NOT_EXCLUDED });
    expect(await restores(campaignId)).toHaveLength(1);
  });

  it("a DRAFT campaign is refused with nothing written", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh");
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DRAFT" } });
    expect(await restoreButtons(campaignId)).toHaveLength(0);
    expect(await restoreExcludedOpportunity(campaignId, target.id, "josh")).toEqual({ ok: false, message: RESTORE_EXCLUDED_REFUSALS.NOT_OPEN });
    expect(await restores(campaignId)).toHaveLength(0);
  });

  it("bad input throws and writes nothing", async () => {
    const { campaignId } = await shortfallCampaign();
    await expect(restoreExcludedOpportunity(campaignId, 42 as never, "josh")).rejects.toThrow();
    expect(await restores(campaignId)).toHaveLength(0);
  });

  it("one Restore control per excluded row, with confirm text naming it and the reopen", async () => {
    const { campaignId, target } = await closedWithExclusion();
    const [button, ...rest] = await restoreButtons(campaignId);
    expect(rest).toHaveLength(0);
    const o = await prisma.opportunity.findUniqueOrThrow({ where: { id: target.id } });
    expect(button.confirm).toContain(o.customerName);
    expect(button.confirm).toContain("Nothing is sent");
    expect(button.confirm).toContain("Resume");
    expect(button.confirm).toContain("If this opportunity was never invited, the campaign reopens.");
  });

  describe("the server action", () => {
    beforeEach(() => {
      vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
      session.current = { user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" } };
      session.revalidated.length = 0;
    });
    afterEach(() => { vi.unstubAllEnvs(); session.current = null; });

    it("the action the page binds restores the row it was rendered for and revalidates", async () => {
      const { campaignId, target } = await closedWithExclusion();
      const [button] = await restoreButtons(campaignId);
      expect(await button.action()).toBeUndefined();
      const [row] = await restores(campaignId);
      expect(row.opportunityId).toBe(target.id);
      expect(row.actor).not.toBe("admin");
      expect(session.revalidated).toEqual(expect.arrayContaining([`/admin/campaigns/${campaignId}`, "/admin"]));
      session.revalidated.length = 0;
      expect(await button.action()).toEqual({ error: RESTORE_EXCLUDED_REFUSALS.NOT_EXCLUDED });
      expect(session.revalidated).toContain(`/admin/campaigns/${campaignId}`);
    });

    it("a non-admin caller throws and nothing is written", async () => {
      const { campaignId, target } = await closedWithExclusion();
      session.current = null;
      await expect(restoreExcludedAction(campaignId, target.id)).rejects.toThrow();
      expect(await restores(campaignId)).toHaveLength(0);
    });
  });
});
