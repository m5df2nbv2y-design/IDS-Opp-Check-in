/** Pure message data shared by rendering and server email providers. No delivery code. */
export type EmailRecipient = {
  name: string;
  email: string;
};

export type OutboundEmail = {
  to: EmailRecipient;
  subject: string;
  html: string;
  text: string;
  /**
   * INVITE | REMINDER | TEST — recorded on the outbox row for filtering. TEST
   * marks a demo send to the configured demo address; it is deliberately a
   * distinct kind so a demo email can never be mistaken for outreach.
   */
  kind: "INVITE" | "REMINDER" | "TEST";
  /** The check-in link inside the body, stored so the demo outbox can open it. */
  linkUrl?: string;
  campaignId?: string;
  contactId?: string;
};
