import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";
import { GraphEmailService, type GraphReadiness } from "@/server/integrations/email/graph-email-service";
import { getOrCreateDraft, getDraftSummary } from "@/server/services/campaign-draft-service";
import { requireAdminActor } from "@/server/auth/require-admin";
import { EmailComposer } from "@/components/admin/email-composer";
import { ButtonLink } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function OutboxPage({ searchParams }: PageProps<"/admin/outbox">) {
  const draft = await getOrCreateDraft(await requireAdminActor());
  const summary = await getDraftSummary(draft.id);
  const emails = await prisma.emailMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const provider = getEmailService();
  // Runs only on ?check=1; never sends. Built directly so it works while email is simulated.
  const readiness = (await searchParams).check === "1" ? await new GraphEmailService().checkReadiness() : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Outbox</h1>
        <p className="mt-1 text-[15px] text-muted">
          {provider.info.simulated
            ? "Every check-in email, captured instead of delivered. Open one to see exactly what the external contact receives — and to walk through their check-in."
            : `Sent through ${provider.info.label}. Every message is recorded here for audit.`}
        </p>
      </div>

      <Card className="space-y-3 px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Email readiness (Microsoft Graph)</h2>
          <Link href="/admin/outbox?check=1" prefetch={false} className="text-sm font-semibold text-ink underline">
            Run check
          </Link>
        </div>
        <p className="text-[14px] text-body">
          Email provider in use: <span className="font-semibold text-ink">{provider.info.label}</span>
          {provider.info.simulated ? " (simulated, nothing is delivered)" : null}
        </p>
        {readiness ? <GraphReadinessResult check={readiness} /> : (
          <p className="text-[13px] text-muted">The check sends no email. It confirms the GRAPH_* settings, the app token and the Mail.Send permission.</p>
        )}
      </Card>

      <EmailComposer key={draft.id} campaignId={draft.id} initial={draft} selectedCount={summary.selectedOpportunities} />
      <ButtonLink href="/admin/recipient-preview" variant="secondary">Preview what recipients see →</ButtonLink>

      <h2 className="text-xl font-semibold text-ink">Message history</h2>

      {emails.length === 0 ? (
        <EmptyState
          title="No emails yet"
          body="Launch a campaign and every contact's invitation will show up here."
        />
      ) : (
        <Card className="divide-y divide-line">
          {emails.map((email) => (
            <Link
              key={email.id}
              href={`/admin/outbox/${email.id}`}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-canvas"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">{email.toName}</span>
                  <span className="rounded-full border border-line bg-canvas px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                    {email.kind}
                  </span>
                  {email.status === "FAILED" ? (
                    <span className="rounded-full border border-danger/25 bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">
                      Failed
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 truncate text-[14px] text-body">{email.subject}</div>
                <div className="text-[13px] text-muted">{email.toEmail}</div>
              </div>
              <div className="text-[13px] text-muted">{formatDateTime(email.createdAt)}</div>
            </Link>
          ))}
        </Card>
      )}
    </div>
  );
}

function GraphReadinessResult({ check }: { check: GraphReadiness }) {
  const ready = check.mailSend && !check.error && check.missing.length === 0;
  return (
    <div className="space-y-2 text-[14px] text-body">
      <p className={`font-semibold ${ready ? "text-success" : "text-danger"}`}>
        {ready ? "Token and Mail.Send permission OK. The internal test send is still required." : "Not ready."}
      </p>
      <ul className="space-y-1">
        <li>Settings: {check.missing.length ? `missing ${check.missing.join(", ")}` : "all GRAPH_* settings are present"}</li>
        {check.mailbox ? <li>Sender mailbox (GRAPH_SENDER_MAILBOX): {check.mailbox}</li> : null}
        {check.error ? <li>Problem: {check.error}</li> : null}
        {!check.error && check.missing.length === 0 ? (
          <li>
            Mail.Send permission: <span className="font-semibold text-ink">{check.mailSend ? "granted" : "not granted"}</span>
            {" "}(token roles: {check.roles.length ? check.roles.join(", ") : "none — admin consent not given yet"})
          </li>
        ) : null}
      </ul>
      {ready ? (
        <p className="text-[13px] text-muted">
          Not checked here: that the mailbox exists and that IT&apos;s scoping allows this app to send as it. The internal test send confirms both.
        </p>
      ) : null}
    </div>
  );
}
