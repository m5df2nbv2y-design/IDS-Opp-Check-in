import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSalesforceService } from "@/server/integrations/salesforce/live/salesforce-service";
import { resolveRecipient } from "@/server/services/recipient-resolution-service";
import type { SalesforceOpportunity } from "@/server/integrations/salesforce/types";

vi.mock("@/server/integrations/salesforce/live/auth", () => ({
  requestAccessToken: vi.fn(async () => ({
    accessToken: "synthetic-token",
    instanceUrl: "https://salesforce.example.invalid",
    identityUrl: null,
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("live Salesforce contacts with missing email", () => {
  it("preserves null-email contacts across pagination and leaves their opportunities unsendable", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        records: [{ Id: "003-missing", AccountId: "001-account", Name: "Missing Email", Email: null }],
        done: false,
        nextRecordsUrl: "/services/data/v61.0/query/next-page",
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        records: [
          { Id: "003-valid", AccountId: "001-account", Name: "Valid Email", Email: "test@example.invalid" },
          { Id: "003-orphan", AccountId: null, Name: "No Account", Email: null },
        ],
        done: true,
      })));
    vi.stubGlobal("fetch", fetchMock);

    const contacts = await new LiveSalesforceService().getExternalContacts();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://salesforce.example.invalid/services/data/v61.0/query/next-page");
    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({ externalId: "003-missing", email: "" });
    expect(contacts[1]).toMatchObject({ externalId: "003-valid", email: "test@example.invalid" });

    const opportunity: SalesforceOpportunity = {
      externalId: "006-test", opportunityName: "Synthetic Opportunity", projectName: "Synthetic Project",
      customerName: "Synthetic Account", amount: 100, stage: "PROPOSAL", closeDate: null,
      url: "https://example.invalid", ownerExternalId: "005-owner", accountExternalId: "001-account",
      primaryContactExternalId: "003-missing",
    };
    const contactsById = new Map(contacts.map(contact => [contact.externalId, contact]));
    expect(resolveRecipient({ opportunity, contactsById })).toMatchObject({
      status: "UNRESOLVED", reason: "PRIMARY_CONTACT_NO_EMAIL",
    });
    expect(resolveRecipient({ opportunity: { ...opportunity, primaryContactExternalId: "003-valid" }, contactsById })).toMatchObject({
      status: "RESOLVED", contactExternalId: "003-valid",
    });
  });
});
