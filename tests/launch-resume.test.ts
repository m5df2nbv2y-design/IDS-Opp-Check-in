import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { approveLegacyRoutingAction, resumeLaunchAction, sendDraftAction } from "@/app/admin/actions";
import { getOrCreateDraft, setSelection } from "@/server/services/campaign-draft-service";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { approveLegacyRouting, CampaignChangedError, getLegacyRoutingPreview, getUnreachedOpportunityIds, legacyShownRoutes, launchCampaign, resumeLaunch } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { getEmailService } from "@/server/integrations/email";
import { resetDatabase } from "./fixtures";

const session = vi.hoisted(() => ({ current: null as unknown, revalidated: [] as string[] }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => session.revalidated.push(path) }));

const FIRST = "Jane Doe";

/** A campaign launched for one contact, with every other contact selected but never reached. */
async function halfSentCampaign() {
  await refreshCatalogFromSalesforce("test");
  const all = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    select: { id: true, contactId: true, contact: { select: { name: true } } },
  });
  const mine = all.filter((o) => o.contact!.name === FIRST);
  const others = all.filter((o) => o.contact!.name !== FIRST);
  expect(mine.length).toBeGreaterThan(0);
  expect(others.length).toBeGreaterThan(0);
  const result = await launchCampaign({
    opportunityIds: mine.map((o) => o.id),
    name: "Resume",
    period: "Test",
    actor: "test",
  });
  await prisma.campaignSelection.createMany({
    data: others.map((o) => ({ campaignId: result.campaignId, opportunityId: o.id })),
  });
  // This fixture represents the approved routing checkpoint before an
  // interrupted launch; arbitrary selections appended later lack this evidence.
  await prisma.auditEvent.updateMany({ where: { campaignId: result.campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING }, data: {
    detail: JSON.stringify({ version: 1, routes: Object.fromEntries(all.map(o => [o.id, o.contactId])) }),
  } });
  return { campaignId: result.campaignId, mine, others, otherContacts: new Set(others.map((o) => o.contactId!)) };
}

const status = async (campaignId: string) =>
  (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status;

const invites = (campaignId: string) =>
  prisma.emailMessage.findMany({ where: { campaignId, kind: "INVITE" } });

describe("resume a half-sent launch", () => {
  beforeEach(resetDatabase);
  afterEach(() => vi.restoreAllMocks());

  it("resume emails only contacts that have no recipient row", async () => {
    const { campaignId, otherContacts } = await halfSentCampaign();
    const before = (await invites(campaignId)).length;
    const result = await resumeLaunch(campaignId, "test");
    expect(result.emailsSent).toBe(otherContacts.size);
    expect((await invites(campaignId)).length).toBe(before + otherContacts.size);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(otherContacts.size + 1);
  });

  it("resume never emails a contact that already has a recipient", async () => {
    const { campaignId } = await halfSentCampaign();
    await resumeLaunch(campaignId, "test");
    const jane = await prisma.externalContact.findFirstOrThrow({ where: { name: FIRST } });
    expect(await prisma.checkInRecipient.count({ where: { campaignId, contactId: jane.id } })).toBe(1);
    expect((await invites(campaignId)).filter((e) => e.toName === FIRST).length).toBe(1);
  });

  it("two simultaneous resumes send each missing contact once", async () => {
    const { campaignId, otherContacts } = await halfSentCampaign();
    await Promise.all([resumeLaunch(campaignId, "a"), resumeLaunch(campaignId, "b")]);
    expect((await invites(campaignId)).length).toBe(otherContacts.size + 1);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(otherContacts.size + 1);
  });

  it("an original launch skips a contact the resume already created instead of throwing", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    await prisma.checkInRecipient.create({
      data: {
        campaignId,
        contactId: target.contactId!,
        tokenHash: "resume-made",
        tokenHint: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const before = (await invites(campaignId)).length;
    const result = await launchCampaign({ opportunityIds: [target.id], campaignId, actor: "test" });
    expect(result.emailsSent).toBe(0);
    expect((await invites(campaignId)).length).toBe(before);
  });

  it("an old zero-item pending claim is preserved for reconciliation", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    const orphan = await prisma.checkInRecipient.create({
      data: {
        campaignId,
        contactId: target.contactId!,
        tokenHash: "orphan",
        tokenHint: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    await resumeLaunch(campaignId, "test");
    const rows = await prisma.checkInRecipient.findMany({
      where: { campaignId, contactId: target.contactId! },
      include: { items: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orphan.id);
    expect(rows[0].items).toHaveLength(0);
    expect(rows[0].sendStatus).toBe("PENDING");
  });

  it("resume refuses a campaign that is not IN_PROGRESS", async () => {
    const { campaignId } = await halfSentCampaign();
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DRAFT" } });
    await expect(resumeLaunch(campaignId, "test")).rejects.toThrow(/IN_PROGRESS/);
  });

  it("a fresh zero-item pending recipient is left alone (it may be mid-launch)", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    const fresh = await prisma.checkInRecipient.create({
      data: {
        campaignId,
        contactId: target.contactId!,
        tokenHash: "fresh",
        tokenHint: "x",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await resumeLaunch(campaignId, "test");
    expect(await prisma.checkInRecipient.findUnique({ where: { id: fresh.id } })).not.toBeNull();
  });

  it("a drifted-then-sendable selection never expands an existing invitation", async () => {
    const { campaignId, mine } = await halfSentCampaign();
    expect(mine.length).toBeGreaterThan(1);
    const gap = mine[1];
    await prisma.checkInOpportunity.deleteMany({ where: { opportunityId: gap.id, recipient: { campaignId } } });
    await prisma.opportunity.update({ where: { id: gap.id }, data: { isOpen: false } });
    expect((await resumeLaunch(campaignId, "test")).unreachedAfter).toBe(1);
    const reached = () =>
      prisma.checkInOpportunity.count({ where: { opportunityId: gap.id, recipient: { campaignId } } });
    expect(await reached()).toBe(0);
    await prisma.opportunity.update({ where: { id: gap.id }, data: { isOpen: true } });
    const before = (await invites(campaignId)).length;
    const after = await resumeLaunch(campaignId, "test");
    expect(await reached()).toBe(0);
    expect((await invites(campaignId)).length).toBe(before);
    expect(after.unreachedAfter).toBe(1);
    expect(await getUnreachedOpportunityIds(campaignId)).toEqual([gap.id]);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("IN_PROGRESS");
  });

  it.each([["completedAt"], ["revokedAt"]])(
    "a %s recipient gets nothing added and the shortfall is reported",
    async (field) => {
      const { campaignId, mine } = await halfSentCampaign();
      const gap = mine[1];
      await prisma.checkInOpportunity.deleteMany({ where: { opportunityId: gap.id, recipient: { campaignId } } });
      await prisma.checkInRecipient.updateMany({
        where: { campaignId, contact: { name: FIRST } },
        data: { [field]: new Date() },
      });
      const result = await resumeLaunch(campaignId, "test");
      expect(result.unreachedAfter).toBeGreaterThan(0);
      expect(
        await prisma.checkInOpportunity.count({ where: { opportunityId: gap.id, recipient: { campaignId } } }),
      ).toBe(0);
    },
  );

  it("routing changes to a new contact require review", async () => {
    const { campaignId, others, mine } = await halfSentCampaign();
    await prisma.opportunity.update({ where: { id: others[0].id }, data: { contactId: mine[0].contactId } });
    const result = await resumeLaunch(campaignId, "test");
    expect(result.unreachedAfter).toBeGreaterThan(0);
    expect(await prisma.checkInOpportunity.count({ where: { opportunityId: others[0].id, recipient: { campaignId } } })).toBe(0);
  });

  it("the routing record keeps the contact this launch grouped, even if it changes mid-launch", async () => {
    await refreshCatalogFromSalesforce("test");
    const all = await prisma.opportunity.findMany({ where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } } });
    const mine = all.filter((o) => o.contactId === all[0].contactId);
    const elsewhere = all.find((o) => o.contactId !== all[0].contactId)!.contactId!;
    // Between the launch's fetch and its routing record, a refresh moves one opportunity.
    const createMany = prisma.campaignSelection.createMany.bind(prisma.campaignSelection);
    vi.spyOn(prisma.campaignSelection, "createMany").mockImplementationOnce((async (args: Parameters<typeof createMany>[0]) => {
      const created = await createMany(args);
      await prisma.opportunity.update({ where: { id: mine[0].id }, data: { contactId: elsewhere } });
      return created;
    }) as never);

    const { campaignId } = await launchCampaign({ opportunityIds: mine.map((o) => o.id), name: "Drift", period: "Test", actor: "test" });

    const record = await prisma.auditEvent.findFirstOrThrow({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
    expect(JSON.parse(record.detail!).routes[mine[0].id]).toBe(all[0].contactId);
  });

  it("legacy routing without a checkpoint requires review", async () => {
    const { campaignId } = await halfSentCampaign();
    await prisma.auditEvent.deleteMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
    const before = (await invites(campaignId)).length;
    expect((await resumeLaunch(campaignId)).unreachedAfter).toBeGreaterThan(0);
    expect((await invites(campaignId)).length).toBe(before);
  });

  describe("legacy campaign launched before routing records", () => {
    async function legacyCampaign() {
      const fixture = await halfSentCampaign();
      await prisma.auditEvent.deleteMany({ where: { campaignId: fixture.campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });
      return fixture;
    }
    const shown = legacyShownRoutes;
    const routing = (campaignId: string) =>
      prisma.auditEvent.findMany({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_ROUTING } });

    it("approving current routing unblocks resume, never re-sends, and lets the campaign close", async () => {
      const { campaignId, mine, others, otherContacts } = await legacyCampaign();
      const rows = (await getLegacyRoutingPreview(campaignId))!;
      expect(rows.map((r) => r.opportunityId).sort()).toEqual(others.map((o) => o.id).sort());
      expect(await approveLegacyRouting(campaignId, shown(rows), "josh")).toEqual({ ok: true });
      const [record] = await routing(campaignId);
      expect(record.actor).toBe("josh");
      const routes = JSON.parse(record.detail!).routes;
      for (const o of [...mine, ...others]) expect(routes[o.id]).toBe(o.contactId);
      expect(await getLegacyRoutingPreview(campaignId)).toBeNull();

      const before = (await invites(campaignId)).length;
      const result = await resumeLaunch(campaignId, "josh");
      expect(result.emailsSent).toBe(otherContacts.size);
      expect((await invites(campaignId)).length).toBe(before + otherContacts.size);
      expect((await invites(campaignId)).filter((e) => e.toName === FIRST)).toHaveLength(1);
      await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { completedAt: new Date() } });
      await resumeLaunch(campaignId, "josh");
      expect(await status(campaignId)).toBe("COMPLETE");
    });

    it("a second approval is refused and the first record stands", async () => {
      const { campaignId } = await legacyCampaign();
      const rows = (await getLegacyRoutingPreview(campaignId))!;
      await approveLegacyRouting(campaignId, shown(rows), "josh");
      expect((await approveLegacyRouting(campaignId, shown(rows), "other")).ok).toBe(false);
      expect(await routing(campaignId)).toHaveLength(1);
    });

    it("a shown contact that changed before the click records nothing", async () => {
      const { campaignId, others, mine } = await legacyCampaign();
      const rows = (await getLegacyRoutingPreview(campaignId))!;
      await prisma.opportunity.update({ where: { id: others[0].id }, data: { contactId: mine[0].contactId } });
      expect((await approveLegacyRouting(campaignId, shown(rows), "josh")).ok).toBe(false);
      expect(await routing(campaignId)).toHaveLength(0);
    });

    it("is refused for a campaign that is not IN_PROGRESS", async () => {
      const { campaignId } = await legacyCampaign();
      const rows = (await getLegacyRoutingPreview(campaignId))!;
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETE" } });
      expect((await approveLegacyRouting(campaignId, shown(rows), "josh")).ok).toBe(false);
      expect(await routing(campaignId)).toHaveLength(0);
    });

    it("an unsent opportunity with no eligible contact is left out and stays unreached", async () => {
      const { campaignId, others } = await legacyCampaign();
      await prisma.opportunity.update({ where: { id: others[0].id }, data: { isOpen: false } });
      const rows = (await getLegacyRoutingPreview(campaignId))!;
      expect(rows.find((r) => r.opportunityId === others[0].id)).toMatchObject({ contactId: null });
      await approveLegacyRouting(campaignId, shown(rows), "josh");
      const [record] = await routing(campaignId);
      expect(Object.hasOwn(JSON.parse(record.detail!).routes, others[0].id)).toBe(false);
      await resumeLaunch(campaignId, "josh");
      expect(await getUnreachedOpportunityIds(campaignId)).toContain(others[0].id);
    });

    it("an unsent opportunity whose contact is already invited is routed but never added to that invitation", async () => {
      const { campaignId, others, mine } = await legacyCampaign();
      await prisma.opportunity.update({ where: { id: others[0].id }, data: { contactId: mine[0].contactId } });
      const rows = (await getLegacyRoutingPreview(campaignId))!;
      expect(rows.find((r) => r.opportunityId === others[0].id)).toMatchObject({ contactId: mine[0].contactId, alreadyInvited: true });
      await approveLegacyRouting(campaignId, shown(rows), "josh");
      await resumeLaunch(campaignId, "josh");
      expect(await prisma.checkInOpportunity.count({ where: { opportunityId: others[0].id, recipient: { campaignId } } })).toBe(0);
      expect((await invites(campaignId)).filter((e) => e.toName === FIRST)).toHaveLength(1);
    });

    it("a fully sent legacy campaign shows nothing to approve and still closes", async () => {
      const { campaignId, mine } = await legacyCampaign();
      // Fully sent: drop the never-reached selections, leaving only reached work.
      await prisma.campaignSelection.deleteMany({ where: { campaignId, opportunityId: { notIn: mine.map((o) => o.id) } } });
      expect(await getLegacyRoutingPreview(campaignId)).toEqual([]);
      await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { completedAt: new Date() } });
      await resumeLaunch(campaignId, "josh");
      expect(await status(campaignId)).toBe("COMPLETE");
      expect(await routing(campaignId)).toHaveLength(0);
    });

    it("two simultaneous approvals record exactly one routing row", async () => {
      const { campaignId } = await legacyCampaign();
      const rows = (await getLegacyRoutingPreview(campaignId))!;
      const results = await Promise.all([approveLegacyRouting(campaignId, shown(rows), "a"), approveLegacyRouting(campaignId, shown(rows), "b")]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await routing(campaignId)).toHaveLength(1);
    });

    it("the campaign page shows the panel with review labels until routing is approved", async () => {
      const { campaignId, others, mine } = await legacyCampaign();
      await prisma.opportunity.update({ where: { id: others[0].id }, data: { isOpen: false } });
      await prisma.opportunity.update({ where: { id: others[1].id }, data: { contactId: mine[0].contactId } });
      const page = async () => renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));
      const html = await page();
      expect(html).toContain("Approve routing");
      expect(html).toContain("no eligible contact");
      expect(html).toContain("already invited");
      expect(html).toContain("stays open until they are reviewed");
      await approveLegacyRouting(campaignId, shown((await getLegacyRoutingPreview(campaignId))!), "josh");
      expect(await page()).not.toContain("Approve routing");
    });

    describe("the server action", () => {
      beforeEach(() => {
        vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
        session.current = { user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" } };
        session.revalidated.length = 0;
      });
      afterEach(() => { vi.unstubAllEnvs(); session.current = null; });

      it("returns an error for stale routes, records nothing, and revalidates", async () => {
        const { campaignId, others, mine } = await legacyCampaign();
        const rows = (await getLegacyRoutingPreview(campaignId))!;
        await prisma.opportunity.update({ where: { id: others[0].id }, data: { contactId: mine[0].contactId } });
        const result = await approveLegacyRoutingAction(campaignId, shown(rows));
        expect(result).toEqual({ error: expect.stringContaining("changed since the page loaded") });
        expect(await routing(campaignId)).toHaveLength(0);
        expect(session.revalidated).toContain(`/admin/campaigns/${campaignId}`);
      });

      it("records the routing and revalidates on a valid call", async () => {
        const { campaignId } = await legacyCampaign();
        const rows = (await getLegacyRoutingPreview(campaignId))!;
        expect(await approveLegacyRoutingAction(campaignId, shown(rows))).toBeUndefined();
        const [record] = await routing(campaignId);
        expect(record.actor).not.toBe("admin");
        expect(session.revalidated).toContain(`/admin/campaigns/${campaignId}`);
      });
    });

    it("a campaign with a routing record gets no preview", async () => {
      const { campaignId } = await halfSentCampaign();
      expect(await getLegacyRoutingPreview(campaignId)).toBeNull();
      expect((await approveLegacyRouting(campaignId, {}, "josh")).ok).toBe(false);
    });
  });

  it("resume with nothing unreached returns a zero result and writes no audit row", async () => {
    const { campaignId } = await halfSentCampaign();
    await resumeLaunch(campaignId, "test");
    const audits = () => prisma.auditEvent.count({ where: { campaignId, type: AUDIT_EVENTS.CAMPAIGN_CREATED } });
    const before = await audits();
    const result = await resumeLaunch(campaignId, "test");
    expect(result).toMatchObject({ emailsSent: 0, recipients: 0, opportunities: 0, unreachedAfter: 0 });
    expect(await audits()).toBe(before);
  });

  it("a unique violation on another target is rethrown, not swallowed", async () => {
    const { campaignId } = await halfSentCampaign();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "P2002", meta: { target: ["tokenHash"] } }),
    );
    await expect(resumeLaunch(campaignId, "test")).rejects.toThrow("dup");
  });

  const adapterConflict = (fields: string[]) =>
    Object.assign(new Error("dup"), { code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields } } } } });

  it("a unique violation reported only as constraint fields is a claim conflict when it is (campaignId, contactId)", async () => {
    const { campaignId, otherContacts } = await halfSentCampaign();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(adapterConflict(["campaignId", "contactId"]));
    await expect(resumeLaunch(campaignId, "test")).resolves.toBeDefined();
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(otherContacts.size);
  });

  it("a unique violation reported only as constraint fields is rethrown when it is another target", async () => {
    const { campaignId } = await halfSentCampaign();
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(adapterConflict(["tokenHash"]));
    await expect(resumeLaunch(campaignId, "test")).rejects.toThrow("dup");
  });

  it("a drifted-then-sendable opportunity of a never-launched contact gets a fresh recipient and exactly one invite", async () => {
    const { campaignId, others } = await halfSentCampaign();
    const target = others[0];
    await prisma.campaignSelection.deleteMany({ where: { campaignId, opportunityId: { not: target.id } } });
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: false } });
    await resumeLaunch(campaignId, "test");
    expect(await prisma.checkInRecipient.count({ where: { campaignId, contactId: target.contactId! } })).toBe(0);
    await prisma.opportunity.update({ where: { id: target.id }, data: { isOpen: true } });
    await resumeLaunch(campaignId, "test");
    expect(await prisma.checkInRecipient.count({ where: { campaignId, contactId: target.contactId! } })).toBe(1);
    const toTarget = async () => (await invites(campaignId)).filter((e) => e.toName === target.contact!.name);
    expect(await toTarget()).toHaveLength(1);
    await resumeLaunch(campaignId, "test");
    expect(await toTarget()).toHaveLength(1);
  });

  it("resume closes a campaign whose recipients are all complete and every selection is reached", async () => {
    const { campaignId } = await halfSentCampaign();
    await resumeLaunch(campaignId, "test");
    expect(await status(campaignId)).toBe("IN_PROGRESS");
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { completedAt: new Date() } });
    await resumeLaunch(campaignId, "test");
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(after.status).toBe("COMPLETE");
    expect(after.completedAt).not.toBeNull();
  });

  it("resume keeps the campaign open while a persisted selection is still missing", async () => {
    const { campaignId, others } = await halfSentCampaign();
    await prisma.checkInRecipient.updateMany({ where: { campaignId }, data: { completedAt: new Date() } });
    await prisma.opportunity.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { isOpen: false } });
    const result = await resumeLaunch(campaignId, "test");
    expect(result.unreachedAfter).toBeGreaterThan(0);
    expect(await status(campaignId)).toBe("IN_PROGRESS");
  });

  describe("resumeLaunchAction", () => {
    beforeEach(() => {
      vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
      session.current = { user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" } };
      session.revalidated.length = 0;
    });
    afterEach(() => { vi.unstubAllEnvs(); session.current = null; });

    it("a campaign that closed before the click returns a message, not the error page, and refreshes", async () => {
      const { campaignId } = await halfSentCampaign();
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETE" } });
      const before = (await invites(campaignId)).length;
      expect(await resumeLaunchAction(campaignId)).toEqual({ error: "Only an IN_PROGRESS campaign can be resumed." });
      expect(session.revalidated).toEqual(expect.arrayContaining([`/admin/campaigns/${campaignId}`, "/admin/outbox"]));
      expect((await invites(campaignId)).length).toBe(before);
    });

    it("a campaign closed while invitations are going out stops the rest and returns a message", async () => {
      const { campaignId, otherContacts } = await halfSentCampaign();
      expect(otherContacts.size).toBeGreaterThan(1);
      const before = (await invites(campaignId)).length;
      const original = getEmailService().send.bind(getEmailService());
      vi.spyOn(getEmailService(), "send").mockImplementation(async (message) => {
        const result = await original(message);
        await prisma.campaign.update({ where: { id: campaignId }, data: { status: "COMPLETE" } });
        return result;
      });
      const result = await resumeLaunchAction(campaignId);
      expect(result).toEqual({ error: expect.stringMatching(/no longer in progress/) });
      expect((await invites(campaignId)).length).toBe(before + 1);
      expect(session.revalidated).toEqual(expect.arrayContaining([`/admin/campaigns/${campaignId}`, "/admin/outbox"]));
    });

    it("sendDraftAction returns the same refusal when the campaign closes mid-send", async () => {
      await refreshCatalogFromSalesforce("test");
      const all = await prisma.opportunity.findMany({ where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } }, select: { id: true, contactId: true } });
      expect(new Set(all.map((o) => o.contactId)).size).toBeGreaterThan(1);
      const draft = await getOrCreateDraft("josh");
      await setSelection({ campaignId: draft.id, opportunityIds: all.map((o) => o.id), selected: true });
      const original = getEmailService().send.bind(getEmailService());
      vi.spyOn(getEmailService(), "send").mockImplementation(async (message) => {
        const result = await original(message);
        await prisma.campaign.update({ where: { id: draft.id }, data: { status: "COMPLETE" } });
        return result;
      });
      const { emailRevision } = await prisma.campaign.findUniqueOrThrow({ where: { id: draft.id } });
      expect(await sendDraftAction(draft.id, emailRevision)).toEqual({ error: expect.stringMatching(/no longer in progress/) });
      expect((await invites(draft.id)).length).toBe(1);
    });

    it("an unexpected error still throws", async () => {
      const thrown = await resumeLaunchAction("no-such-campaign").catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CampaignChangedError);
    });

    it("a successful resume returns nothing", async () => {
      const { campaignId } = await halfSentCampaign();
      expect(await resumeLaunchAction(campaignId)).toBeUndefined();
      expect(session.revalidated).toContain(`/admin/campaigns/${campaignId}`);
    });
  });
});
