import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import {
  getOrCreateDraft,
  sendDraft,
  setSelection,
} from "@/server/services/campaign-draft-service";
import { completeCheckIn, saveResponse } from "@/server/services/response-service";
import { resetDatabase } from "./fixtures";

/**
 * Reading real pipeline data must never carry a risk of modifying it.
 *
 * A recipient completing a check-in triggers a Salesforce PATCH. Against a real
 * org that would be an unannounced write to production, so the push is
 * withheld unless write-back has been deliberately enabled. The answer is still
 * recorded — only the outbound write is held.
 */
describe("salesforce write guard", () => {
  beforeEach(async () => {
    await resetDatabase();
    await refreshCatalogFromSalesforce("test");
  });

  async function completeOneCheckIn() {
    const draft = await getOrCreateDraft("test");
    const opportunity = await prisma.opportunity.findFirstOrThrow({
      where: { isOpen: true, resolutionStatus: "RESOLVED", opportunityName: "MRI Suite Renovation" },
    });
    await setSelection({ campaignId: draft.id, opportunityIds: [opportunity.id], selected: true });
    await sendDraft(draft.id, "test");

    const email = await prisma.emailMessage.findFirstOrThrow({
      where: { campaignId: draft.id, kind: "INVITE" },
    });
    const token = email.linkUrl!.split("/checkin/")[1];

    const items = await prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId: draft.id } },
    });
    for (const item of items) {
      await saveResponse({ token, itemId: item.id, stage: "NEGOTIATION" });
    }
    await completeCheckIn(token);
    return { campaignId: draft.id, opportunity };
  }

  it("DOES push to the mock org — those writes are our own demo data", async () => {
    const { opportunity } = await completeOneCheckIn();

    const item = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { opportunityId: opportunity.id },
    });
    expect(item.syncStatus).toBe("SYNCED");

    const record = await prisma.mockSalesforceOpportunity.findFirstOrThrow({
      where: { externalId: opportunity.externalId },
    });
    expect(record.stageName).toBe("Negotiation");
  });

  it("WITHHOLDS the push when the provider is a real org and write-back is off", async () => {
    // Present the live provider's identity on the singleton the app uses, so
    // the guard sees exactly what it would see against a real org.
    const { getSalesforceService } = await import("@/server/integrations/salesforce");
    const service = getSalesforceService();
    const realInfo = service.info;
    Object.defineProperty(service, "info", {
      value: { ...realInfo, id: "salesforce", simulated: false },
      configurable: true,
    });
    const applyUpdate = vi.spyOn(service, "applyUpdate");

    const { opportunity } = await completeOneCheckIn();

    // The outbound write never happened.
    expect(applyUpdate).not.toHaveBeenCalled();

    const item = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { opportunityId: opportunity.id },
    });
    // …but the recipient's answer is fully recorded.
    expect(item.syncStatus).toBe("WITHHELD");
    expect(item.updatedStatus).toBe("NEGOTIATION");
    expect(item.submittedAt).not.toBeNull();

    // Salesforce is untouched.
    const record = await prisma.mockSalesforceOpportunity.findFirstOrThrow({
      where: { externalId: opportunity.externalId },
    });
    expect(record.stageName).toBe("Proposal");

    // And it is auditable, not silent.
    const withheld = await prisma.auditEvent.findFirst({ where: { type: "SYNC_WITHHELD" } });
    expect(withheld).not.toBeNull();
    expect(withheld?.detail).toContain("write-back is disabled");

    applyUpdate.mockRestore();
    Object.defineProperty(service, "info", { value: realInfo, configurable: true });
  });
});
