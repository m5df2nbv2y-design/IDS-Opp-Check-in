import { afterEach, describe, expect, it, vi } from "vitest";
import { emailDeliveryLabel, isUnconfirmedDelivery } from "@/lib/email-delivery";
import { readFileSync } from "node:fs";
import { completeCheckIn, postCheckInResponse } from "@/lib/check-in-transport";

afterEach(() => vi.unstubAllGlobals());

describe("honest email receipts", () => {
  it("never calls a simulated message delivered, even with a spurious timestamp", () => {
    expect(emailDeliveryLabel({ provider: "mock", status: "SENT", deliveredAt: new Date() })).toBe("Captured in Outbox — not delivered");
  });
  it("distinguishes provider acceptance from confirmed delivery", () => {
    expect(emailDeliveryLabel({ provider: "resend", status: "SENT", deliveredAt: null })).toBe("Accepted by email provider");
    expect(emailDeliveryLabel({ provider: "resend", status: "SENT", deliveredAt: new Date() })).toBe("Delivered");
  });
  it("shows failures and missing records instead of assuming a successful send", () => {
    expect(emailDeliveryLabel({ provider: "mock", status: "FAILED", deliveredAt: null })).toBe("Failed");
    expect(emailDeliveryLabel(null)).toBe("No email record");
    expect(emailDeliveryLabel({ provider: "resend", status: "PENDING", deliveredAt: null })).toBe("Acceptance unconfirmed — check Resend");
  });
  it("points an unconfirmed send at the place that can settle it for that provider", () => {
    for (const status of ["UNCERTAIN", "PENDING"]) {
      expect(emailDeliveryLabel({ provider: "resend", status, deliveredAt: null })).toBe("Acceptance unconfirmed — check Resend");
      expect(emailDeliveryLabel({ provider: "graph", status, deliveredAt: null })).toBe("Acceptance unconfirmed — check the sent mailbox");
      expect(emailDeliveryLabel({ provider: "some-other-provider", status, deliveredAt: null })).toBe("Acceptance unconfirmed — check the email provider");
    }
  });
  it("does not call an accepted Graph send delivered, because Graph reports no delivery events", () => {
    expect(emailDeliveryLabel({ provider: "graph", status: "SENT", deliveredAt: null })).toBe("Accepted by email provider");
  });
});

describe("warning tone for an unconfirmed send", () => {
  const ledger = (status: string) => ({ status });
  it("covers every unconfirmed invitation or reminder state, from the recipient or the ledger", () => {
    for (const sendStatus of ["UNCERTAIN", "PENDING", "REMINDER_PENDING", "REMINDER_UNCERTAIN"]) {
      expect(isUnconfirmedDelivery({ sendStatus }, null), sendStatus).toBe(true);
    }
    for (const status of ["UNCERTAIN", "PENDING"]) expect(isUnconfirmedDelivery({ sendStatus: "SENT" }, ledger(status)), status).toBe(true);
  });
  it("is quiet for a settled send, and never applies once a failure is recorded", () => {
    expect(isUnconfirmedDelivery({ sendStatus: "SENT" }, ledger("SENT"))).toBe(false);
    expect(isUnconfirmedDelivery({ sendStatus: "SENT" }, null)).toBe(false);
    expect(isUnconfirmedDelivery({ sendStatus: "FAILED" }, ledger("UNCERTAIN"))).toBe(false);
    expect(isUnconfirmedDelivery({ sendStatus: "UNCERTAIN" }, ledger("FAILED"))).toBe(false);
  });
});

describe("recipient preview boundary", () => {
  it("never calls response or completion endpoints in preview mode", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    expect(await postCheckInResponse("preview-only", { itemId: "fictional", stage: "PROPOSAL" }, true)).toBe(true);
    expect(await completeCheckIn("preview-only", true)).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });
  it("real answers use the existing token endpoints and report failed saves", async () => {
    const network = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error("offline")); vi.stubGlobal("fetch", network);
    const payload = { itemId: "item", stage: "PROPOSAL", comment: null, closeDate: null };
    expect(await postCheckInResponse("synthetic-token", payload)).toBe(true);
    expect(network).toHaveBeenCalledWith("/api/checkin/synthetic-token/responses", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    expect(await completeCheckIn("synthetic-token")).toBe(false);
    expect(await completeCheckIn("synthetic-token")).toBe(false);
  });
  it("guards the standalone preview with admin authentication", () => {
    const source = readFileSync(new URL("../src/app/recipient-preview/page.tsx", import.meta.url), "utf8");
    expect(source).toContain("await requireAdminPage()");
    expect(source).toContain('token="preview-only"');
    expect(source).not.toContain("resolveCheckInToken");
    expect(source).not.toContain("markCheckInOpened");
  });
});
