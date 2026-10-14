"use client";

import { useState } from "react";
import { buildInviteEmail } from "@/server/integrations/email/templates/check-in-email";
import type { EmailCopy } from "@/lib/check-in-copy";
import { Card } from "@/components/ui/primitives";

type PreviewRecipient = { contactId: string; contactName: string; contactEmail: string; accountName: string; opportunityCount: number };
export function ReviewedEmailPreview({ copy, recipients }: { copy: EmailCopy; recipients: PreviewRecipient[] }) {
  const [selected, setSelected] = useState(recipients[0]?.contactId ?? "");
  const recipient = recipients.find((entry) => entry.contactId === selected) ?? recipients[0];
  if (!recipient) return null;
  const email = buildInviteEmail({ contactName: recipient.contactName, contactEmail: recipient.contactEmail, organizationName: recipient.accountName, opportunityCount: recipient.opportunityCount, copy, checkInUrl: "https://example.invalid/personal-check-in", campaignId: "preview-only", contactId: recipient.contactId });
  return (
    <Card className="overflow-hidden">
      <div className="space-y-3 border-b border-line p-5">
        <label className="block text-sm font-semibold text-ink">Preview email for
          <select value={recipient.contactId} onChange={(e) => setSelected(e.target.value)} className="mt-2 h-11 w-full max-w-full rounded-xl border border-line bg-surface px-3 text-base font-normal">
            {recipients.map((entry) => <option key={entry.contactId} value={entry.contactId}>{entry.contactName} · {entry.opportunityCount} opportunities</option>)}
          </select>
        </label>
        <p className="break-words text-sm text-body">To: {email.to.name} &lt;{email.to.email}&gt;</p>
        <p className="break-words text-sm font-semibold text-ink">Subject: {email.subject}</p>
        <p className="text-xs text-muted">This is the personalized invitation copy. The button uses a placeholder here; each recipient’s private link is added when you confirm sending.</p>
      </div>
      <iframe title={`Email preview for ${recipient.contactName}`} srcDoc={email.html} sandbox="" className="h-[650px] w-full border-0 bg-canvas" />
    </Card>
  );
}
