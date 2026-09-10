/**
 * Sample Smartsheet signals used by the mock provider.
 *
 * This is the ONLY file in the application containing fake Smartsheet data.
 * The externalIds/account/project names deliberately line up with records in
 * src/server/integrations/salesforce/mock/mock-data.ts so the matching demo is
 * concrete: some signals name a Salesforce Opportunity Id directly, some only
 * carry free-text names a human typed into a sheet, and that is exactly what
 * makes matching worth automating rather than just joining on a foreign key.
 *
 * Covers, on purpose, every outcome signal-matching-service.ts can produce:
 *   - matched by an explicit Opportunity Id column      (rows 1 and 5)
 *   - matched by account + project name, no id column    (row 2)
 *   - ambiguous — account has more than one open opportunity, no project name
 *     narrows it down                                    (row 3)
 *   - unmatched — the account isn't one IDS has on file  (row 4)
 */

export type MockSmartsheetSignalSeed = {
  externalId: string;
  sheetName: string;
  signalType: "REMINDER" | "TASK_DUE" | "COMMENT" | "STATUS_CHANGE";
  title: string;
  message: string;
  assignedToName: string | null;
  dueDate: string | null;
  occurredAt: string;
  sourceUrl: string | null;
  relatedOpportunityExternalId?: string;
  relatedAccountName?: string;
  relatedProjectName?: string;
};

export const MOCK_SMARTSHEET_SIGNALS: MockSmartsheetSignalSeed[] = [
  {
    externalId: "ss-row-4471",
    sheetName: "IDS Ops Tracker — Distributor Projects",
    signalType: "REMINDER",
    title: "Reminder: Confirm updated install timeline",
    message:
      "ABC Distribution flagged a schedule change on the Memorial Hospital MRI project. Confirm the revised install date before Friday.",
    assignedToName: "John Smith",
    dueDate: "2026-09-12",
    occurredAt: "2026-09-08T14:32:00.000Z",
    sourceUrl: "https://app.smartsheet.com/sheets/mock/rows/4471",
    relatedOpportunityExternalId: "006Ab00000Opp01AAA",
    relatedAccountName: "ABC Distribution",
    relatedProjectName: "MRI Suite Renovation",
  },
  {
    externalId: "ss-row-4483",
    sheetName: "Agency Partner Tracker",
    signalType: "TASK_DUE",
    title: "Task due: Submit revised pricing sheet",
    message:
      "XYZ Agency requested an updated pricing sheet for the cath lab project ahead of their internal budget review.",
    assignedToName: "John Smith",
    dueDate: "2026-09-10",
    occurredAt: "2026-09-07T09:15:00.000Z",
    sourceUrl: "https://app.smartsheet.com/sheets/mock/rows/4483",
    relatedAccountName: "XYZ Agency",
    relatedProjectName: "Cardiac Cath Lab Modernization",
  },
  {
    externalId: "ss-row-4502",
    sheetName: "Direct Client Follow-Ups",
    signalType: "TASK_DUE",
    title: "Task: Send updated quote to Cornerstone Health Partners",
    message:
      "Cornerstone's ops contact asked for an updated quote reflecting this quarter's list pricing. No specific project named on the row.",
    assignedToName: "David Chen",
    dueDate: "2026-09-11",
    occurredAt: "2026-09-08T11:00:00.000Z",
    sourceUrl: "https://app.smartsheet.com/sheets/mock/rows/4502",
    relatedAccountName: "Cornerstone Health Partners",
  },
  {
    externalId: "ss-row-4519",
    sheetName: "New Referral Intake",
    signalType: "COMMENT",
    title: "New comment: Site visit requested",
    message:
      "Comment posted on the intake row: \"Can we get someone out to walk the site next week?\" Referral source is not yet linked to an account in Salesforce.",
    assignedToName: "Mike Brown",
    dueDate: null,
    occurredAt: "2026-09-09T08:20:00.000Z",
    sourceUrl: "https://app.smartsheet.com/sheets/mock/rows/4519",
    relatedAccountName: "Meridian Referral Partners",
  },
  {
    externalId: "ss-row-4460",
    sheetName: "IDS Ops Tracker — Agency Projects",
    signalType: "STATUS_CHANGE",
    title: "Row flagged: At Risk",
    message:
      "Ops tracker row for the Hybrid OR design-assist project was flagged \"At Risk\" — XYZ Agency noted a delay on architect sign-off.",
    assignedToName: "John Smith",
    dueDate: null,
    occurredAt: "2026-09-06T16:45:00.000Z",
    sourceUrl: "https://app.smartsheet.com/sheets/mock/rows/4460",
    relatedOpportunityExternalId: "006Ab00000Opp08AAA",
    relatedAccountName: "XYZ Agency",
    relatedProjectName: "Hybrid OR — Design Assist",
  },
];
