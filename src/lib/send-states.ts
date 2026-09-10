/**
 * The send lifecycle of a single opportunity.
 *
 *   DISCOVERED → ELIGIBLE → SELECTED → QUEUED → SENT
 *                    ↑
 *              NEEDS_ATTENTION  (terminal until the Salesforce data is fixed)
 *
 * The governing rule: **discovery is never authorization to send.** Pulling an
 * opportunity from Salesforce makes it DISCOVERED; resolving a recipient makes
 * it ELIGIBLE; only a human deliberately choosing it makes it SELECTED, and
 * nothing can advance past SELECTED without that step having happened.
 *
 * NEEDS_ATTENTION is structurally unsendable — it has no resolved recipient, so
 * there is nobody to send to. It is never selectable in the UI, which means a
 * mis-click cannot include one.
 */

export const SEND_STATES = [
  "DISCOVERED",
  "ELIGIBLE",
  "SELECTED",
  "QUEUED",
  "SENT",
  "NEEDS_ATTENTION",
] as const;

export type SendState = (typeof SEND_STATES)[number];

export const SEND_STATE_LABELS: Record<SendState, string> = {
  DISCOVERED: "Discovered",
  ELIGIBLE: "Ready to select",
  SELECTED: "Selected",
  QUEUED: "Queued",
  SENT: "Sent",
  NEEDS_ATTENTION: "Needs attention",
};

/**
 * Derive an opportunity's state. Deliberately a pure function of facts we
 * already hold, so the state can never drift from the data it describes.
 */
export function deriveSendState(input: {
  /** Did recipient resolution find a contact with an email? */
  resolved: boolean;
  /** Has an admin explicitly selected this opportunity in the draft? */
  selected: boolean;
  /** Has it been placed in a campaign that has been launched? */
  queued?: boolean;
  /** Has the invitation actually gone out? */
  sent?: boolean;
}): SendState {
  if (!input.resolved) return "NEEDS_ATTENTION";
  if (input.sent) return "SENT";
  if (input.queued) return "QUEUED";
  if (input.selected) return "SELECTED";
  return "ELIGIBLE";
}

/** Only a deliberately selected, resolved opportunity may ever be sent. */
export function isSendable(state: SendState): boolean {
  return state === "SELECTED";
}

/** Whether the UI may offer a checkbox at all. */
export function isSelectable(state: SendState): boolean {
  return state === "ELIGIBLE" || state === "SELECTED";
}
