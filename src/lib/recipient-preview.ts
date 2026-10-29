import type { LossReasonOption, RecipientOpportunity } from "@/lib/client-response";

/**
 * Fictional data for the admin-only recipient preview.
 *
 * Deliberately shaped as RecipientOpportunity — the same allowlisted payload a
 * real recipient receives — so the preview cannot accidentally demonstrate a
 * field the recipient would never be sent. One project has no creation date, so
 * the "date unavailable" state is visible rather than theoretical.
 */
export const PREVIEW_CONTACT = "Taylor Example";

export const PREVIEW_ITEMS: RecipientOpportunity[] = [
  {
    id: "fictional-meadow",
    projectName: "Meadow View Playground",
    createdDate: "2026-02-11",
    selectedStage: null,
    selectedCloseDate: null,
    currentCloseDate: "2027-05-15",
    selectedLossReason: null,
    comment: "",
  },
  {
    id: "fictional-river",
    projectName: "River Trail Climbing Area",
    createdDate: null,
    selectedStage: null,
    selectedCloseDate: null,
    currentCloseDate: "2027-08-01",
    selectedLossReason: null,
    comment: "",
  },
];

/**
 * Sample choices only. These are NOT the org's Loss Reason values — Josh has
 * not established them in Salesforce yet — so they are labelled as samples and
 * must never be presented as the final customer choices.
 */
export const PREVIEW_LOSS_REASONS: LossReasonOption[] = [
  { value: "SAMPLE_BUDGET", label: "Sample — budget unavailable" },
  { value: "SAMPLE_TIMING", label: "Sample — timing changed" },
  { value: "SAMPLE_OTHER_SUPPLIER", label: "Sample — chose another supplier" },
];
