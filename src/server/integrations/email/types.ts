export type EmailRecipient = {
  name: string;
  email: string;
};

export type OutboundEmail = {
  to: EmailRecipient;
  subject: string;
  html: string;
  text: string;
  /** INVITE | REMINDER — recorded on the outbox row for filtering. */
  kind: "INVITE" | "REMINDER";
  /** The check-in link inside the body, stored so the demo outbox can open it. */
  linkUrl?: string;
  campaignId?: string;
  contactId?: string;
};

export type EmailSendResult = {
  /** Provider-side message id when available. */
  id: string;
  status: "SENT" | "FAILED";
  error?: string;
};

export type EmailProviderInfo = {
  id: string;
  label: string;
  simulated: boolean;
};

export interface EmailService {
  readonly info: EmailProviderInfo;
  send(message: OutboundEmail): Promise<EmailSendResult>;
}
