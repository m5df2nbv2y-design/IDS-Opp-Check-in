import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { prisma } from "@/lib/db";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Renders a captured email exactly as the rep would see it. The body is our own
 * generated template, and it is still rendered in a sandboxed iframe so nothing
 * in a message body can touch the admin page.
 */
export default async function OutboxMessagePage({ params }: PageProps<"/admin/outbox/[id]">) {
  const { id } = await params;
  const email = await prisma.emailMessage.findUnique({ where: { id } });
  if (!email) notFound();

  // A real provider stores the link with the bearer token redacted, so there is
  // a path but nothing to open. Showing it as a button would offer a dead link.
  const storedPath = email.linkUrl ? new URL(email.linkUrl).pathname : null;
  const path = storedPath && !storedPath.includes("[redacted]") ? storedPath : null;

  return (
    <div className="space-y-6">
      <div>
        <ButtonLink href="/admin/outbox" variant="ghost" size="sm" className="-ml-3 mb-1">
          ← Outbox
        </ButtonLink>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{email.subject}</h1>
        <p className="mt-1 text-[15px] text-muted">
          To {email.toName} &lt;{email.toEmail}&gt; · {formatDateTime(email.createdAt)} · via{" "}
          {email.provider}
        </p>
      </div>

      {path ? (
        <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-ink">Personalized check-in link</div>
            <div className="mt-0.5 truncate font-mono text-[12px] text-muted">{path}</div>
            <p className="mt-1.5 max-w-lg text-[12px] text-muted">
              The URL carries a random token and nothing else — no Salesforce ids, customer names,
              or email addresses.
            </p>
          </div>
          <ButtonLink href={path} variant="primary" size="sm">
            Open as {email.toName.split(" ")[0]} →
          </ButtonLink>
        </Card>
      ) : null}

      <Card className="overflow-hidden">
        <iframe
          title="Email preview"
          srcDoc={email.html}
          sandbox=""
          className="h-[620px] w-full border-0 bg-canvas"
        />
      </Card>
    </div>
  );
}
