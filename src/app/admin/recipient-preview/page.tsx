import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { buildInviteEmail } from "@/server/integrations/email/templates/check-in-email";
import { PREVIEW_CONTACT, PREVIEW_ITEMS } from "@/lib/recipient-preview";

export default function RecipientExperiencePreview() {
  const email = buildInviteEmail({ contactName: PREVIEW_CONTACT, contactEmail: "taylor@example.invalid", organizationName: "Example Organization", opportunityCount: PREVIEW_ITEMS.length, checkInUrl: "https://example.invalid/personal-check-in", campaignId: "preview-only", contactId: "fictional-contact" });
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-3xl font-semibold text-ink">What your recipient sees</h1>
      <p className="text-sm leading-relaxed text-body">The email opens a personal check-in page with only that recipient’s selected projects. They choose a status for each, can adjust the expected completion date or add a note, and submit. A real recipient needs no login.</p>
      <Card className="space-y-3 p-5"><p className="text-sm text-muted">Try the same check-in interface with two fictional projects. Answers stay in your browser; no emails, records or Salesforce updates are created.</p><ButtonLink href="/recipient-preview" target="_blank" rel="noreferrer">Open recipient check-in preview →</ButtonLink></Card>
      <p className="text-sm font-semibold text-ink">Example invitation · {email.subject}</p>
      <Card className="overflow-hidden"><iframe title="Fictional recipient invitation" srcDoc={email.html} sandbox="" className="h-[650px] w-full border-0 bg-canvas" /></Card>
      <ButtonLink href="/admin/outbox" variant="ghost">← Outbox</ButtonLink>
    </div>
  );
}
