import type { Metadata } from "next";
import { CheckInFlow } from "@/components/checkin/check-in-flow";
import { brand } from "@/lib/brand";
import { firstName, formatDate, pluralize } from "@/lib/format";
import {
  markCheckInOpened,
  resolveCheckInToken,
  type InviteRejection,
} from "@/server/services/response-service";

export const metadata: Metadata = {
  title: `${brand.companyName} Opportunity Check-In`,
  robots: { index: false, follow: false },
};

/**
 * The external contact's entire experience. One tokenized URL, no login, no
 * account, and no admin navigation — this route deliberately renders outside
 * the /admin layout and must stay that way.
 */
export default async function CheckInPage({ params }: PageProps<"/checkin/[token]">) {
  const { token } = await params;
  const resolved = await resolveCheckInToken(token);

  if (!resolved.ok) return <LinkProblem reason={resolved.reason} />;

  const { session } = resolved;
  await markCheckInOpened(session.recipientId);

  if (session.completedAt) {
    return (
      <Message
        title="You're all set"
        body={`Thanks, ${firstName(session.contactName)} — your ${session.items.length} opportunity ${pluralize(
          session.items.length,
          "update",
        )} ${session.items.length === 1 ? "was" : "were"} recorded on ${formatDate(
          session.completedAt,
        )}. There's nothing left to do.`}
      />
    );
  }

  if (session.items.length === 0) {
    return (
      <Message
        title="Nothing to review"
        body="There are no open opportunities in this check-in. Nothing else is needed from you."
      />
    );
  }

  return <CheckInFlow token={token} contactName={session.contactName} items={session.items} />;
}

const REJECTIONS: Record<InviteRejection, { title: string; body: string }> = {
  NOT_FOUND: {
    title: "This link isn't valid",
    body: "The check-in link may have been mistyped or replaced by a newer one. Check for a more recent email from IDS, or reply to it and we'll send a fresh link.",
  },
  EXPIRED: {
    title: "This link has expired",
    body: "Check-in links stop working once the campaign closes. Reply to the invitation email and we'll issue a new one.",
  },
  REVOKED: {
    title: "This link is no longer active",
    body: "This check-in link was revoked. Reply to the invitation email and we'll issue a new one.",
  },
};

function LinkProblem({ reason }: { reason: InviteRejection }) {
  const copy = REJECTIONS[reason];
  return <Message title={copy.title} body={copy.body} />;
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6 py-14">
      <p className="text-[13px] font-bold uppercase tracking-[0.16em] text-brand">
        {brand.companyName}
      </p>
      <h1 className="mt-3 text-[26px] font-semibold leading-tight tracking-tight text-ink">
        {title}
      </h1>
      <p className="mt-3 text-[17px] leading-relaxed text-body">{body}</p>
    </main>
  );
}
