import { brand } from "@/lib/brand";
import { firstName, pluralize } from "@/lib/format";
import type { OutboundEmail } from "../types";

type CheckInEmailInput = {
  contactName: string;
  contactEmail: string;
  organizationName: string;
  opportunityCount: number;
  checkInUrl: string;
  campaignId: string;
  contactId: string;
};

/**
 * The invitation an external contact receives. It never names internal IDS
 * reps or exposes how the opportunities are divided up internally — from the
 * recipient's point of view this is simply "your organization's opportunities".
 */
export function buildInviteEmail(input: CheckInEmailInput): OutboundEmail {
  const name = firstName(input.contactName);
  const opportunities = `${input.opportunityCount} open ${pluralize(input.opportunityCount, "opportunity", "opportunities")}`;

  return {
    to: { name: input.contactName, email: input.contactEmail },
    subject: `${brand.companyName} Bi-Annual Opportunity Check-In`,
    kind: "INVITE",
    linkUrl: input.checkInUrl,
    campaignId: input.campaignId,
    contactId: input.contactId,
    text: [
      `Hi ${name},`,
      "",
      "It's time for our bi-annual opportunity check-in.",
      "",
      "We've pulled the currently open opportunities associated with your organization.",
      "",
      `Please take a quick moment to update their current status — ${opportunities}, about 60 seconds.`,
      "",
      `Update your opportunities: ${input.checkInUrl}`,
      "",
      "Thanks,",
      brand.companyName,
    ].join("\n"),
    html: renderEmail({
      preheader: `${opportunities} to review — about 60 seconds.`,
      heading: `Hi ${name},`,
      paragraphs: [
        "It's time for our bi-annual opportunity check-in.",
        "We've pulled the currently open opportunities associated with your organization.",
        `Please take a quick moment to update their current status — <strong>${opportunities}</strong>. It should take about 60 seconds.`,
      ],
      buttonLabel: "UPDATE MY OPPORTUNITIES",
      buttonUrl: input.checkInUrl,
      footer: `This link is personal to you and expires after the check-in closes. Questions? Just reply to this email.`,
    }),
  };
}

export function buildReminderEmail(input: CheckInEmailInput): OutboundEmail {
  const name = firstName(input.contactName);
  const opportunities = `${input.opportunityCount} open ${pluralize(input.opportunityCount, "opportunity", "opportunities")}`;

  return {
    to: { name: input.contactName, email: input.contactEmail },
    subject: `Reminder: your ${brand.companyName} opportunity check-in`,
    kind: "REMINDER",
    linkUrl: input.checkInUrl,
    campaignId: input.campaignId,
    contactId: input.contactId,
    text: [
      `Hi ${name},`,
      "",
      `You haven't completed your ${brand.companyName} opportunity check-in yet.`,
      "",
      `You have ${opportunities} waiting for a status update — it takes about 60 seconds.`,
      "",
      `Finish your check-in: ${input.checkInUrl}`,
      "",
      "Thanks,",
      brand.companyName,
    ].join("\n"),
    html: renderEmail({
      preheader: `${opportunities} still waiting on you.`,
      heading: `Hi ${name},`,
      paragraphs: [
        `You haven't completed your ${brand.companyName} opportunity check-in yet.`,
        `You have <strong>${opportunities}</strong> waiting for a status update — it takes about 60 seconds.`,
      ],
      buttonLabel: "FINISH MY CHECK-IN",
      buttonUrl: input.checkInUrl,
      footer: "Already done? You can ignore this message.",
    }),
  };
}

type EmailLayout = {
  preheader: string;
  heading: string;
  paragraphs: string[];
  buttonLabel: string;
  buttonUrl: string;
  footer: string;
};

/** Table-based layout, inline styles — the only thing email clients agree on. */
function renderEmail(layout: EmailLayout): string {
  const c = brand.colors;
  const paragraphs = layout.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:26px;color:${c.body};">${text}</p>`,
    )
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${c.canvas};">
    <span style="display:none;font-size:1px;color:${c.canvas};">${escapeHtml(layout.preheader)}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.canvas};padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${c.surface};border:1px solid ${c.line};border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0;">
                <div style="font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${c.primary};">${brand.companyName}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 8px;">
                <h1 style="margin:0 0 16px;font-size:22px;line-height:30px;color:${c.ink};font-weight:650;">${layout.heading}</h1>
                ${paragraphs}
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 28px;">
                <a href="${layout.buttonUrl}" style="display:block;background:${c.primary};color:#ffffff;text-decoration:none;text-align:center;padding:17px 24px;border-radius:10px;font-size:15px;font-weight:650;letter-spacing:0.04em;">${layout.buttonLabel}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px;">
                <p style="margin:0;font-size:16px;line-height:26px;color:${c.body};">Thanks,<br />${brand.companyName}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid ${c.line};background:${c.canvas};">
                <p style="margin:0;font-size:12px;line-height:20px;color:${c.muted};">${layout.footer}</p>
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
