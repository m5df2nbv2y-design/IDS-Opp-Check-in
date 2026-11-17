import { env } from "@/lib/env";
import { GraphEmailService } from "./graph-email-service";
import { MockEmailService } from "./mock-email-service";
import { ResendEmailService } from "./resend-email-service";
import type { EmailService } from "./types";

let instance: EmailService | null = null;

/** The single entry point the application uses to send mail. */
export function getEmailService(): EmailService {
  if (!instance) {
    // Trimmed and lowercased exactly as liveEmailRefusal reads it, so a value it
    // guards as live cannot quietly resolve to Mock.
    const provider = env.emailProvider.trim().toLowerCase();
    if (provider === "graph") instance = new GraphEmailService();
    else if (provider === "resend") instance = new ResendEmailService();
    else if (provider === "" || provider === "mock") instance = new MockEmailService();
    // A typo must not become Mock: production would report sends that never left.
    else throw new Error(`EMAIL_PROVIDER "${env.emailProvider}" is not recognised. Use "graph", "resend" or "mock".`);
  }
  return instance;
}

export * from "./types";
