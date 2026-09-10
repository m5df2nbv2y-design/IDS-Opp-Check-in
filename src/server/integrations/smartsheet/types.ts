/**
 * The contract between IDS Opportunity Check-In and Smartsheet.
 *
 * Today, IDS's real workflow is: Smartsheet fires an email (a reminder, a task
 * due, a comment) → a PM manually cross-references Salesforce and other sheets
 * → the PM decides what to do. This integration automates only the middle
 * step — pulling the raw signal and matching it to an existing opportunity —
 * so the dashboard can show a PM the context they'd otherwise gather by hand.
 * It does not send anything back to Smartsheet and does not write to
 * Salesforce; see src/server/services/signal-matching-service.ts and
 * smartsheet-signal-service.ts for what happens with a signal once fetched.
 *
 * The rest of the application only ever talks to `SmartsheetService`. Swapping
 * the mock provider for a real one is a factory change (see ./index.ts) — no
 * UI, service, or database code changes. This mirrors
 * src/server/integrations/salesforce/ exactly, and the two integrations never
 * call into each other.
 */

/** Controlled signal types. Real Smartsheet automations map onto these. */
export const SMARTSHEET_SIGNAL_TYPES = [
  "REMINDER",
  "TASK_DUE",
  "COMMENT",
  "STATUS_CHANGE",
] as const;
export type SmartsheetSignalType = (typeof SMARTSHEET_SIGNAL_TYPES)[number];

/**
 * One inbound event/notification from Smartsheet — a reminder firing, a task
 * coming due, a comment posted, a tracked cell changing. This is the raw shape
 * as Smartsheet would report it: identifiers are whatever free text or lookup
 * columns the sheet happens to carry, not guaranteed to resolve to anything.
 */
export type SmartsheetSignal = {
  /** Row or event id — the join key back to the source sheet. */
  externalId: string;
  sheetName: string;
  signalType: SmartsheetSignalType;
  title: string;
  message: string;
  /** Who Smartsheet says should act. Descriptive only — not used for auth. */
  assignedToName: string | null;
  dueDate: Date | null;
  occurredAt: Date;
  /** Deep link to the row in Smartsheet, when available. */
  sourceUrl: string | null;

  /**
   * Whatever the sheet carries to identify what this is about. In the best
   * case a sheet column stores the Salesforce Opportunity Id directly; more
   * often it's just free-text account/project names typed by a human, which is
   * exactly why matching (see signal-matching-service.ts) has to tolerate
   * ambiguity and outright misses rather than assume a clean join.
   */
  relatedOpportunityExternalId: string | null;
  relatedAccountName: string | null;
  relatedProjectName: string | null;
};

export type SmartsheetProviderInfo = {
  id: string;
  label: string;
  simulated: boolean;
  description: string;
};

export interface SmartsheetService {
  readonly info: SmartsheetProviderInfo;

  /**
   * Pull current signals. `since` narrows to events at/after that time; a real
   * provider would likely page a webhook queue or an activity feed instead —
   * that's an implementation detail behind this one method.
   */
  getSignals(options?: { since?: Date }): Promise<SmartsheetSignal[]>;
}

/** Error type a provider throws for source-side failures (auth, rate limit, etc). */
export class SmartsheetIntegrationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options?: { code?: string; retryable?: boolean }) {
    super(message);
    this.name = "SmartsheetIntegrationError";
    this.code = options?.code ?? "UNKNOWN_ERROR";
    this.retryable = options?.retryable ?? true;
  }
}
