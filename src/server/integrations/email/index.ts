import { env } from "@/lib/env";
import { MockEmailService } from "./mock-email-service";
import { ResendEmailService } from "./resend-email-service";
import type { EmailService } from "./types";

let instance: EmailService | null = null;

/** The single entry point the application uses to send mail. */
export function getEmailService(): EmailService {
  if (!instance) {
    instance = env.emailProvider === "resend" ? new ResendEmailService() : new MockEmailService();
  }
  return instance;
}

export * from "./types";
