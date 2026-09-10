import { env } from "@/lib/env";
import {
  SmartsheetIntegrationError,
  type SmartsheetProviderInfo,
  type SmartsheetService,
  type SmartsheetSignal,
} from "../types";

/**
 * ===========================================================================
 *  THIS IS WHERE THE REAL SMARTSHEET INTEGRATION PLUGS IN — NOT YET WRITTEN.
 * ===========================================================================
 *
 * Unlike the Salesforce live provider, this one is intentionally a stub. It
 * exists so `SMARTSHEET_PROVIDER=smartsheet` is a real, wired-up switch (the
 * factory in ../index.ts already returns this class for that value) rather
 * than a config option that silently does nothing — but it does not guess at
 * Smartsheet's real API shape, because that shape isn't decided yet:
 *
 *   - Is this a webhook receiver (Smartsheet pushes row/cell change events to
 *     us) or a poller (we call GET /sheets/{id} on an interval)? Smartsheet
 *     supports both; IDS's actual sheets and automations decide which fits.
 *   - Which sheet(s) carry the reminders/tasks PMs currently get by email, and
 *     which columns hold the account/project/Salesforce-Opportunity-Id
 *     references that src/server/services/signal-matching-service.ts expects?
 *   - Auth: Smartsheet API tokens are simpler than Salesforce's OAuth flow —
 *     a single bearer token (`SMARTSHEET_API_KEY`) is likely sufficient.
 *
 * Once those are answered, implement `getSignals()` against the real
 * Smartsheet REST API (https://smartsheet.redoc.ly) or webhook payloads, map
 * the result into `SmartsheetSignal`, and nothing else in the application
 * changes — `signal-matching-service.ts` and the dashboard only see the
 * `SmartsheetService` interface, never Smartsheet's actual response shape.
 */
export class LiveSmartsheetService implements SmartsheetService {
  readonly info: SmartsheetProviderInfo = {
    id: "smartsheet",
    label: "Smartsheet",
    simulated: false,
    description: "Live Smartsheet integration — not yet implemented.",
  };

  async getSignals(): Promise<SmartsheetSignal[]> {
    if (!env.smartsheet.apiKey) {
      throw new SmartsheetIntegrationError(
        "Smartsheet credentials are not configured. Set SMARTSHEET_API_KEY, or run with SMARTSHEET_PROVIDER=mock.",
        { code: "NOT_CONFIGURED", retryable: false },
      );
    }
    throw new SmartsheetIntegrationError(
      "The live Smartsheet integration is not implemented yet. Set SMARTSHEET_PROVIDER=mock.",
      { code: "NOT_IMPLEMENTED", retryable: false },
    );
  }
}
