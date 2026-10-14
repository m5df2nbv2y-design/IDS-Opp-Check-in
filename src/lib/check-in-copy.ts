import { brand } from "@/lib/brand";

export const STANDARD_CHECK_IN_SUBJECT = `${brand.companyName} Bi-Annual Opportunity Check-In`;
export const STANDARD_CHECK_IN_BODY = "It's time for our bi-annual opportunity check-in.\n\nWe've pulled the currently open opportunities associated with your organization.";
export type EmailCopy = { mode: "standard" | "custom"; subject: string; body: string };
export type SavedEmailCopy = { emailSubject: string | null; emailBody: string | null; emailRevision: number };
export class DraftEmailConflictError extends Error {}

export function readEmailCopy(saved: SavedEmailCopy): EmailCopy {
  if (saved.emailSubject !== null && saved.emailBody !== null) {
    return { mode: "custom", subject: saved.emailSubject, body: saved.emailBody };
  }
  return { mode: "standard", subject: STANDARD_CHECK_IN_SUBJECT, body: STANDARD_CHECK_IN_BODY };
}

/** Shared client/server validation. Subject headers cannot contain line breaks. */
export function validateEmailCopy(input: unknown): EmailCopy {
  if (!input || typeof input !== "object") throw new Error("Choose an email type.");
  const value = input as Partial<EmailCopy>;
  if (value.mode === "standard") return readEmailCopy({ emailSubject: null, emailBody: null, emailRevision: 0 });
  if (value.mode !== "custom" || typeof value.subject !== "string" || typeof value.body !== "string") {
    throw new Error("Enter a subject and message for your custom email.");
  }
  if (/[\r\n\u0000]/.test(value.subject)) throw new Error("The subject must be a single line.");
  const subject = value.subject.trim();
  const body = value.body.replace(/\r\n?/g, "\n").trim();
  if (!subject || subject.length > 200) throw new Error("Enter a subject between 1 and 200 characters.");
  if (!body || body.length > 5000 || body.includes("\u0000")) throw new Error("Enter a message between 1 and 5,000 characters.");
  return { mode: "custom", subject, body };
}

export function requireEmailRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Reload the email draft and try again.");
  return value;
}
