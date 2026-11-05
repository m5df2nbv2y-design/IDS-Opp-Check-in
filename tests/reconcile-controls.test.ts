import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileUncertainAction } from "@/app/admin/actions";
import CampaignDetailPage from "@/app/admin/campaigns/[id]/page";
import {
  RECONCILE_FAILED_MESSAGE,
  ReconcileControls,
  ReconcileControlsView,
  runReconcile,
} from "@/components/admin/reconcile-controls";
import { prisma } from "@/lib/db";
import { UnauthorizedError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import { anUncertainItem, resetDatabase } from "./fixtures";

/**
 * The recovery UI: what an administrator sees when an attestation is refused,
 * in flight, or done.
 *
 * There is no DOM library in this project, so the control is split the way the
 * tests need it: `runReconcile` and `ReconcileControlsView` are pure and render
 * to static markup, and the real campaign page is rendered against a real
 * database for the parts that must survive a reload.
 */

const session = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/server/auth/config", () => ({ auth: async () => session.current, DEV_BYPASS_ENABLED: false }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const ADMIN = {
  user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "entra-oid-1" },
};

afterEach(() => vi.restoreAllMocks());

describe("runReconcile", () => {
  it("returns no notice when the attestation was recorded", async () => {
    expect(await runReconcile(async () => ({ ok: true }))).toBeNull();
  });

  it("returns the refusal's own fixed message", async () => {
    const refusal = { ok: false, reason: "STALE", message: "This response changed." } as const;
    expect(await runReconcile(async () => refusal)).toBe("This response changed.");
  });

  it.each([
    ["an unexpected failure", new Error('duplicate key value violates unique constraint "CheckInOpportunity_pkey" (token SECRET123)')],
    ["an authorization failure", new UnauthorizedError()],
    ["a rejection that is not an Error", "SECRET123 from the provider"],
  ])("shows one generic fixed message for %s, never the thrown text", async (_label, thrown) => {
    const notice = await runReconcile(async () => {
      throw thrown;
    });

    expect(notice).toBe(RECONCILE_FAILED_MESSAGE);
    expect(notice).not.toContain("SECRET123");
  });
});

describe("ReconcileControlsView", () => {
  const view = (props: Partial<Parameters<typeof ReconcileControlsView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ReconcileControlsView, { pending: null, notice: null, onChoose: () => {}, onReload: () => {}, ...props }),
    );
  const disabledCount = (html: string) => (html.match(/disabled=""/g) ?? []).length;

  it("offers both outcomes, enabled, with nothing to read yet", () => {
    const html = view();

    expect(html).toContain("It is in Salesforce");
    expect(html).toContain("It is not there");
    expect(disabledCount(html)).toBe(0);
    expect(html).not.toContain("Reload");
    expect(html).toContain('aria-live="polite"'); // present before any message, so one is announced when it appears
  });

  it.each([
    ["APPLIED", "It is in Salesforce", "It is not there"],
    ["NOT_APPLIED", "It is not there", "It is in Salesforce"],
  ] as const)("while %s is in flight, disables BOTH buttons and relabels only the clicked one", (pending, clicked, other) => {
    const html = view({ pending });

    expect(disabledCount(html)).toBe(2);
    expect(html.match(/Recording…/g)).toHaveLength(1);
    expect(html).not.toContain(clicked);
    expect(html).toContain(other);
  });

  it("shows a refusal inline with a Reload button, and leaves both buttons usable", () => {
    const html = view({ notice: "This response is no longer awaiting reconciliation — someone may have resolved it already." });

    expect(html).toMatch(/aria-live="polite"[^]*no longer awaiting reconciliation[^]*Reload/);
    expect(disabledCount(html)).toBe(0);
    expect(html).toContain("It is in Salesforce");
    expect(html).toContain("It is not there");
  });

  it("the stateful control starts idle", () => {
    const html = renderToStaticMarkup(
      createElement(ReconcileControls, { action: async () => ({ ok: true as const }) }),
    );

    expect(html).toContain("It is in Salesforce");
    expect(disabledCount(html)).toBe(0);
  });
});

describe("the campaign page", () => {
  const BANNER = "recorded as synced by hand";
  const EXPLANATION = "does not refresh the cached Salesforce data in this app";
  const ITEM_LINE = "Recorded by hand: josh@idsculpture.com confirmed this change in Salesforce";

  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    session.current = ADMIN;
  });
  afterEach(() => vi.unstubAllEnvs());

  /** An UNCERTAIN response the contact really submitted, so the page lists it. */
  async function aSubmittedUncertainItem() {
    const ctx = await anUncertainItem();
    const item = await prisma.checkInOpportunity.update({
      where: { id: ctx.item.id },
      data: { submittedAt: new Date(), updatedStatus: "NEGOTIATION" },
    });
    return { campaignId: ctx.campaignId, item };
  }
  const render = async (campaignId: string) =>
    renderToStaticMarkup(await CampaignDetailPage({ params: Promise.resolve({ id: campaignId }) } as never));
  const attest = ({ campaignId, item }: Awaited<ReturnType<typeof aSubmittedUncertainItem>>, observed: "APPLIED" | "NOT_APPLIED") =>
    reconcileUncertainAction(campaignId, item.id, item.updatedAt.toISOString(), observed);

  it("offers the controls for an UNCERTAIN response, with no recorded-by-hand text yet", async () => {
    const ctx = await aSubmittedUncertainItem();

    const html = await render(ctx.campaignId);

    expect(html).toContain("It is in Salesforce");
    expect(html).toContain("It is not there");
    expect(html).not.toContain(BANNER);
    expect(html).not.toContain("Recorded by hand");
  });

  it("after APPLIED, explains the cache was not refreshed on every render, without the controls", async () => {
    const ctx = await aSubmittedUncertainItem();
    expect(await attest(ctx, "APPLIED")).toEqual({ ok: true });

    for (const render_ of [1, 2]) {
      const html = await render(ctx.campaignId);

      expect(html, `render ${render_}`).toContain(BANNER);
      expect(html).toContain(EXPLANATION);
      expect(html).toContain("manual step: nothing in this app checks that it has been done");
      expect(html).toMatch(/href="\/admin"[^>]*>dashboard</);
      expect(html).toContain("Refresh from Salesforce");
      expect(html).toContain(ITEM_LINE);
      expect(html).not.toContain("It is in Salesforce");
      expect(html).not.toContain("It is not there");
    }
  });

  it("after NOT_APPLIED, says nothing about a by-hand sync", async () => {
    const ctx = await aSubmittedUncertainItem();
    expect(await attest(ctx, "NOT_APPLIED")).toEqual({ ok: true });

    const html = await render(ctx.campaignId);

    expect(html).not.toContain(BANNER);
    expect(html).not.toContain("Recorded by hand");
    expect(html).not.toContain(EXPLANATION);
    expect(html).not.toContain("It is in Salesforce");
  });

  it("an APPLIED attestation leaves the cached Opportunity data and the refresh trail exactly as they were", async () => {
    const ctx = await aSubmittedUncertainItem();
    const opportunities = () => prisma.opportunity.findMany({ orderBy: { id: "asc" } });
    const refreshes = () => prisma.auditEvent.count({ where: { type: AUDIT_EVENTS.CATALOG_REFRESHED } });
    const [before, refreshesBefore] = [await opportunities(), await refreshes()];
    const attested = await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: ctx.item.id },
      include: { opportunity: true },
    });
    // Guard against a vacuous pass: the stage the contact reported differs from the cached one.
    expect(attested.opportunity.currentStage).not.toBe(attested.updatedStatus);

    expect(await attest(ctx, "APPLIED")).toEqual({ ok: true });
    await render(ctx.campaignId);

    expect(await opportunities()).toEqual(before);
    expect(await refreshes()).toBe(refreshesBefore);
  });
});
