import { redirect } from "next/navigation";
import { Card } from "@/components/ui/primitives";
import { brand } from "@/lib/brand";
import { signIn } from "@/server/auth/config";
import { DEV_BYPASS_ENABLED, ENTRA_CONFIGURED } from "@/server/auth/config";
import { getAdminUser } from "@/server/auth/require-admin";

export const dynamic = "force-dynamic";

/**
 * Sign-in for the IDS admin console. Lives OUTSIDE /admin so it is reachable
 * without a session — everything under /admin requires one.
 *
 * External contacts never see this page: they authenticate with the token in
 * their email at /checkin/[token], which has no login of any kind.
 */
export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const params = await searchParams;
  const from = typeof params.from === "string" ? params.from : "/admin";

  // Already signed in — nothing to do here.
  if (await getAdminUser()) redirect(from);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-14">
      <p className="text-[13px] font-bold uppercase tracking-[0.16em] text-brand">
        {brand.companyName}
      </p>
      <h1 className="mt-3 text-[26px] font-semibold leading-tight tracking-tight text-ink">
        Opportunity Check-In
      </h1>
      <p className="mt-2 text-[15px] text-muted">
        Sales Operations console. Sign in with your IDS account to continue.
      </p>

      <Card className="mt-7 px-6 py-6">
        {ENTRA_CONFIGURED ? (
          <form
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: from });
            }}
          >
            <button
              type="submit"
              className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-transparent bg-brand px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark"
            >
              Sign in with Microsoft
            </button>
          </form>
        ) : null}

        {DEV_BYPASS_ENABLED ? (
          <>
            {ENTRA_CONFIGURED ? (
              <div className="my-4 text-center text-[12px] uppercase tracking-wide text-muted">
                or
              </div>
            ) : null}
            <form
              action={async () => {
                "use server";
                await signIn("dev-bypass", { redirectTo: from });
              }}
            >
              <button
                type="submit"
                className="inline-flex h-12 w-full items-center justify-center rounded-xl border border-line-strong bg-surface px-5 text-sm font-semibold text-ink transition-colors hover:bg-canvas"
              >
                Continue as local admin
              </button>
            </form>
            <p className="mt-3 text-[12px] text-warning">
              Development sign-in. This option does not exist in a production build.
            </p>
          </>
        ) : null}

        {!ENTRA_CONFIGURED && !DEV_BYPASS_ENABLED ? (
          <div className="text-[14px] text-danger">
            <p className="font-semibold">No sign-in method is configured.</p>
            <p className="mt-2 text-body">
              Set <code className="font-mono text-[13px]">AUTH_MICROSOFT_ENTRA_ID_ID</code> and{" "}
              <code className="font-mono text-[13px]">AUTH_MICROSOFT_ENTRA_ID_SECRET</code> for
              Entra ID, or <code className="font-mono text-[13px]">AUTH_DEV_BYPASS=true</code> for
              local development.
            </p>
          </div>
        ) : null}
      </Card>
    </main>
  );
}
