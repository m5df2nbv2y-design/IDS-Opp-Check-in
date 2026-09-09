import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { MockSalesforceService } from "@/server/integrations/salesforce/mock/mock-salesforce-service";
import {
  dedupeContacts,
  RESOLUTION_REASONS,
  resolveRecipients,
} from "@/server/services/recipient-resolution-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { resetDatabase } from "./fixtures";

/**
 * Recipient resolution is the biggest real-world dependency in the product, so
 * every branch is pinned here against the mock org, which was built to contain
 * one example of each messy real-world case.
 */
describe("recipient resolution", () => {
  let salesforce: MockSalesforceService;

  beforeAll(async () => {
    await resetDatabase();
    salesforce = new MockSalesforceService();
  });

  async function resolveAll() {
    const [opportunities, accounts, contacts] = await Promise.all([
      salesforce.getOpenOpportunities(),
      salesforce.getAccounts(),
      salesforce.getExternalContacts(),
    ]);
    return { summary: resolveRecipients({ opportunities, accounts, contacts }), contacts };
  }

  function reasonFor(
    summary: Awaited<ReturnType<typeof resolveAll>>["summary"],
    opportunityName: string,
  ) {
    const result = summary.results.find((r) => r.opportunity.opportunityName === opportunityName);
    expect(result, `no result for ${opportunityName}`).toBeDefined();
    return result!.resolution;
  }

  it("routes an opportunity to the account's primary contact", async () => {
    const { summary } = await resolveAll();
    const resolution = reasonFor(summary, "MRI Suite Renovation");

    expect(resolution.status).toBe("RESOLVED");
    if (resolution.status !== "RESOLVED") return;
    expect(resolution.reason).toBe(RESOLUTION_REASONS.ACCOUNT_PRIMARY);
  });

  it("prefers a contact named on the opportunity itself", async () => {
    const { summary } = await resolveAll();
    const resolution = reasonFor(summary, "Campus-Wide Equipment Planning");

    expect(resolution.status).toBe("RESOLVED");
    if (resolution.status !== "RESOLVED") return;
    expect(resolution.reason).toBe(RESOLUTION_REASONS.OPPORTUNITY_CONTACT);
    // Tom Becker, not Northstar's primary Elena Ruiz.
    expect(resolution.contactExternalId).toBe("003Ab00000Con06AAA");
  });

  it("falls back when the named contact is inactive, and says so", async () => {
    const { summary } = await resolveAll();
    const resolution = reasonFor(summary, "Imaging Equipment Service Agreement");

    expect(resolution.status).toBe("RESOLVED");
    if (resolution.status !== "RESOLVED") return;
    // Greta Sims has left; Felix Moreau receives it.
    expect(resolution.contactExternalId).toBe("003Ab00000Con17AAA");
    expect(resolution.warning).toContain("Greta Sims");
  });

  it("skips an inactive primary contact and uses the active one", async () => {
    const { summary } = await resolveAll();
    const resolution = reasonFor(summary, "Veterinary Imaging Suite");

    expect(resolution.status).toBe("RESOLVED");
    if (resolution.status !== "RESOLVED") return;
    // Chris Vega is primary but inactive → Morgan Lee.
    expect(resolution.contactExternalId).toBe("003Ab00000Con12AAA");
    expect(resolution.reason).toBe(RESOLUTION_REASONS.ONLY_ACTIVE_CONTACT);
  });

  it("uses the only active contact when none is flagged primary", async () => {
    const { summary } = await resolveAll();
    const resolution = reasonFor(summary, "Research Imaging Core Lab");

    expect(resolution.status).toBe("RESOLVED");
    if (resolution.status !== "RESOLVED") return;
    expect(resolution.reason).toBe(RESOLUTION_REASONS.ONLY_ACTIVE_CONTACT);
  });

  it("flags an opportunity with no usable contact instead of dropping it", async () => {
    const { summary } = await resolveAll();
    const resolution = reasonFor(summary, "Cath Lab Relocation");

    expect(resolution.status).toBe("UNRESOLVED");
    if (resolution.status !== "UNRESOLVED") return;
    expect(resolution.reason).toBe(RESOLUTION_REASONS.NO_CONTACTS);
    expect(resolution.warning).toContain("Ridgeline Health Advisors");
    expect(summary.unresolvedCount).toBe(1);
  });

  it("collapses duplicate contact records that share an email", async () => {
    const contacts = await salesforce.getExternalContacts();
    const { canonical, aliases } = dedupeContacts(contacts);

    expect(contacts).toHaveLength(18);
    expect(canonical).toHaveLength(17);
    // "Samuel Whitaker" collapses onto the primary "Sam Whitaker".
    expect(aliases.get("003Ab00000Con14AAA")).toBe("003Ab00000Con13AAA");

    const { summary } = await resolveAll();
    expect(summary.duplicatesCollapsed).toBe(1);
    const gulfRecipients = summary.results
      .filter((r) => r.opportunity.accountExternalId === "001Ab00000Acc09AAA")
      .map((r) => (r.resolution.status === "RESOLVED" ? r.resolution.contactExternalId : null));
    expect(new Set(gulfRecipients).size).toBe(1);
  });

  it("gives one contact every opportunity across several internal IDS reps", async () => {
    await refreshCatalogFromSalesforce("test");

    const marcus = await prisma.externalContact.findFirstOrThrow({
      where: { name: "Marcus Webb" },
      include: { opportunities: { include: { internalRep: true } } },
    });

    expect(marcus.opportunities).toHaveLength(9);
    const reps = new Set(marcus.opportunities.map((o) => o.internalRep.name));
    expect(reps).toEqual(new Set(["John Smith", "Sarah Jones", "Mike Brown"]));
  });

  it("gives a distributor's single contact all of that account's opportunities", async () => {
    const jane = await prisma.externalContact.findFirstOrThrow({
      where: { name: "Jane Doe" },
      include: { opportunities: true, account: true },
    });

    expect(jane.account.name).toBe("ABC Distribution");
    expect(jane.account.type).toBe("DISTRIBUTOR");
    expect(jane.opportunities).toHaveLength(6);

    // Victor Lang is active at the same account but is not the primary, so he
    // is responsible for nothing and receives no email.
    const victor = await prisma.externalContact.findFirstOrThrow({
      where: { name: "Victor Lang" },
      include: { opportunities: true },
    });
    expect(victor.opportunities).toHaveLength(0);
  });

  it("excludes opportunities owned by an inactive IDS rep", async () => {
    const orphan = await prisma.opportunity.findUnique({
      where: { externalId: "006Ab00000Opp40AAA" },
    });
    expect(orphan).toBeNull();
  });
});
