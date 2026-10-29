import { afterEach, expect, it, vi } from "vitest";
import { env } from "@/lib/env";
import { LiveSalesforceService } from "@/server/integrations/salesforce/live/salesforce-service";
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
  expect(await service.getLossReasonOptions()).toEqual([]);
  expect(network).not.toHaveBeenCalled();
});
