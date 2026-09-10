import type { SmartsheetProviderInfo, SmartsheetService, SmartsheetSignal } from "../types";
import { MOCK_SMARTSHEET_SIGNALS } from "./mock-data";

/**
 * Mock Smartsheet provider.
 *
 * Unlike the mock Salesforce provider, this one is read-only and stateless —
 * there is no write-back path to simulate, so a static fixture list is enough.
 * Signals are fixed, not randomly generated, so repeated ingestion runs are
 * deterministic and idempotent (see smartsheet-signal-service.ts, which
 * upserts by externalId).
 */
export class MockSmartsheetService implements SmartsheetService {
  readonly info: SmartsheetProviderInfo = {
    id: "mock",
    label: "Mock Smartsheet workspace",
    simulated: true,
    description:
      "Fixed demo signals served through the same interface as the real integration. No external credentials required.",
  };

  async getSignals(options?: { since?: Date }): Promise<SmartsheetSignal[]> {
    const signals = MOCK_SMARTSHEET_SIGNALS.map(toDomain);
    if (!options?.since) return signals;
    return signals.filter((signal) => signal.occurredAt >= options.since!);
  }
}

function toDomain(seed: (typeof MOCK_SMARTSHEET_SIGNALS)[number]): SmartsheetSignal {
  return {
    externalId: seed.externalId,
    sheetName: seed.sheetName,
    signalType: seed.signalType,
    title: seed.title,
    message: seed.message,
    assignedToName: seed.assignedToName,
    dueDate: seed.dueDate ? new Date(`${seed.dueDate}T00:00:00.000Z`) : null,
    occurredAt: new Date(seed.occurredAt),
    sourceUrl: seed.sourceUrl,
    relatedOpportunityExternalId: seed.relatedOpportunityExternalId ?? null,
    relatedAccountName: seed.relatedAccountName ?? null,
    relatedProjectName: seed.relatedProjectName ?? null,
  };
}
