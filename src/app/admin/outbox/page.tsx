import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/format";
import { prisma } from "@/lib/db";
import { getEmailService } from "@/server/integrations/email";

export const dynamic = "force-dynamic";

export default async function OutboxPage() {
  const emails = await prisma.emailMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const provider = getEmailService();

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
