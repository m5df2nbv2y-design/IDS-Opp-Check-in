import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { excludeShortfallAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { ActionButton } from "@/components/admin/action-button";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import {
  excludeShortfallOpportunity,
  getCampaignSummary,
  getRecoverableOpportunityIds,
  getUnreachedOpportunityIds,
  launchCampaign,
  resumeLaunch,
  SHORTFALL_EXCLUDE_REFUSALS,
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

const exclusions = (campaignId: string) =>
  prisma.auditEvent.findMany({ where: { campaignId, type: AUDIT_EVENTS.SELECTION_EXCLUDED } });
const status = async (campaignId: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;
const render = async (campaignId: string) =>
  renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));

/** The exclude buttons the page renders, with the exact action each is bound to. */
async function excludeButtons(campaignId: string) {
  const tree = await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never);
  const found: { action: () => Promise<void | { error: string }> }[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement(node)) return;
    const props = node.props as Record<string, unknown>;
    if (node.type === ActionButton && props.children === "Exclude from this campaign") found.push(props as never);
    walk(props.children as ReactNode);
  };
  walk(tree);
  return found;
}

describe("exclude a shortfall opportunity that needs review", () => {
  beforeEach(resetDatabase);

  it("contact already invited: listed, excluded with an audit row, unreached drops by one", async () => {
    const { campaignId, target, jane } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { contactId: jane } });
    const summary = (await getCampaignSummary(campaignId))!;
    expect(summary.needsReview).toEqual([expect.objectContaining({ opportunityId: target.id, reason: "ALREADY_INVITED" })]);
    expect(await render(campaignId)).toContain("Contact already has an invitation");
    const before = (await getUnreachedOpportunityIds(campaignId)).length;
    expect(await excludeShortfallOpportunity(campaignId, target.id, "ALREADY_INVITED", "josh")).toEqual({ ok: true });
    expect((await getUnreachedOpportunityIds(campaignId)).length).toBe(before - 1);
    const [row] = await exclusions(campaignId);
    expect(row).toMatchObject({ actor: "josh", actorKind: "ADMIN", opportunityId: target.id });
    expect(JSON.parse(row.detail!)).toMatchObject({ version: 1, opportunityId: target.id, reason: "ALREADY_INVITED", customerName: expect.any(String), opportunityName: expect.any(String) });
    // Nothing else changed: selection kept, routing record untouched, no new recipient.
    expect(await prisma.campaignSelection.count({ where: { campaignId, opportunityId: target.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } })).toBe(1);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(1);
  });

  it("no eligible contact: listed with that reason and excludable", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    expect((await getCampaignSummary(campaignId))!.needsReview).toEqual([expect.objectContaining({ reason: "NO_ELIGIBLE_CONTACT" })]);
    expect(await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh")).toEqual({ ok: true });
    expect(await getUnreachedOpportunityIds(campaignId)).toEqual([]);
  });

  it("routing changed: listed as contact changed and excludable", async () => {
    const { campaignId, target, jane } = await shortfallCampaign();
    const other = await prisma.externalContact.findFirstOrThrow({ where: { id: { notIn: [jane, target.contactId!] } } });
    await prisma.opportunity.update({ where: { id: target.id }, data: { contactId: other.id } });
    expect((await getCampaignSummary(campaignId))!.needsReview).toEqual([expect.objectContaining({ reason: "CONTACT_CHANGED" })]);
    expect(await render(campaignId)).toContain("Contact changed since launch");
    expect(await excludeShortfallOpportunity(campaignId, target.id, "CONTACT_CHANGED", "josh")).toEqual({ ok: true });
  });

  it("last blocker: excluding it closes the campaign and the page lists it as excluded", async () => {
    const { campaignId, target, jane } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { contactId: jane } });
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { completedAt: new Date() } });
    expect(await status(campaignId)).toBe("IN_PROGRESS");
    await excludeShortfallOpportunity(campaignId, target.id, "ALREADY_INVITED", "josh");
    expect(await status(campaignId)).toBe("COMPLETE");
    const html = await render(campaignId);
    expect(html).toContain("Excluded from this campaign");
    expect(html).toContain("Contact already has an invitation");
    expect(html).toContain("excluded by josh");
  });

  it("recoverable: no control, and a posted exclude writes nothing", async () => {
    const { campaignId, target } = await shortfallCampaign();
    expect((await getCampaignSummary(campaignId))!.recoverableCount).toBe(1);
    expect(await excludeButtons(campaignId)).toHaveLength(0);
    expect(await excludeShortfallOpportunity(campaignId, target.id, "CONTACT_CHANGED", "josh"))
      .toEqual({ ok: false, message: SHORTFALL_EXCLUDE_REFUSALS.RECOVERABLE });
    expect(await exclusions(campaignId)).toHaveLength(0);
  });

  it("already excluded, reached, or not selected: refused with nothing written", async () => {
    const { campaignId, target, jane } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { contactId: jane } });
    await excludeShortfallOpportunity(campaignId, target.id, "ALREADY_INVITED", "josh");
    expect(await excludeShortfallOpportunity(campaignId, target.id, "ALREADY_INVITED", "josh"))
      .toEqual({ ok: false, message: SHORTFALL_EXCLUDE_REFUSALS.GONE });
    const reached = await prisma.checkInOpportunity.findFirstOrThrow({ where: { recipient: { campaignId } } });
    expect(await excludeShortfallOpportunity(campaignId, reached.opportunityId, "ALREADY_INVITED", "josh"))
      .toEqual({ ok: false, message: SHORTFALL_EXCLUDE_REFUSALS.GONE });
    expect(await excludeShortfallOpportunity(campaignId, "not-selected", "ALREADY_INVITED", "josh"))
      .toEqual({ ok: false, message: SHORTFALL_EXCLUDE_REFUSALS.GONE });
    expect(await exclusions(campaignId)).toHaveLength(1);
  });

  it("a reason that changed since the page loaded is refused", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    expect(await excludeShortfallOpportunity(campaignId, target.id, "ALREADY_INVITED", "josh"))
      .toEqual({ ok: false, message: SHORTFALL_EXCLUDE_REFUSALS.CHANGED });
    expect(await exclusions(campaignId)).toHaveLength(0);
  });

  it("legacy campaign without a routing record: no control, posted exclude refused", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await prisma.auditEvent.deleteMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
    expect(await excludeButtons(campaignId)).toHaveLength(0);
    expect(await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh"))
      .toEqual({ ok: false, message: SHORTFALL_EXCLUDE_REFUSALS.NO_ROUTING });
    expect(await exclusions(campaignId)).toHaveLength(0);
  });

  it("a campaign that is not IN_PROGRESS is refused", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETE" } });
    expect(await excludeButtons(campaignId)).toHaveLength(0);
    expect(await excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "josh"))
      .toEqual({ ok: false, message: SHORTFALL_EXCLUDE_REFUSALS.NOT_IN_PROGRESS });
    expect(await exclusions(campaignId)).toHaveLength(0);
  });

  it("bad input throws and writes nothing", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await expect(excludeShortfallOpportunity(campaignId, target.id, "WHATEVER" as never, "josh")).rejects.toThrow();
    expect(await exclusions(campaignId)).toHaveLength(0);
  });

  it("excluding a drifted sibling releases the held-back one, and Resume sends only it", async () => {
    await refreshCatalogFromSalesforce("test");
    const all = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
      select: { id: true, contactId: true, contact: { select: { name: true } } },
    });
    const mine = all.filter((o) => o.contact!.name === FIRST);
    const counts = new Map<string, number>();
    for (const o of all) if (o.contact!.name !== FIRST) counts.set(o.contactId!, (counts.get(o.contactId!) ?? 0) + 1);
    const shared = [...counts].find(([, n]) => n >= 2)![0];
    const [drifted, kept] = all.filter((o) => o.contactId === shared);
    const { campaignId } = await launchCampaign({ opportunityIds: mine.map((o) => o.id), name: "Siblings", period: "Test", actor: "test" });
    await prisma.campaignSelection.createMany({ data: [drifted, kept].map((o) => ({ campaignId, opportunityId: o.id })) });
    await prisma.auditEvent.updateMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING }, data: {
      detail: JSON.stringify({ version: 1, routes: Object.fromEntries([...mine, drifted, kept].map((o) => [o.id, o.contactId])) }),
    } });
    const elsewhere = await prisma.externalContact.findFirstOrThrow({ where: { id: { notIn: [shared, mine[0].contactId!] } } });
    await prisma.opportunity.update({ where: { id: drifted.id }, data: { contactId: elsewhere.id } });

    const reasons = Object.fromEntries((await getCampaignSummary(campaignId))!.needsReview.map((r) => [r.opportunityId, r.reason]));
    expect(reasons).toEqual({ [drifted.id]: "CONTACT_CHANGED", [kept.id]: "HELD_BACK" });
    expect(await render(campaignId)).toContain("Waiting on another opportunity for this contact");
    expect(await getRecoverableOpportunityIds(campaignId)).toEqual([]);

    expect(await excludeShortfallOpportunity(campaignId, drifted.id, "CONTACT_CHANGED", "josh")).toEqual({ ok: true });
    expect(await getRecoverableOpportunityIds(campaignId)).toEqual([kept.id]);
    const before = await prisma.emailMessage.count({ where: { campaignId, kind: "INVITE" } });
    expect((await resumeLaunch(campaignId, "josh")).emailsSent).toBe(1);
    expect(await prisma.emailMessage.count({ where: { campaignId, kind: "INVITE" } })).toBe(before + 1);
    const recipient = await prisma.checkInRecipient.findFirstOrThrow({ where: { campaignId, contactId: shared }, include: { items: true } });
    expect(recipient.items.map((i) => i.opportunityId)).toEqual([kept.id]);
    expect(await prisma.checkInRecipient.count({ where: { campaignId, contactId: elsewhere.id } })).toBe(0);
    expect(await prisma.checkInOpportunity.count({ where: { opportunityId: drifted.id, recipient: { campaignId } } })).toBe(0);
  });

  it("two simultaneous excludes of one opportunity record exactly one audit row", async () => {
    const { campaignId, target } = await shortfallCampaign();
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    const results = await Promise.all([
      excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "a"),
      excludeShortfallOpportunity(campaignId, target.id, "NO_ELIGIBLE_CONTACT", "b"),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await exclusions(campaignId)).toHaveLength(1);
  });

  describe("the server action", () => {
    beforeEach(() => {
      vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
      session.current = { user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" } };
      session.revalidated.length = 0;
    });
    afterEach(() => { vi.unstubAllEnvs(); session.current = null; });

    it("the action the page binds excludes the row it was rendered for and revalidates", async () => {
      const { campaignId, target } = await shortfallCampaign();
      await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
      const [button] = await excludeButtons(campaignId);
      expect(await button.action()).toBeUndefined();
      const [row] = await exclusions(campaignId);
      expect(row.opportunityId).toBe(target.id);
      expect(row.actor).not.toBe("admin");
      expect(session.revalidated).toEqual(expect.arrayContaining([`/admin/campaigns/${campaignId}`, "/admin"]));
      expect(await button.action()).toEqual({ error: SHORTFALL_EXCLUDE_REFUSALS.GONE });
    });

    it("a non-admin caller throws and nothing is written", async () => {
      const { campaignId, target } = await shortfallCampaign();
      await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
      session.current = null;
      await expect(excludeShortfallAction(campaignId, target.id, "NO_ELIGIBLE_CONTACT")).rejects.toThrow();
      expect(await exclusions(campaignId)).toHaveLength(0);
    });
  });
});
