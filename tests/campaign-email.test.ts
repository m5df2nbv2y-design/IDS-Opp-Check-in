import { beforeEach, describe, expect, it, vi } from "vitest";
import { readEmailCopy, validateEmailCopy, requireEmailRevision, STANDARD_CHECK_IN_SUBJECT } from "@/lib/check-in-copy";
import { buildInviteEmail } from "@/server/integrations/email/templates/check-in-email";

const tx = vi.hoisted(() => ({ campaign: { updateMany: vi.fn() }, auditEvent: { create: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: { $transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx) } }));
import { saveCampaignEmail } from "@/server/services/campaign-email-service";

const recipient = { contactName: "Alex Example", contactEmail: "alex@example.invalid", organizationName: "Example Company", opportunityCount: 2, checkInUrl: "https://example.invalid/checkin/synthetic", campaignId: "draft-example", contactId: "contact-example" };

describe("check-in email choices", () => {
  it("keeps the standard message as the default for existing campaigns", () => {
    const copy = readEmailCopy({ emailSubject: null, emailBody: null, emailRevision: 0 });
    expect(copy.mode).toBe("standard");
    const email = buildInviteEmail({ ...recipient, copy });
    expect(email.subject).toBe(STANDARD_CHECK_IN_SUBJECT);
    expect(email.text).toContain("bi-annual opportunity check-in");
    expect(email.text).toContain("2 open opportunities");
    expect(email.linkUrl).toBe(recipient.checkInUrl);
  });
  it("escapes custom text while preserving the secure CTA and recipient scope", () => {
    const email = buildInviteEmail({ ...recipient, contactName: "<script> Example", copy: { mode: "custom", subject: "Quick project update", body: 'Please check <img src=x onerror=alert(1)> & reply.\n\nThank you!' } });
    expect(email.subject).toBe("Quick project update");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; reply.");
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.text).toContain("Thank you!");
    expect(email.html).toContain(`href="${recipient.checkInUrl}"`);
    expect(email.text).toContain("2 open opportunities");
    expect(email.kind).toBe("INVITE");
  });
  it.each(["", "x".repeat(201), "Hello\r\nBcc: other@example.invalid", "Bad\u0000header"])("rejects invalid subject %s", (subject) => {
    expect(() => validateEmailCopy({ mode: "custom", subject, body: "Message" })).toThrow();
  });
  it.each(["", " ", "x".repeat(5001), "Bad\u0000body"])("rejects blank, oversized or null-byte message", (body) => {
    expect(() => validateEmailCopy({ mode: "custom", subject: "Hello", body })).toThrow();
  });
  it("normalizes custom whitespace and refuses unrecognized modes", () => {
    expect(validateEmailCopy({ mode: "custom", subject: " Hello ", body: " One\r\nTwo " })).toEqual({ mode: "custom", subject: "Hello", body: "One\nTwo" });
    expect(() => validateEmailCopy({ mode: "anything" })).toThrow();
    expect(validateEmailCopy({ mode: "standard", subject: "Ignore forged override", body: "ignored" }).subject).toBe(STANDARD_CHECK_IN_SUBJECT);
  });
  it.each([-1, 0.5, NaN, "0", undefined])("rejects invalid revision %s", (revision) => expect(() => requireEmailRevision(revision)).toThrow());
});

describe("shared campaign email saving", () => {
  beforeEach(() => { vi.clearAllMocks(); tx.campaign.updateMany.mockResolvedValue({ count: 1 }); });
  it("saves custom copy only on the expected DRAFT revision and audits the actor", async () => {
    const result = await saveCampaignEmail("draft-example", 3, { mode: "custom", subject: "Hello", body: "Update please" }, "admin@example.invalid");
    expect(tx.campaign.updateMany).toHaveBeenCalledWith({ where: { id: "draft-example", status: "DRAFT", emailRevision: 3 }, data: { emailSubject: "Hello", emailBody: "Update please", emailRevision: { increment: 1 } } });
    expect(result.revision).toBe(4);
    expect(tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ actor: "admin@example.invalid", campaignId: "draft-example", type: "CAMPAIGN_EMAIL_DRAFTED" }) });
  });
  it("does not overwrite stale or already-launched drafts", async () => {
    tx.campaign.updateMany.mockResolvedValue({ count: 0 });
    await expect(saveCampaignEmail("draft-example", 3, { mode: "standard" }, "admin@example.invalid")).rejects.toThrow("shared draft changed");
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
  it("rejects malformed copy before touching the database", async () => {
    await expect(saveCampaignEmail("draft-example", 3, { mode: "custom", subject: "", body: "Hello" }, "admin@example.invalid")).rejects.toThrow();
    expect(tx.campaign.updateMany).not.toHaveBeenCalled();
  });
  it("switching back to standard clears custom fields and increments revision", async () => {
    await saveCampaignEmail("draft-example", 4, { mode: "standard" }, "admin@example.invalid");
    expect(tx.campaign.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { emailSubject: null, emailBody: null, emailRevision: { increment: 1 } } }));
  });
});
