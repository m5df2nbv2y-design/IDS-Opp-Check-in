import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { deriveSendState, isSelectable, isSendable } from "@/lib/send-states";
import {
  clearSelections,
  getDraftSummary,
  getOrCreateDraft,
  getReviewRecipients,
  listDraftAccounts,
  sendDraft,
  setSelection,
  validateSelection,
} from "@/server/services/campaign-draft-service";
import { launchCampaign } from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

/**
 * The safety property under test: discovery is never authorization to send.
 * An opportunity can only become sendable through a deliberate human selection,
 * and a needs-attention opportunity can never become sendable at all.
 */

describe("send state model", () => {
  it("requires explicit selection before anything is sendable", () => {
    expect(deriveSendState({ resolved: true, selected: false })).toBe("ELIGIBLE");
    expect(isSendable("ELIGIBLE")).toBe(false);

    expect(deriveSendState({ resolved: true, selected: true })).toBe("SELECTED");
    expect(isSendable("SELECTED")).toBe(true);
  });

  it("puts an unresolved opportunity beyond reach regardless of selection", () => {
    expect(deriveSendState({ resolved: false, selected: false })).toBe("NEEDS_ATTENTION");
    // Even if something tried to mark it selected, it stays unsendable.
    expect(deriveSendState({ resolved: false, selected: true })).toBe("NEEDS_ATTENTION");
    expect(isSendable("NEEDS_ATTENTION")).toBe(false);
    expect(isSelectable("NEEDS_ATTENTION")).toBe(false);
  });

  it("advances through queued and sent once launched", () => {
    expect(deriveSendState({ resolved: true, selected: true, queued: true })).toBe("QUEUED");
    expect(deriveSendState({ resolved: true, selected: true, sent: true })).toBe("SENT");
    expect(isSendable("QUEUED")).toBe(false);
    expect(isSendable("SENT")).toBe(false);
  });
});

describe("campaign draft selection", () => {
  let campaignId: string;

  beforeAll(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    const draft = await getOrCreateDraft("test");
    campaignId = draft.id;
  });

  beforeEach(async () => {
    await clearSelections(campaignId);
  });

  it("reuses a single draft rather than creating a second one", async () => {
    const again = await getOrCreateDraft("test");
    expect(again.id).toBe(campaignId);
    expect(await prisma.campaign.count({ where: { status: "DRAFT" } })).toBe(1);
  });

  it("starts with nothing selected — discovery alone authorizes nothing", async () => {
    const summary = await getDraftSummary(campaignId);
    expect(summary.selectedOpportunities).toBe(0);

    const accounts = await listDraftAccounts(campaignId);
    expect(accounts.length).toBeGreaterThan(0);
    for (const account of accounts) {
      expect(account.selectedCount).toBe(0);
      expect(account.checkboxState).toBe("unchecked");
      for (const row of account.opportunities) {
        expect(row.selected).toBe(false);
        expect(row.state === "ELIGIBLE" || row.state === "NEEDS_ATTENTION").toBe(true);
      }
    }
  });

  it("REFUSES to select a needs-attention opportunity", async () => {
    const unresolved = await prisma.opportunity.findFirstOrThrow({
      where: { isOpen: true, resolutionStatus: "UNRESOLVED" },
    });

    await setSelection({ campaignId, opportunityIds: [unresolved.id], selected: true });

    expect(
      await prisma.campaignSelection.count({ where: { campaignId, opportunityId: unresolved.id } }),
    ).toBe(0);
    expect((await getDraftSummary(campaignId)).selectedOpportunities).toBe(0);
  });

  it("selects and deselects individual opportunities", async () => {
    const resolved = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
      take: 3,
    });

    await setSelection({ campaignId, opportunityIds: resolved.map((o) => o.id), selected: true });
    expect((await getDraftSummary(campaignId)).selectedOpportunities).toBe(3);

    await setSelection({ campaignId, opportunityIds: [resolved[0].id], selected: false });
    expect((await getDraftSummary(campaignId)).selectedOpportunities).toBe(2);
  });

  it("survives a reload — selections are persisted, not client state", async () => {
    const resolved = await prisma.opportunity.findFirstOrThrow({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
    });
    await setSelection({ campaignId, opportunityIds: [resolved.id], selected: true });

    // A completely fresh read, as a page load would do.
    const accounts = await listDraftAccounts(campaignId);
    const row = accounts.flatMap((a) => a.opportunities).find((o) => o.id === resolved.id);
    expect(row?.selected).toBe(true);
    expect(row?.state).toBe("SELECTED");
  });

  it("drives the three-state account checkbox from opportunity selections", async () => {
    const account = (await listDraftAccounts(campaignId)).find((a) => a.selectableCount > 1);
    expect(account).toBeDefined();
    if (!account) return;

    const selectable = account.opportunities.filter((o) => o.selectable);

    await setSelection({ campaignId, opportunityIds: [selectable[0].id], selected: true });
    let refreshed = (await listDraftAccounts(campaignId)).find((a) => a.accountId === account.accountId)!;
    expect(refreshed.checkboxState).toBe("indeterminate");

    await setSelection({ campaignId, opportunityIds: selectable.map((o) => o.id), selected: true });
    refreshed = (await listDraftAccounts(campaignId)).find((a) => a.accountId === account.accountId)!;
    expect(refreshed.checkboxState).toBe("checked");
    // "Checked" means only the sendable ones — never the needs-attention rows.
    expect(refreshed.selectedCount).toBe(refreshed.selectableCount);
  });

  it("selecting an account never includes its needs-attention opportunities", async () => {
    const account = (await listDraftAccounts(campaignId)).find((a) => a.needsAttentionCount > 0);
    expect(account).toBeDefined();
    if (!account) return;

    // Deliberately pass EVERY opportunity id, including the unsendable ones.
    await setSelection({
      campaignId,
      opportunityIds: account.opportunities.map((o) => o.id),
      selected: true,
    });

    const refreshed = (await listDraftAccounts(campaignId)).find((a) => a.accountId === account.accountId)!;
    expect(refreshed.selectedCount).toBe(refreshed.selectableCount);
    for (const row of refreshed.opportunities) {
      if (!row.selectable) expect(row.selected).toBe(false);
    }
  });

  it("groups the review by recipient, one email per contact", async () => {
    const marcus = await prisma.externalContact.findFirstOrThrow({
      where: { name: "Marcus Webb" },
      include: { opportunities: { where: { isOpen: true, resolutionStatus: "RESOLVED" } } },
    });
    await setSelection({
      campaignId,
      opportunityIds: marcus.opportunities.map((o) => o.id),
      selected: true,
    });

    const recipients = await getReviewRecipients(campaignId);
    expect(recipients).toHaveLength(1);
    expect(recipients[0].contactName).toBe("Marcus Webb");
    expect(recipients[0].opportunities).toHaveLength(marcus.opportunities.length);

    const summary = await getDraftSummary(campaignId);
    expect(summary.selectedContacts).toBe(1);
    expect(summary.selectedAccounts).toBe(1);
  });

  it("filters by search, owner and status without changing what is selected", async () => {
    const resolved = await prisma.opportunity.findFirstOrThrow({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
      include: { account: true },
    });
    await setSelection({ campaignId, opportunityIds: [resolved.id], selected: true });

    const byName = await listDraftAccounts(campaignId, { search: resolved.account.name });
    expect(byName.every((a) => a.accountName.includes(resolved.account.name))).toBe(true);

    const onlySelected = await listDraftAccounts(campaignId, { status: "selected" });
    expect(onlySelected.flatMap((a) => a.opportunities)).toHaveLength(1);

    const needsAttention = await listDraftAccounts(campaignId, { status: "needs_attention" });
    expect(needsAttention.flatMap((a) => a.opportunities).every((o) => !o.selectable)).toBe(true);

    // Filtering is a view concern — the selection itself is untouched.
    expect((await getDraftSummary(campaignId)).selectedOpportunities).toBe(1);
  });

  it("clears every selection on request", async () => {
    const resolved = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
      take: 4,
    });
    await setSelection({ campaignId, opportunityIds: resolved.map((o) => o.id), selected: true });
    expect((await getDraftSummary(campaignId)).selectedOpportunities).toBe(4);

    await clearSelections(campaignId);
    expect((await getDraftSummary(campaignId)).selectedOpportunities).toBe(0);
  });

  it("never writes selection state to the mock Salesforce org", async () => {
    const before = await prisma.mockSalesforceOpportunity.findMany({
      select: { externalId: true, stageName: true, lastModifiedAt: true },
      orderBy: { externalId: "asc" },
    });

    const resolved = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
      take: 5,
    });
    await setSelection({ campaignId, opportunityIds: resolved.map((o) => o.id), selected: true });

    const after = await prisma.mockSalesforceOpportunity.findMany({
      select: { externalId: true, stageName: true, lastModifiedAt: true },
      orderBy: { externalId: "asc" },
    });
    expect(after).toEqual(before);
  });
});

describe("selection drift and selected-only sending", () => {
  let campaignId: string;

  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
    const draft = await getOrCreateDraft("test");
    campaignId = draft.id;
  });

  async function selectResolved(take: number) {
    const opportunities = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
      include: { contact: true },
      take,
    });
    await setSelection({ campaignId, opportunityIds: opportunities.map((o) => o.id), selected: true });
    return opportunities;
  }

  it("sends ONLY the selected opportunities, never the whole catalog", async () => {
    const totalResolved = await prisma.opportunity.count({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
    });
    const selected = await selectResolved(3);
    expect(totalResolved).toBeGreaterThan(selected.length);

    const result = await sendDraft(campaignId, "test");

    expect(result.sent).toBe(3);
    expect(result.drifted).toEqual([]);

    const items = await prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId } },
    });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.opportunityId))).toEqual(new Set(selected.map((o) => o.id)));
  });

  it("excludes an opportunity CLOSED after selection", async () => {
    const [first, ...rest] = await selectResolved(3);
    await prisma.opportunity.update({ where: { id: first.id }, data: { isOpen: false } });

    const validation = await validateSelection(campaignId);
    expect(validation.sendableOpportunityIds).not.toContain(first.id);
    expect(validation.drifted.map((d) => d.reason)).toContain("OPPORTUNITY_CLOSED");

    const result = await sendDraft(campaignId, "test");
    expect(result.sent).toBe(rest.length);
    const items = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId } } });
    expect(items.map((i) => i.opportunityId)).not.toContain(first.id);
  });

  it("excludes an opportunity whose PRIMARY CONTACT ROLE was removed", async () => {
    const [first] = await selectResolved(2);
    await prisma.opportunity.update({
      where: { id: first.id },
      data: { contactId: null, resolutionStatus: "UNRESOLVED", resolutionReason: "NO_PRIMARY_CONTACT_ROLE" },
    });

    const validation = await validateSelection(campaignId);
    expect(validation.drifted).toContainEqual(
      expect.objectContaining({ opportunityId: first.id, reason: "NO_PRIMARY_CONTACT_ROLE" }),
    );

    const result = await sendDraft(campaignId, "test");
    expect(result.drifted).toHaveLength(1);
    const items = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId } } });
    expect(items.map((i) => i.opportunityId)).not.toContain(first.id);
  });

  it("excludes an opportunity whose primary contact LOST THEIR EMAIL", async () => {
    const [first] = await selectResolved(2);
    await prisma.externalContact.update({
      where: { id: first.contactId! },
      data: { email: "" },
    });

    const validation = await validateSelection(campaignId);
    expect(validation.drifted).toContainEqual(
      expect.objectContaining({ opportunityId: first.id, reason: "PRIMARY_CONTACT_NO_EMAIL" }),
    );

    const result = await sendDraft(campaignId, "test");
    const items = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId } } });
    expect(items.map((i) => i.opportunityId)).not.toContain(first.id);
    // Every opportunity routed to that contact drifts, not just the first —
    // the contact is the unit of delivery.
    expect(result.drifted.length).toBeGreaterThanOrEqual(1);
    for (const entry of result.drifted) {
      expect(entry.reason).toBe("PRIMARY_CONTACT_NO_EMAIL");
    }
  });

  it("NEVER substitutes another contact when a selection drifts", async () => {
    const [first] = await selectResolved(1);
    const accountId = (await prisma.opportunity.findUniqueOrThrow({ where: { id: first.id } })).accountId;
    // Leave a perfectly good alternative contact at the same account.
    const alternatives = await prisma.externalContact.count({
      where: { accountId, email: { not: "" } },
    });
    expect(alternatives).toBeGreaterThan(0);

    await prisma.opportunity.update({
      where: { id: first.id },
      data: { contactId: null, resolutionStatus: "UNRESOLVED", resolutionReason: "NO_PRIMARY_CONTACT_ROLE" },
    });

    const result = await sendDraft(campaignId, "test");
    expect(result.sent).toBe(0);
    expect(result.recipients).toBe(0);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(0);
  });

  it("records drifted exclusions in the audit trail", async () => {
    const [first] = await selectResolved(2);
    await prisma.opportunity.update({ where: { id: first.id }, data: { isOpen: false } });
    await sendDraft(campaignId, "test");

    const events = await prisma.auditEvent.findMany({
      where: { campaignId, summary: { contains: "excluded at send" } },
    });
    expect(events).toHaveLength(1);
  });

  it("sends nothing at all when every selection has drifted", async () => {
    const selected = await selectResolved(2);
    await prisma.opportunity.updateMany({
      where: { id: { in: selected.map((o) => o.id) } },
      data: { isOpen: false },
    });

    const result = await sendDraft(campaignId, "test");
    expect(result.sent).toBe(0);
    expect(result.drifted).toHaveLength(2);
    expect(await prisma.checkInRecipient.count({ where: { campaignId } })).toBe(0);
    // The campaign must not be marked launched when nothing was sent.
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.status).toBe("DRAFT");
  });

  it("captures the close date for the future write-back without writing it", async () => {
    await selectResolved(2);
    await sendDraft(campaignId, "test");

    const items = await prisma.checkInOpportunity.findMany({ where: { recipient: { campaignId } } });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      // Snapshotted from Salesforce…
      expect(item.previousCloseDate).not.toBeNull();
      // …but nothing has been captured or written for the new value yet.
      expect(item.updatedCloseDate).toBeNull();
    }
  });

  it("writes nothing to Salesforce when sending", async () => {
    const before = await prisma.mockSalesforceOpportunity.findMany({
      select: { externalId: true, stageName: true, description: true, lastModifiedAt: true },
      orderBy: { externalId: "asc" },
    });

    await selectResolved(3);
    await sendDraft(campaignId, "test");

    const after = await prisma.mockSalesforceOpportunity.findMany({
      select: { externalId: true, stageName: true, description: true, lastModifiedAt: true },
      orderBy: { externalId: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("routes messages to the mock outbox rather than a real provider", async () => {
    await selectResolved(2);
    await sendDraft(campaignId, "test");

    const emails = await prisma.emailMessage.findMany({ where: { campaignId } });
    expect(emails.length).toBeGreaterThan(0);
    for (const message of emails) expect(message.provider).toBe("mock");
  });
});

describe("launchCampaign has no whole-catalog fallback", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  /**
   * The loaded gun: an earlier version treated an omitted opportunityIds as
   * "every resolved opportunity", so a single missing argument would have
   * contacted the entire catalog. The list is now required at the type
   * boundary AND re-checked at runtime, because a compiler guarantee does not
   * survive a bad cast, a JavaScript caller, or a deserialized payload.
   */
  it("THROWS rather than sending to everyone when the selection is omitted", async () => {
    const resolved = await prisma.opportunity.count({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
    });
    expect(resolved).toBeGreaterThan(0);

    await expect(
      // Deliberately bypassing the type system, as a careless caller would.
      (launchCampaign as (options?: unknown) => Promise<unknown>)({
        name: "Should never launch",
        actor: "test",
      }),
    ).rejects.toThrow(/requires an explicit opportunityIds/);

    // Nothing was created — no campaign, no recipients, no email.
    expect(await prisma.checkInRecipient.count()).toBe(0);
    expect(await prisma.emailMessage.count()).toBe(0);
    expect(await prisma.campaign.count({ where: { status: "IN_PROGRESS" } })).toBe(0);
  });

  it("THROWS when called with no arguments at all", async () => {
    await expect(
      (launchCampaign as (options?: unknown) => Promise<unknown>)(),
    ).rejects.toThrow(/requires an explicit opportunityIds/);

    expect(await prisma.checkInRecipient.count()).toBe(0);
    expect(await prisma.emailMessage.count()).toBe(0);
  });

  it("THROWS when opportunityIds is not an array", async () => {
    for (const bad of [null, undefined, "all", 42, {}]) {
      await expect(
        (launchCampaign as (options?: unknown) => Promise<unknown>)({
          opportunityIds: bad,
          actor: "test",
        }),
      ).rejects.toThrow(/requires an explicit opportunityIds/);
    }
    expect(await prisma.checkInRecipient.count()).toBe(0);
  });

  it("sends nothing for an empty selection — explicit, and still not everyone", async () => {
    const result = await launchCampaign({ opportunityIds: [], actor: "test" });

    expect(result.opportunities).toBe(0);
    expect(result.recipients).toBe(0);
    expect(await prisma.checkInRecipient.count()).toBe(0);
    expect(await prisma.emailMessage.count()).toBe(0);
  });

  it("sends to exactly the selection it is given, never more", async () => {
    const all = await prisma.opportunity.findMany({
      where: { isOpen: true, resolutionStatus: "RESOLVED" },
      select: { id: true },
    });
    const chosen = all.slice(0, 2);

    const result = await launchCampaign({
      opportunityIds: chosen.map((o) => o.id),
      actor: "test",
    });

    expect(result.opportunities).toBe(2);
    const items = await prisma.checkInOpportunity.findMany({ select: { opportunityId: true } });
    expect(new Set(items.map((i) => i.opportunityId))).toEqual(new Set(chosen.map((o) => o.id)));
    expect(all.length).toBeGreaterThan(chosen.length);
  });
});
