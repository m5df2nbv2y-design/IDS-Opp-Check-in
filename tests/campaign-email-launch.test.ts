import { beforeEach, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  claim: vi.fn(), emails: vi.fn(), recipients: vi.fn(), findOpportunities: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: {
  opportunity: { findMany: mock.findOpportunities, count: vi.fn(async () => 0) },
  campaign: { updateMany: mock.claim, findUniqueOrThrow: vi.fn(async () => ({ id: "draft", name: "Example campaign" })) },
  campaignSelection: { findMany: vi.fn(async () => []), createMany: vi.fn() },
  checkInRecipient: { create: mock.recipients, update: vi.fn() },
  checkInOpportunity: { createMany: vi.fn() },
} }));
vi.mock("@/server/integrations/email", () => ({ getEmailService: () => ({ send: mock.emails }) }));
vi.mock("@/server/integrations/salesforce", () => ({ getSalesforceService: () => ({ info: { label: "Test catalog" } }) }));
vi.mock("@/server/services/audit-service", () => ({ recordAudit: vi.fn(), AUDIT_EVENTS: {} }));
vi.mock("@/server/services/snapshot-service", () => ({ recordSnapshot: vi.fn(), SNAPSHOT_SOURCES: {} }));
vi.mock("@/lib/tokens", () => ({ issueToken: () => ({ token: "synthetic", hash: "synthetic-hash", hint: "hint" }), checkInUrl: () => "https://example.invalid/checkin/synthetic" }));
import { launchCampaign } from "@/server/services/campaign-service";

beforeEach(() => {
  vi.clearAllMocks();
  mock.claim.mockResolvedValue({ count: 1 });
  mock.emails.mockResolvedValue({ status: "SENT" });
  mock.recipients.mockResolvedValue({ id: "recipient" });
  mock.findOpportunities.mockResolvedValue([{ id: "opportunity", contactId: "contact", accountId: "account", internalRepId: "rep", amount: 100, currentStage: "PROPOSAL", closeDate: null, contact: { name: "Alex Example", email: "alex@example.invalid", accountId: "account", account: { name: "Example Company" } }, account: { name: "Example Company" }, internalRep: { name: "IDS Example" } }]);
});

it("uses the reviewed custom copy in the invitation after claiming the same revision", async () => {
  await launchCampaign({ campaignId: "draft", opportunityIds: ["opportunity"], expectedEmailRevision: 7, emailCopy: { mode: "custom", subject: "Your project update", body: "Could you share an update?" } });
  expect(mock.claim).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "draft", status: "DRAFT", emailRevision: 7 } }));
  expect(mock.emails).toHaveBeenCalledWith(expect.objectContaining({ subject: "Your project update", text: expect.stringContaining("Could you share an update?"), to: { name: "Alex Example", email: "alex@example.invalid" }, linkUrl: "https://example.invalid/checkin/synthetic" }));
  expect(mock.recipients).toHaveBeenCalledTimes(1);
});

it("a changed email revision or already-claimed draft cannot mint recipients or send", async () => {
  mock.claim.mockResolvedValue({ count: 0 });
  await expect(launchCampaign({ campaignId: "draft", opportunityIds: ["opportunity"], expectedEmailRevision: 7 })).rejects.toThrow("changed or was already sent");
  expect(mock.recipients).not.toHaveBeenCalled();
  expect(mock.emails).not.toHaveBeenCalled();
});

it("invalid custom headers fail before campaign mutation or recipient creation", async () => {
  await expect(launchCampaign({ campaignId: "draft", opportunityIds: ["opportunity"], expectedEmailRevision: 7, emailCopy: { mode: "custom", subject: "Injected\r\nBcc: forged@example.invalid", body: "Hello" } })).rejects.toThrow("single line");
  expect(mock.findOpportunities).not.toHaveBeenCalled();
  expect(mock.claim).not.toHaveBeenCalled();
  expect(mock.recipients).not.toHaveBeenCalled();
});
