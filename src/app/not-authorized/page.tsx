import { Card } from "@/components/ui/primitives";
import { brand } from "@/lib/brand";
import { signOut } from "@/server/auth/config";
import { getSignedInUser } from "@/server/auth/require-admin";

export const dynamic = "force-dynamic";

const EXPLANATIONS: Record<string, string> = {
  MISSING_APP_ROLE:
    "Your IDS account is signed in, but it has not been granted access to this application. Access is managed through the Sales Operations security group.",
  MISSING_GROUP:
    "Your IDS account is signed in, but it is not a member of the group authorized for this application.",
  GROUPS_OVERAGE:
    "Your group membership could not be read from the sign-in token. This is a configuration issue with the application, not with your account.",
  NOT_CONFIGURED:
    "This application has no authorization policy configured, so nobody can be granted access yet. This is a configuration issue.",
};

/**
 * Authenticated, but not permitted. Lives outside /admin so it is reachable
 * without passing the guard that sent the visitor here.
 */
export default async function NotAuthorizedPage({
  searchParams,
}: PageProps<"/not-authorized">) {
  const params = await searchParams;
  const reason = typeof params.reason === "string" ? params.reason : "MISSING_APP_ROLE";
  const user = await getSignedInUser();

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-14">
      <p className="text-[13px] font-bold uppercase tracking-[0.16em] text-brand">
        {brand.companyName}
      </p>
      <h1 className="mt-3 text-[26px] font-semibold leading-tight tracking-tight text-ink">
        You don&apos;t have access
      </h1>
      <p className="mt-2 text-[15px] text-body">
        {EXPLANATIONS[reason] ?? EXPLANATIONS.MISSING_APP_ROLE}
      </p>

      <Card className="mt-7 px-6 py-5">
        {user ? (
          <p className="text-[14px] text-muted">
            Signed in as <span className="font-medium text-ink">{user.email ?? user.name}</span>
          </p>
        ) : null}
        <p className="mt-2 text-[13px] text-muted">
          If you need access to the Opportunity Check-In console, ask Sales Operations to add
          you to the authorized group.
        </p>

        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/signin" });
          }}
        >
          <button
            type="submit"
            className="mt-4 inline-flex h-11 items-center justify-center rounded-xl border border-line-strong bg-surface px-5 text-sm font-semibold text-ink transition-colors hover:bg-canvas"
          >
            Sign out
          </button>
        </form>
      </Card>
    </main>
  );
}
