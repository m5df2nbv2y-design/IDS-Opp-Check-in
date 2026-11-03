import { afterEach, expect, it, vi } from "vitest";
import { env } from "@/lib/env";
import {
  LiveSalesforceService,
  resetDescribeCacheForTests,
} from "@/server/integrations/salesforce/live/salesforce-service";
vi.mock("@/server/integrations/salesforce/live/auth", () => ({ requestAccessToken: vi.fn(async () => ({ accessToken: "synthetic", instanceUrl: "https://salesforce.example.invalid", identityUrl: null })) }));
const previous = env.salesforce.writeEnabled;
afterEach(() => { vi.unstubAllGlobals(); Object.defineProperty(env.salesforce, "writeEnabled", { value: previous, configurable: true }); });
it("sends only StageName and CloseDate with the conditional header", async () => {
  Object.defineProperty(env.salesforce, "writeEnabled", { value: true, configurable: true });
  const network = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", network);
  const expectedLastModified = new Date("2026-10-28T12:00:00Z");
  const update = { externalId: "006-test", stage: "PROPOSAL" as const, closeDate: "2027-12-31", expectedLastModified, Probability: 100, Description: "must not write" };
  await new LiveSalesforceService().applyUpdate(update);
  const init = network.mock.calls[0][1];
  expect(JSON.parse(init.body)).toEqual({ StageName: "Proposal", CloseDate: "2027-12-31" });
  expect(init.headers["If-Unmodified-Since"]).toBe(expectedLastModified.toUTCString());
});
it("refuses disabled writes, Closed Lost, invalid dates and unconditioned legacy writes", async () => {
  const network = vi.fn(); vi.stubGlobal("fetch", network);
  const service = new LiveSalesforceService();
  const base = { externalId: "006-test", stage: "PROPOSAL" as const, expectedLastModified: new Date() };
  Object.defineProperty(env.salesforce, "writeEnabled", { value: false, configurable: true });
  await expect(service.applyUpdate(base)).rejects.toThrow();
  Object.defineProperty(env.salesforce, "writeEnabled", { value: true, configurable: true });
  await expect(service.applyUpdate({ ...base, stage: "CLOSED_LOST" })).rejects.toThrow();
  await expect(service.applyUpdate({ ...base, closeDate: "2027-02-30" })).rejects.toThrow();
  await expect(service.updateOpportunityStatus("006-test", "PROPOSAL")).rejects.toThrow();
  // The contract under test: a refused WRITE never reaches the API.
  expect(network).not.toHaveBeenCalled();
});

it("reads Loss Reason choices from the org, and degrades without throwing", async () => {
  // Reading the choices legitimately calls Describe now — they are no longer
  // hardcoded — so this is deliberately separate from the no-network assertion
  // above, which is about refused writes.
  const describe = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        fields: [{
          label: "Loss Reason",
          type: "picklist",
          picklistValues: [
            { active: true, value: "Lost to Competitor", label: "Lost to Competitor" },
            { active: false, value: "Retired", label: "Retired" },
          ],
        }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", describe);

  expect(await new LiveSalesforceService().getLossReasonOptions()).toEqual([
    { value: "Lost to Competitor", label: "Lost to Competitor" },
  ]);
  expect(describe).toHaveBeenCalled();
  expect(String(describe.mock.calls[0][0])).toContain("/sobjects/Opportunity/describe");
});

it("returns no choices rather than throwing when Describe is unavailable", async () => {
  // A metadata outage must not surface as a broken check-in page. Callers
  // treat an empty list as "Closed Lost cannot be offered", which is safe.
  //
  // The cache is module-global and the test above populated it, so this asks
  // for the COLD-cache behaviour explicitly. Warm, the correct answer is the
  // opposite: a cached list should survive an outage rather than be discarded.
  resetDescribeCacheForTests();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
  await expect(new LiveSalesforceService().getLossReasonOptions()).resolves.toEqual([]);
});
