import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { MockSalesforceService } from "@/server/integrations/salesforce/mock/mock-salesforce-service";
import type { SalesforceContact, SalesforceOpportunity } from "@/server/integrations/salesforce";
import {
  RESOLUTION_REASONS,
  resolveRecipient,
  resolveRecipients,
} from "@/server/services/recipient-resolution-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

/**
 * The canonical rule, pinned:
 *   Opportunity → Primary Opportunity Contact Role → Contact → Email
 *
 * These tests exist as much to prove what the resolver REFUSES to do — it must
 * never substitute another contact at the account — as to prove what it routes.
 */

function opportunity(overrides: Partial<SalesforceOpportunity> = {}): SalesforceOpportunity {
  return {
    externalId: "006-test",
    opportunityName: "Test Opportunity",
    projectName: "Test Opportunity",
    customerName: "Test Site",
    amount: 1000,
    stage: "PROPOSAL",
    closeDate: null,
    url: "https://example.invalid",
    ownerExternalId: "005-owner",
    accountExternalId: "001-account",
    primaryContactExternalId: null,
    ...overrides,
  };
}

function contact(overrides: Partial<SalesforceContact> = {}): SalesforceContact {
  return {
    externalId: "003-contact",
    accountExternalId: "001-account",
    name: "Test Contact",
    email: "test@example.invalid",
    isPrimary: false,
    active: true,
    ...overrides,
  };
}

function index(contacts: SalesforceContact[]) {
  return new Map(contacts.map((c) => [c.externalId, c]));
}

describe("recipient resolution — primary contact role only", () => {
  it("resolves to the primary contact role's contact", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: "003-primary" }),
      contactsById: index([contact({ externalId: "003-primary", email: "primary@example.invalid" })]),
    });

    expect(result).toEqual({
      status: "RESOLVED",
      contactExternalId: "003-primary",
      reason: RESOLUTION_REASONS.PRIMARY_CONTACT_ROLE,
    });
  });

  it("is UNRESOLVED when no primary contact role is set", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: null }),
      contactsById: index([contact()]),
    });

    expect(result.status).toBe("UNRESOLVED");
    if (result.status !== "UNRESOLVED") return;
    expect(result.reason).toBe(RESOLUTION_REASONS.NO_PRIMARY_CONTACT_ROLE);
  });

  it("is UNRESOLVED when the primary contact has no email", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: "003-primary" }),
      contactsById: index([contact({ externalId: "003-primary", name: "No Email", email: "" })]),
    });

    expect(result.status).toBe("UNRESOLVED");
    if (result.status !== "UNRESOLVED") return;
    expect(result.reason).toBe(RESOLUTION_REASONS.PRIMARY_CONTACT_NO_EMAIL);
    expect(result.warning).toContain("No Email");
  });

  it("treats a whitespace-only email as no email", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: "003-primary" }),
      contactsById: index([contact({ externalId: "003-primary", email: "   " })]),
    });

    expect(result.status).toBe("UNRESOLVED");
    if (result.status !== "UNRESOLVED") return;
    expect(result.reason).toBe(RESOLUTION_REASONS.PRIMARY_CONTACT_NO_EMAIL);
  });

  it("is UNRESOLVED when the primary contact record cannot be found", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: "003-missing" }),
      contactsById: index([contact({ externalId: "003-other" })]),
    });

    expect(result.status).toBe("UNRESOLVED");
    if (result.status !== "UNRESOLVED") return;
    expect(result.reason).toBe(RESOLUTION_REASONS.PRIMARY_CONTACT_NOT_FOUND);
  });

  // ---- The refusals. These are the point of the rule. --------------------

  it("NEVER falls back to another contact at the same account", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: null }),
      // A single, obvious, emailable contact sitting right there — and the
      // resolver must still refuse to use it.
      contactsById: index([
        contact({ externalId: "003-tempting", name: "Obvious Person", email: "obvious@example.invalid" }),
      ]),
    });

    expect(result.status).toBe("UNRESOLVED");
  });

  it("NEVER substitutes a different contact when the primary has no email", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: "003-primary" }),
      contactsById: index([
        contact({ externalId: "003-primary", email: "" }),
        contact({ externalId: "003-backup", name: "Backup", email: "backup@example.invalid" }),
      ]),
    });

    expect(result.status).toBe("UNRESOLVED");
    if (result.status !== "UNRESOLVED") return;
    expect(result.reason).toBe(RESOLUTION_REASONS.PRIMARY_CONTACT_NO_EMAIL);
  });

  it("does not collapse duplicate contact records — the named record wins", () => {
    const result = resolveRecipient({
      opportunity: opportunity({ primaryContactExternalId: "003-duplicate" }),
      contactsById: index([
        contact({ externalId: "003-original", email: "same@example.invalid" }),
        contact({ externalId: "003-duplicate", email: "same@example.invalid" }),
      ]),
    });

    expect(result.status).toBe("RESOLVED");
    if (result.status !== "RESOLVED") return;
    expect(result.contactExternalId).toBe("003-duplicate");
  });

  it("summarises a batch with per-reason unresolved counts", () => {
    const summary = resolveRecipients({
      opportunities: [
        opportunity({ externalId: "a", primaryContactExternalId: "003-ok" }),
        opportunity({ externalId: "b", primaryContactExternalId: null }),
        opportunity({ externalId: "c", primaryContactExternalId: "003-noemail" }),
        opportunity({ externalId: "d", primaryContactExternalId: "003-gone" }),
      ],
      contacts: [
        contact({ externalId: "003-ok", email: "ok@example.invalid" }),
        contact({ externalId: "003-noemail", email: "" }),
      ],
    });

    expect(summary.resolvedCount).toBe(1);
    expect(summary.unresolvedCount).toBe(3);
    expect(summary.unresolvedByReason.NO_PRIMARY_CONTACT_ROLE).toBe(1);
    expect(summary.unresolvedByReason.PRIMARY_CONTACT_NO_EMAIL).toBe(1);
    expect(summary.unresolvedByReason.PRIMARY_CONTACT_NOT_FOUND).toBe(1);
    expect(summary.recipientExternalIds).toEqual(["003-ok"]);
  });
});

describe("recipient resolution against the mock org", () => {
  beforeAll(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  it("routes each opportunity to its primary contact role", async () => {
    const jane = await prisma.externalContact.findFirstOrThrow({
      where: { name: "Jane Doe" },
      include: { opportunities: true },
    });
    // Five of ABC Distribution's six opportunities name Jane; the sixth names
    // her explicitly too, via the seed's own contact role.
    expect(jane.opportunities.length).toBeGreaterThanOrEqual(5);

    const marcus = await prisma.externalContact.findFirstOrThrow({
      where: { name: "Marcus Webb" },
      include: { opportunities: { include: { internalRep: true } } },
    });
    expect(marcus.opportunities).toHaveLength(9);
    // Still one recipient across three different IDS reps.
    expect(new Set(marcus.opportunities.map((o) => o.internalRep.name)).size).toBe(3);
  });

  it("flags an opportunity with no primary contact role", async () => {
    const orphan = await prisma.opportunity.findFirstOrThrow({
      where: { opportunityName: "Cath Lab Relocation" },
    });
    expect(orphan.resolutionStatus).toBe("UNRESOLVED");
    expect(orphan.resolutionReason).toBe(RESOLUTION_REASONS.NO_PRIMARY_CONTACT_ROLE);
    expect(orphan.contactId).toBeNull();
  });

  it("flags an opportunity whose primary contact has no email", async () => {
    const noEmail = await prisma.opportunity.findFirstOrThrow({
      where: { opportunityName: "Imaging Equipment Service Agreement" },
    });
    expect(noEmail.resolutionStatus).toBe("UNRESOLVED");
    expect(noEmail.resolutionReason).toBe(RESOLUTION_REASONS.PRIMARY_CONTACT_NO_EMAIL);
    expect(noEmail.contactId).toBeNull();
  });

  it("never routes to a contact who is not the named primary", async () => {
    // Victor Lang and Priya Raman are emailable contacts at accounts with plenty
    // of opportunities, but are named on none of them.
    for (const name of ["Victor Lang", "Priya Raman"]) {
      const contact = await prisma.externalContact.findFirstOrThrow({
        where: { name },
        include: { opportunities: true },
      });
      expect(contact.opportunities).toHaveLength(0);
    }
  });

  it("excludes opportunities owned by an inactive IDS rep", async () => {
    const orphan = await prisma.opportunity.findUnique({
      where: { externalId: "006Ab00000Opp40AAA" },
    });
    expect(orphan).toBeNull();
  });

  it("mock provider surfaces the primary contact role through the interface", async () => {
    const opportunities = await new MockSalesforceService().getOpenOpportunities();
    const withRole = opportunities.filter((o) => o.primaryContactExternalId !== null);
    expect(withRole.length).toBeGreaterThan(0);
    expect(opportunities.some((o) => o.primaryContactExternalId === null)).toBe(true);
  });
});
