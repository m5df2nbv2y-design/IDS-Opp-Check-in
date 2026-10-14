import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { emailDeliveryLabel } from "@/lib/email-delivery";
import { formatDateTime, pluralize } from "@/lib/format";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function SendingReceipt({ params }: PageProps<"/admin/campaigns/[id]/receipt">) {
  const { id } = await params;
  const [campaign, emails] = await Promise.all([
    prisma.campaign.findUnique({ where: { id }, include: { recipients: { include: { contact: { include: { account: true } }, items: { orderBy: { position: "asc" } } } } } }),
    prisma.emailMessage.findMany({ where: { campaignId: id, kind: "INVITE" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
  ]);
  if (!campaign) notFound();
  const rows = campaign.recipients.map((recipient) => ({ recipient, email: emails.find((email) => email.contactId === recipient.contactId) ?? null }));
  const captured = rows.filter(({ email }) => email?.provider === "mock" && email.status === "SENT").length;
  const failed = rows.filter(({ recipient, email }) => email?.status === "FAILED" || (!email && recipient.sendStatus === "FAILED")).length;
  const opportunities = rows.reduce((sum, { recipient }) => sum + recipient.items.length, 0);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div><h1 className="text-3xl font-semibold tracking-tight text-ink">Sending results</h1><p className="mt-2 text-sm text-muted">{campaign.name} · {opportunities} opportunities · {rows.length} contacts</p></div>
      <Card className="space-y-2 p-5">
        {captured > 0 ? <p className="font-semibold text-brand">{captured} {pluralize(captured, "email")} captured in Outbox — not delivered.</p> : null}
        <p className="text-sm text-body">{failed > 0 ? `${failed} ${pluralize(failed, "recipient")} could not be sent. Review the record below.` : "Review each recipient’s recorded email and status below."}</p>
        <p className="text-xs text-muted">Provider acceptance is distinct from confirmed delivery. Opening a recipient link can record activity; viewing the email record does not.</p>
      </Card>
      {rows.length === 0 ? <Card className="p-5 text-muted">No invitations have been created for this campaign.</Card> : rows.map(({ recipient, email }) => (
        <Card key={recipient.id} className="space-y-3 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 break-words"><h2 className="font-semibold text-ink">{email?.toName ?? recipient.contact.name}</h2><p className="text-sm text-muted">{email?.toEmail ?? recipient.contact.email}</p><p className="mt-1 text-sm text-body">{recipient.contact.account.name}</p></div>
            <span className={`rounded-full px-3 py-2 text-xs font-semibold ${email?.status === "FAILED" || recipient.sendStatus === "FAILED" ? "bg-danger-soft text-danger" : "bg-brand-soft text-brand"}`}>{!email && recipient.sendStatus === "FAILED" ? "Failed — no email record" : emailDeliveryLabel(email)}</span>
          </div>
          <ul className="list-inside list-disc space-y-1 text-sm text-body">{recipient.items.map((item) => <li key={item.id}>{item.opportunityName}</li>)}</ul>
          {email ? <><p className="break-words text-sm font-medium text-ink">{email.subject}</p><p className="text-xs text-muted">Recorded {formatDateTime(email.createdAt)}</p><ButtonLink href={`/admin/outbox/${email.id}`} variant="secondary" size="sm">{email.status === "FAILED" ? "View email record" : "View sent email"}</ButtonLink></> : null}
          {email?.error || recipient.sendError ? <p className="break-words text-sm text-danger">{email?.error ?? recipient.sendError}</p> : null}
        </Card>
      ))}
      <div className="flex flex-wrap gap-3"><ButtonLink href={`/admin/campaigns/${id}`} variant="secondary">Campaign activity</ButtonLink><ButtonLink href="/admin/outbox" variant="ghost">Outbox</ButtonLink><ButtonLink href="/admin" variant="ghost">Dashboard</ButtonLink></div>
    </div>
  );
}
