import { brand } from "@/lib/brand";
import { firstName } from "@/lib/format";
import type { OutboundEmail } from "../types";

export type TestCheckInEmailInput = {
  /** The real contact this check-in belongs to — shown, never sent to. */
  contactName: string;
  organizationName: string;
  /** The address the server locked this send to. */
  deliverTo: string;
  opportunityName: string;
  currentStage: string;
  closeDate: string;
  opportunityCount: number;
  /** The existing check-in URL, carrying the token already minted for the
   *  real recipient. Not a new token — the response lands in the same place. */
  checkInUrl: string;
  campaignId: string;
  contactId: string;
};

/**
 * The demo test email.
 *
 * Deliberately built from the SAME real opportunity data the customer would
 * see, so the demo shows the actual product rather than a mock-up — but the
 * `to` address is supplied by the server, never by the caller, and the body
 * invents nothing: every field here comes from a record that already exists.
 */
export function buildTestCheckInEmail(input: TestCheckInEmailInput): OutboundEmail {
  const name = firstName(input.contactName);
  const others =
    input.opportunityCount > 1
      ? ` It covers ${input.opportunityCount} open opportunities for ${input.organizationName}.`
      : "";

  return {
    to: { name: input.contactName, email: input.deliverTo },
    subject: `Project Check-In — ${input.opportunityName}`,
    kind: "TEST",
    linkUrl: input.checkInUrl,
    campaignId: input.campaignId,
    contactId: input.contactId,
    text: [
      `Hi ${name},`,
      "",
      `${brand.companyName} is checking in on ${input.opportunityName}.`,
      "",
      `Project: ${input.opportunityName}`,
      `Organization: ${input.organizationName}`,
      `Current stage: ${input.currentStage}`,
      `Expected completion: ${input.closeDate}`,
      "",
      `We keep this project's status up to date on our side, and you are the`,
      `person who actually knows where it stands.${others}`,
      "",
      `Update project status: ${input.checkInUrl}`,
      "",
      "It takes about 60 seconds.",
      "",
      "Thanks,",
      `${brand.companyName} Sales Operations`,
    ].join("\n"),
    html: renderTestEmail(input, name, others),
  };
}

/** Table layout with inline styles — the only thing email clients agree on. */
function renderTestEmail(input: TestCheckInEmailInput, name: string, others: string): string {
  const c = brand.colors;
  const row = (label: string, value: string) => `
              <tr>
                <td style="padding:9px 0;border-bottom:1px solid ${c.line};font-size:13px;color:${c.muted};width:44%;">${escapeHtml(label)}</td>
                <td style="padding:9px 0;border-bottom:1px solid ${c.line};font-size:14px;color:${c.ink};font-weight:600;text-align:right;">${escapeHtml(value)}</td>
              </tr>`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${c.canvas};">
    <span style="display:none;font-size:1px;color:${c.canvas};">${escapeHtml(`A quick status check on ${input.opportunityName} — about 60 seconds.`)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.canvas};padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${c.surface};border:1px solid ${c.line};border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0;">
                <div style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${c.primary};">${brand.companyName} Sculpture</div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 4px;">
                <h1 style="margin:0 0 16px;font-size:22px;line-height:30px;color:${c.ink};font-weight:650;">Hi ${escapeHtml(name)},</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:26px;color:${c.body};">
                  ${brand.companyName} is checking in on <strong>${escapeHtml(input.opportunityName)}</strong>.
                  We keep this project's status up to date on our side, and you are the person
                  who actually knows where it stands.${escapeHtml(others)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 32px 8px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${row("Project", input.opportunityName)}
                  ${row("Organization", input.organizationName)}
                  ${row("Current stage", input.currentStage)}
                  ${row("Expected completion", input.closeDate)}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;">
                <a href="${input.checkInUrl}" style="display:block;background:${c.primary};color:#ffffff;text-decoration:none;text-align:center;padding:17px 24px;border-radius:10px;font-size:15px;font-weight:650;letter-spacing:0.04em;">UPDATE PROJECT STATUS</a>
                <p style="margin:12px 0 0;font-size:13px;line-height:20px;color:${c.muted};text-align:center;">It takes about 60 seconds.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px;">
                <p style="margin:0;font-size:16px;line-height:26px;color:${c.body};">Thanks,<br />${brand.companyName} Sales Operations</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid ${c.line};background:${c.canvas};">
                <p style="margin:0;font-size:12px;line-height:20px;color:${c.muted};">
                  This link is personal to the recipient and expires after the check-in closes.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
