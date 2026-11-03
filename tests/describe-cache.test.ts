import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Caching the Opportunity Describe.
 *
 * Before this, getLossReasonOptions() called Salesforce on every render of the
 * public check-in page and again on every Closed Lost save — one API call per
 * page load, against the org's daily limit, for metadata that changes about
 * once a year.
 *
 * Two properties matter beyond "it caches", and both are about failure:
 *   - a BURST on a cold cache must make one call, not one per visitor, because
 *     a campaign send is precisely a burst
 *   - a transport FAILURE must NOT be cached, or one network blip refuses
 *     Closed Lost for the whole TTL
 */

vi.mock("@/server/integrations/salesforce/live/auth", () => ({
  requestAccessToken: vi.fn(async () => ({
    accessToken: "synthetic",
    instanceUrl: "https://salesforce.example.invalid",
    identityUrl: null,
  })),
}));

const DESCRIBE_BODY = {
  fields: [
    {
      label: "Loss Reason",
      type: "picklist",
      picklistValues: [
        { active: true, value: "Lost to Competitor", label: "Lost to Competitor" },
        { active: true, value: "Reduced Scope", label: "Reduced Scope" },
      ],
    },
  ],
};

function describeResponse(body: unknown = DESCRIBE_BODY) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function freshService() {
  vi.resetModules();
  const mod = await import("@/server/integrations/salesforce/live/salesforce-service");
  mod.resetDescribeCacheForTests();
  return { service: new mod.LiveSalesforceService(), mod };
}

beforeEach(() => {
  vi.stubEnv("SALESFORCE_PROVIDER", "salesforce");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the Describe is not re-fetched for every caller", () => {
  it("calls Salesforce once across many sequential reads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(describeResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { service } = await freshService();

    for (let i = 0; i < 25; i += 1) await service.getLossReasonOptions();

    const describeCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/describe"),
    );
    expect(describeCalls).toHaveLength(1);
  });

  it("returns the same choices from cache as from the live read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(describeResponse()));
    const { service } = await freshService();

    const first = await service.getLossReasonOptions();
    const second = await service.getLossReasonOptions();

    expect(second).toEqual(first);
    expect(first.map((o) => o.value)).toEqual(["Lost to Competitor", "Reduced Scope"]);
  });

  it("collapses a CONCURRENT burst into one call — the campaign-send case", async () => {
    // A send puts many recipients on the check-in page at once. Without
    // single-flight, every one of them would miss the cold cache and fire its
    // own Describe: the exact burst the cache exists to prevent.
    let resolveDescribe: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveDescribe = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    const { service } = await freshService();

    const burst = Promise.all(
      Array.from({ length: 20 }, () => service.getLossReasonOptions()),
    );
    resolveDescribe(describeResponse());
    const results = await burst;

    const describeCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/describe"),
    );
    expect(describeCalls).toHaveLength(1);
    // And every caller still got the real answer, not an empty list.
    for (const result of results) expect(result).toHaveLength(2);
  });
});

describe("failures are deliberately not cached", () => {
  it("retries on the next call rather than refusing for the whole window", async () => {
    // Caching a transport failure would turn one network blip into Closed Lost
    // being refused for ten minutes.
    //
    // The outage has to outlast readWithRetry's own attempts, or the retry
    // satisfies the call and nothing ever fails — which is what a naive
    // mockRejectedValueOnce actually does here.
    let down = true;
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      if (down && String(args[0]).includes("/describe")) throw new Error("socket hang up");
      return describeResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const { service } = await freshService();

    const failed = await service.getLossReasonOptions();
    expect(failed).toEqual([]);

    down = false;
    const recovered = await service.getLossReasonOptions();
    expect(recovered).toHaveLength(2);
  });

  it("does not pin later callers to a rejected in-flight promise", async () => {
    let down = true;
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      if (down && String(args[0]).includes("/describe")) throw new Error("socket hang up");
      return describeResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const { service } = await freshService();

    // Two callers arrive together; the shared request fails for both.
    const [a, b] = await Promise.all([
      service.getLossReasonOptions(),
      service.getLossReasonOptions(),
    ]);
    expect(a).toEqual([]);
    expect(b).toEqual([]);

    // The next caller must get a fresh attempt, not the stale rejection.
    down = false;
    expect(await service.getLossReasonOptions()).toHaveLength(2);
  });
});

describe("a refusal IS cached, because it is a fact about the org", () => {
  it("does not re-ask when the org's configuration is the reason", async () => {
    // RECORD_TYPE_SCOPED stays true until someone changes Salesforce, so
    // re-asking every render would spend API calls learning the same thing.
    const fetchMock = vi.fn().mockResolvedValue(
      describeResponse({
        ...DESCRIBE_BODY,
        recordTypeInfos: [{ available: true, master: false }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { service } = await freshService();

    expect(await service.getLossReasonOptions()).toEqual([]);
    expect(await service.getLossReasonOptions()).toEqual([]);

    const describeCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/describe"),
    );
    expect(describeCalls).toHaveLength(1);
  });
});

describe("a warm cache outlives an outage", () => {
  it("keeps serving the known choices when Describe stops answering", async () => {
    // The inverse of the cold-cache case, and the one that matters in
    // production: having read the list successfully, a later Salesforce
    // outage should not take Closed Lost away from recipients.
    let down = false;
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      if (down && String(args[0]).includes("/describe")) throw new Error("socket hang up");
      return describeResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const { service } = await freshService();

    expect(await service.getLossReasonOptions()).toHaveLength(2);

    down = true;
    expect(await service.getLossReasonOptions()).toHaveLength(2);
  });
});
