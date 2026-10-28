import type { OutboundEmail } from "@/lib/email-message";
export type { EmailRecipient, OutboundEmail } from "@/lib/email-message";

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
