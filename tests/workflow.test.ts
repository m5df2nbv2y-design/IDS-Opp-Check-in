import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getCampaignSummary, previewCampaign } from "@/server/services/campaign-service";
import {
  completeCheckIn,
  resolveCheckInToken,
  saveResponse,
} from "@/server/services/response-service";
import { retryFailedSyncs } from "@/server/services/sync-service";
import { itemsForContact, launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/** Answers every opportunity for a contact, confirming the current stage by default. */
async function answerAll(
  campaignId: string,
  contactName: string,
  token: string,
  overrides: Record<string, { stage: string; comment?: string }> = {},
) {
  for (const item of await itemsForContact(campaignId, contactName)) {
    const override = overrides[item.opportunityName];
    const result = await saveResponse({
      token,
      itemId: item.id,
      stage: override?.stage ?? item.previousStatus,
      comment: override?.comment ?? null,
    });
    expect(result.ok).toBe(true);
  }
}

describe("campaign workflow", () => {
  let campaignId: string;
  let tokens: Map<string, string>;

  beforeAll(async () => {
    await resetDatabase();
    const result = await launchCampaignAndCollectTokens("Fall Test Check-In");
    campaignId = result.campaignId;
    tokens = result.tokens;
  });

  it("groups opportunities by external contact and emails each contact once", async () => {
    const summary = await getCampaignSummary(campaignId);
    expect(summary).not.toBeNull();

    // 36 open opportunities; one cannot be routed to a contact.
    expect(summary!.opportunityCount).toBe(35);
    expect(summary!.recipientCount).toBe(12);
    expect(summary!.organizationCount).toBe(11);
    expect(summary!.emailsSent).toBe(12);

    const emails = await prisma.emailMessage.findMany({ where: { campaignId, kind: "INVITE" } });
    expect(emails).toHaveLength(12);
    // One email per contact — no contact is emailed twice.
    expect(new Set(emails.map((email) => email.toEmail)).size).toBe(12);

    const preview = await previewCampaign();
    expect(preview.totalOpenCount).toBe(36);
    expect(preview.unresolvedCount).toBe(1);
  });

  it("sends one check-in covering opportunities from three different IDS reps", async () => {
    const marcus = await prisma.checkInRecipient.findFirstOrThrow({
      where: { campaignId, contact: { name: "Marcus Webb" } },
      include: { items: true, contact: { include: { account: true } } },
    });

    expect(marcus.contact.account.name).toBe("XYZ Agency");
    expect(marcus.items).toHaveLength(9);
    expect(new Set(marcus.items.map((item) => item.internalRepName))).toEqual(
      new Set(["John Smith", "Sarah Jones", "Mike Brown"]),
    );

    // …and exactly one email was sent for those nine opportunities.
    const emails = await prisma.emailMessage.count({
      where: { campaignId, kind: "INVITE", toName: "Marcus Webb" },
    });
    expect(emails).toBe(1);
  });

  it("hides internal IDS reps from what the recipient can see", async () => {
    const resolved = await resolveCheckInToken(tokens.get("Marcus Webb")!);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.session.items).toHaveLength(9);
    for (const item of resolved.session.items) {
      expect(Object.keys(item)).not.toContain("internalRepName");
    }
  });

  it("pushes a changed stage and the contact's note to Salesforce", async () => {
    const token = tokens.get("Jane Doe")!;
    await answerAll(campaignId, "Jane Doe", token, {
      "MRI Suite Renovation": { stage: "NEGOTIATION", comment: "Board signs this week." },
    });

    const completion = await completeCheckIn(token);
    expect(completion).toEqual({ ok: true, alreadyCompleted: false, submitted: 6, total: 6 });

    const item = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { recipient: { campaignId }, opportunityName: "MRI Suite Renovation" },
    });
    expect(item.syncStatus).toBe("SYNCED");
    expect(item.previousStatus).toBe("PROPOSAL");
    expect(item.updatedStatus).toBe("NEGOTIATION");

    const record = await prisma.mockSalesforceOpportunity.findFirstOrThrow({
      where: { name: "MRI Suite Renovation" },
    });
    expect(record.stageName).toBe("Negotiation");
    expect(record.description).toContain("Board signs this week.");
    expect(record.description).toContain("Fall Test Check-In");
  });

  it("writes nothing to Salesforce when the contact confirms the current stage", async () => {
    const confirmed = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { recipient: { campaignId }, opportunityName: "Interventional Radiology Buildout" },
    });
    expect(confirmed.updatedStatus).toBe(confirmed.previousStatus);
    expect(confirmed.syncStatus).toBe("SKIPPED");

    const record = await prisma.mockSalesforceOpportunity.findFirstOrThrow({
      where: { name: "Interventional Radiology Buildout" },
    });
    expect(record.description).toBeNull();
  });

  it("records a rejected Salesforce write without blocking sibling records", async () => {
    const token = tokens.get("Dana Whitfield")!;
    await answerAll(campaignId, "Dana Whitfield", token, {
      // Metro General's mammography record carries a simulated validation rule.
      "Mammography Suite Refresh": { stage: "NEGOTIATION", comment: "Moving to contract." },
      "Trauma Center X-Ray Replacement": { stage: "NEGOTIATION" },
    });
    await completeCheckIn(token);

    const failed = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { recipient: { campaignId }, opportunityName: "Mammography Suite Refresh" },
    });
    expect(failed.syncStatus).toBe("FAILED");
    expect(failed.syncError).toContain("FIELD_CUSTOM_VALIDATION_EXCEPTION");

    const sibling = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { recipient: { campaignId }, opportunityName: "Trauma Center X-Ray Replacement" },
    });
    expect(sibling.syncStatus).toBe("SYNCED");

    const summary = await getCampaignSummary(campaignId);
    expect(summary!.recipients.find((r) => r.contactName === "Dana Whitfield")!.status).toBe(
      "SYNC_ERROR",
    );
    expect(summary!.syncErrorCount).toBe(1);
  });

  it("clears the error once the org accepts the write on retry", async () => {
    const record = await prisma.mockSalesforceOpportunity.findFirstOrThrow({
      where: { name: "Mammography Suite Refresh" },
    });
    await prisma.mockSalesforceOpportunity.update({
      where: { externalId: record.externalId },
      data: { syncBlocked: false },
    });

    const outcome = await retryFailedSyncs(campaignId, "test");
    expect(outcome.synced).toBe(1);
    expect(outcome.failed).toBe(0);

    const fixed = await prisma.checkInOpportunity.findFirstOrThrow({
      where: { recipient: { campaignId }, opportunityName: "Mammography Suite Refresh" },
    });
    expect(fixed.syncStatus).toBe("SYNCED");
    expect(fixed.syncError).toBeNull();
    expect(fixed.syncAttempts).toBe(2);

    const summary = await getCampaignSummary(campaignId);
    expect(summary!.recipients.find((r) => r.contactName === "Dana Whitfield")!.status).toBe(
      "COMPLETE",
    );
    expect(summary!.syncErrorCount).toBe(0);
  });

  it("reports a partially finished check-in as In Progress and resumes where it stopped", async () => {
    const token = tokens.get("Ray Ortiz")!;
    const items = await itemsForContact(campaignId, "Ray Ortiz");
    await saveResponse({ token, itemId: items[0].id, stage: "NEGOTIATION" });

    const summary = await getCampaignSummary(campaignId);
    const ray = summary!.recipients.find((r) => r.contactName === "Ray Ortiz")!;
    expect(ray.status).toBe("IN_PROGRESS");
    expect(ray.submittedCount).toBe(1);
    expect(ray.opportunityCount).toBe(3);

    const resumed = await resolveCheckInToken(token);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.session.items.filter((item) => item.submitted)).toHaveLength(1);
    expect(resumed.session.items[0].selectedStage).toBe("NEGOTIATION");
  });

  it("refuses to complete a check-in that still has unanswered opportunities", async () => {
    const result = await completeCheckIn(tokens.get("Ray Ortiz")!);
    expect(result).toEqual({ ok: false, reason: "INCOMPLETE" });
  });

  it("handles a duplicate submission without syncing twice", async () => {
    const token = tokens.get("Jane Doe")!;
    const before = await prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId, contact: { name: "Jane Doe" } } },
      select: { id: true, syncAttempts: true, syncedAt: true },
      orderBy: { id: "asc" },
    });

    const second = await completeCheckIn(token);
    expect(second).toEqual({ ok: true, alreadyCompleted: true, submitted: 6, total: 6 });

    const after = await prisma.checkInOpportunity.findMany({
      where: { recipient: { campaignId, contact: { name: "Jane Doe" } } },
      select: { id: true, syncAttempts: true, syncedAt: true },
      orderBy: { id: "asc" },
    });
    expect(after).toEqual(before);
  });

  it("rejects further edits once the contact has submitted", async () => {
    const token = tokens.get("Jane Doe")!;
    const item = (await itemsForContact(campaignId, "Jane Doe"))[0];

    const result = await saveResponse({ token, itemId: item.id, stage: "QUALIFICATION" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ALREADY_COMPLETED");
  });

  it("keeps a full audit entry for every response and Salesforce write", async () => {
    const events = await prisma.auditEvent.findMany({
      where: { campaignId },
      include: { account: true, contact: true, rep: true, opportunity: true },
    });
    const types = new Set(events.map((event) => event.type));

    expect(types).toContain("CAMPAIGN_CREATED");
    expect(types).toContain("INVITE_SENT");
    expect(types).toContain("RESPONSE_SUBMITTED");
    expect(types).toContain("CHECKIN_COMPLETED");
    expect(types).toContain("SYNC_SUCCEEDED");
    expect(types).toContain("SYNC_FAILED");
    expect(types).toContain("SYNC_SKIPPED");

    // The audit entry carries opportunity, organization, external contact,
    // internal IDS rep, stage transition and campaign — all at once.
    const transition = events.find(
      (event) =>
        event.type === "SYNC_SUCCEEDED" && event.summary.includes("MRI Suite Renovation"),
    )!;
    expect(transition.fromStatus).toBe("PROPOSAL");
    expect(transition.toStatus).toBe("NEGOTIATION");
    expect(transition.account?.name).toBe("ABC Distribution");
    expect(transition.contact?.name).toBe("Jane Doe");
    expect(transition.rep?.name).toBe("John Smith");
    expect(transition.detail).toContain("Jane Doe");
    expect(transition.detail).toContain("John Smith");

    const submitted = events.find(
      (event) => event.type === "RESPONSE_SUBMITTED" && event.contact?.name === "Jane Doe",
    )!;
    expect(submitted.actorKind).toBe("EXTERNAL_CONTACT");
  });

  it("closes the campaign only once every recipient has finished", async () => {
    const midway = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(midway.status).toBe("IN_PROGRESS");

    const outstanding = await prisma.checkInRecipient.findMany({
      where: { campaignId, completedAt: null },
      include: { contact: true },
    });

    for (const recipient of outstanding) {
      const token = tokens.get(recipient.contact.name)!;
      await answerAll(campaignId, recipient.contact.name, token);
      await completeCheckIn(token);
    }

    const closed = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(closed.status).toBe("COMPLETE");
    expect(closed.completedAt).not.toBeNull();

    const summary = await getCampaignSummary(campaignId);
    expect(summary!.completedCount).toBe(12);
    expect(summary!.pendingCount).toBe(0);
  });
});
