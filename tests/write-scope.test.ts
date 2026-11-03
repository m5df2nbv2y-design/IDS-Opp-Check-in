import { afterEach, describe, expect, it, vi } from "vitest";
import { probabilityForStage } from "@/lib/client-response";

// The transport is not under test here; the PATCH body is.
vi.mock("@/server/integrations/salesforce/live/auth", () => ({
  requestAccessToken: vi.fn(async () => ({
    accessToken: "synthetic",
    instanceUrl: "https://salesforce.example.invalid",
    identityUrl: null,
  })),
}));

/**
 * The widened Salesforce write scope.
 *
 * The original scope was StageName plus CloseDate. Probability, the
 * recipient's comment and the loss reason are now writable too — but each only
 * when someone has named the field in configuration.
 *
 * The exact shape of the PATCH body IS the security boundary here, so these
 * tests assert on that object rather than on a mocked HTTP call. The property
 * that has to survive the widening: nothing reaches Salesforce that was not
 * explicitly configured AND explicitly answered.
 */

async function payloadFor(
  update: Record<string, unknown>,
  config: Record<string, string> = {},
) {
  vi.resetModules();
  vi.stubEnv("SALESFORCE_WRITE_ENABLED", "true");
  for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
  const mod = await import("@/server/integrations/salesforce/live/salesforce-service");
  return mod.buildWritePayload(update as never);
}

const OPEN = { externalId: "006x", stage: "NEGOTIATION" as const };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("nothing unconfigured is ever written", () => {
  it("writes only StageName when nothing else is configured or answered", async () => {
    expect(await payloadFor(OPEN)).toEqual({ StageName: "Negotiation" });
  });

  it("ignores a comment and a loss reason when no field names them", async () => {
    const payload = await payloadFor({
      ...OPEN,
      comment: "Board signs next week",
      lossReason: "Lost to Competitor",
    });
    // Both answered, neither configured: the data stays local, as before.
    expect(payload).toEqual({ StageName: "Negotiation" });
  });

  it("degrades to the old narrow write when the org is only half configured", async () => {
    const payload = await payloadFor(
      { ...OPEN, comment: "Board signs next week" },
      // A field name without the mode is not enough.
      { SF_FIELD_COMMENT: "Description" },
    );
    expect(payload).toEqual({ StageName: "Negotiation" });
  });
});

describe("the recipient's comment", () => {
  it("is written only when the field is named AND replace is acknowledged", async () => {
    const payload = await payloadFor(
      { ...OPEN, comment: "Board signs next week" },
      { SF_FIELD_COMMENT: "Description", SF_COMMENT_WRITE_MODE: "replace" },
    );
    expect(payload.Description).toBe("Board signs next week");
  });

  it("goes to whatever custom field is named, not a hardcoded one", async () => {
    const payload = await payloadFor(
      { ...OPEN, comment: "Board signs next week" },
      { SF_FIELD_COMMENT: "Check_In_Comment__c", SF_COMMENT_WRITE_MODE: "replace" },
    );
    expect(payload.Check_In_Comment__c).toBe("Board signs next week");
    expect(payload.Description).toBeUndefined();
  });

  it("is omitted when blank, so an empty answer cannot erase an existing value", async () => {
    // The write REPLACES the field. Sending "" for an unanswered comment would
    // silently destroy whatever the sales team had written there.
    for (const comment of ["", "   ", null, undefined]) {
      const payload = await payloadFor(
        { ...OPEN, comment },
        { SF_FIELD_COMMENT: "Description", SF_COMMENT_WRITE_MODE: "replace" },
      );
      expect(payload.Description, JSON.stringify(comment)).toBeUndefined();
    }
  });

  it("is refused under any mode other than the acknowledged one", async () => {
    for (const mode of ["append", "true", "yes", ""]) {
      const payload = await payloadFor(
        { ...OPEN, comment: "text" },
        { SF_FIELD_COMMENT: "Description", SF_COMMENT_WRITE_MODE: mode },
      );
      expect(payload.Description, mode).toBeUndefined();
    }
  });
});

describe("win probability", () => {
  it("writes the number the recipient was actually shown", async () => {
    const payload = await payloadFor(OPEN, { SF_WRITE_PROBABILITY: "true" });
    expect(payload.Probability).toBe(90);
  });

  it("is derived from the same table the UI renders, so the two cannot drift", () => {
    expect(probabilityForStage("QUALIFICATION")).toBe(10);
    expect(probabilityForStage("PROPOSAL")).toBe(50);
    expect(probabilityForStage("SPECIFIED")).toBe(75);
    expect(probabilityForStage("NEGOTIATION")).toBe(90);
  });

  it("stays out of the payload for closed stages, where the stage decides", () => {
    expect(probabilityForStage("CLOSED_LOST")).toBeNull();
  });

  it("is absent unless switched on", async () => {
    expect((await payloadFor(OPEN)).Probability).toBeUndefined();
  });
});

describe("the loss reason", () => {
  it("writes the picklist VALUE to the named custom field", async () => {
    const payload = await payloadFor(
      { externalId: "006x", stage: "CLOSED_LOST" as const, lossReason: "Lost to Competitor" },
      { SF_FIELD_LOSS_REASON: "Loss_Reason__c" },
    );
    expect(payload.Loss_Reason__c).toBe("Lost to Competitor");
    expect(payload.StageName).toBe("Closed Lost");
  });

  it("is omitted when the response carries none", async () => {
    const payload = await payloadFor(
      { externalId: "006x", stage: "CLOSED_LOST" as const, lossReason: null },
      { SF_FIELD_LOSS_REASON: "Loss_Reason__c" },
    );
    expect(payload.Loss_Reason__c).toBeUndefined();
  });
});

describe("applyUpdate refuses Closed Lost unless its reason can travel", () => {
  async function service(config: Record<string, string>) {
    vi.resetModules();
    vi.stubEnv("SALESFORCE_WRITE_ENABLED", "true");
    for (const [key, value] of Object.entries(config)) vi.stubEnv(key, value);
    const mod = await import("@/server/integrations/salesforce/live/salesforce-service");
    return new mod.LiveSalesforceService();
  }

  const closedLost = {
    externalId: "006x",
    stage: "CLOSED_LOST" as const,
    expectedLastModified: new Date("2026-11-01T12:00:00Z"),
    lossReason: "Lost to Competitor",
  };

  it("refuses when the Closed Lost switch is off", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const svc = await service({ SF_FIELD_LOSS_REASON: "Loss_Reason__c" });

    await expect(svc.applyUpdate(closedLost)).rejects.toThrow(/withheld/i);
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses when no loss reason field is configured", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const svc = await service({ SF_WRITE_CLOSED_LOST: "true" });

    await expect(svc.applyUpdate(closedLost)).rejects.toThrow(/withheld/i);
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses when the response itself carries no reason", async () => {
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const svc = await service({
      SF_WRITE_CLOSED_LOST: "true",
      SF_FIELD_LOSS_REASON: "Loss_Reason__c",
    });

    await expect(svc.applyUpdate({ ...closedLost, lossReason: null })).rejects.toThrow(/withheld/i);
    // A loss pushed with no explanation is worse than no push: the CRM shows a
    // dead opportunity and nothing about why.
    expect(network).not.toHaveBeenCalled();
  });

  it("still requires the conditional header when it does proceed", async () => {
    const network = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", network);
    const svc = await service({
      SF_WRITE_CLOSED_LOST: "true",
      SF_FIELD_LOSS_REASON: "Loss_Reason__c",
    });

    await svc.applyUpdate(closedLost);

    const init = network.mock.calls[0][1];
    expect(JSON.parse(init.body)).toEqual({
      StageName: "Closed Lost",
      Loss_Reason__c: "Lost to Competitor",
    });
    // The stale-write protection must survive the widening.
    expect(init.headers["If-Unmodified-Since"]).toBe(closedLost.expectedLastModified.toUTCString());
  });

  afterEach(() => vi.unstubAllGlobals());
});
