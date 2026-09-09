import { env } from "@/lib/env";
import { LiveSalesforceService } from "./live/salesforce-service";
import { MockSalesforceService } from "./mock/mock-salesforce-service";
import type { SalesforceService } from "./types";

let instance: SalesforceService | null = null;

/**
 * The single entry point the application uses to reach Salesforce/SFX.
 * Set SALESFORCE_PROVIDER=salesforce to switch from the demo org to a real one.
 */
export function getSalesforceService(): SalesforceService {
  if (!instance) {
    instance =
      env.salesforceProvider === "salesforce"
        ? new LiveSalesforceService()
        : new MockSalesforceService();
  }
  return instance;
}

/** Mock-only helpers, used by the seed script and the demo org viewer. */
export function getMockSalesforceService(): MockSalesforceService {
  const service = getSalesforceService();
  if (!(service instanceof MockSalesforceService)) {
    throw new Error("Mock Salesforce helpers are unavailable when a real provider is configured.");
  }
  return service;
}

export * from "./types";
