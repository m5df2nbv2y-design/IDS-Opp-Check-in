import { redirect } from "next/navigation";
import Image from "next/image";
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
    <main className="relative isolate flex min-h-dvh w-full items-center justify-center overflow-hidden px-5 py-10 sm:px-10 lg:justify-end lg:px-[10vw]">
      <Image
        src="/brand/ids-login-background.jpg"
        alt=""
        fill
        priority
        sizes="100vw"
        className="-z-20 object-cover object-[42%_center]"
      />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-gradient-to-r from-slate-950/10 via-slate-950/10 to-slate-950/35" />

      <section aria-labelledby="signin-title" className="w-full max-w-[420px] rounded-3xl border border-white/80 bg-white/95 px-7 py-9 shadow-[0_24px_80px_rgba(15,23,42,0.25)] backdrop-blur-sm sm:px-10 sm:py-11">
        <Image
          src="/brand/ids-orange-logo.png"
          alt="ID Sculpture"
          width={219}
          height={128}
          priority
          className="mx-auto h-auto w-[190px]"
        />
        <div className="mb-7 mt-6 border-t border-slate-200 pt-7">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Sales Operations</p>
          <h1 id="signin-title" className="mt-3 text-[28px] font-semibold leading-tight tracking-tight text-ink">
            Opportunity Check-In
          </h1>
          <p className="mt-3 text-[15px] leading-6 text-body">
            Sign in with your IDS Microsoft account to continue.
          </p>
        </div>
        {ENTRA_CONFIGURED ? (
          <form
            action={async () => {
              "use server";
              await signIn("microsoft-entra-id", { redirectTo: from });
            }}
          >
            <button
              type="submit"
              className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-transparent bg-[#c44218] px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#a93610] focus-visible:outline-[#c44218]"
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
        <p className="mt-7 text-center text-xs leading-5 text-slate-500">IDS Sculpture · Opportunity Check-In</p>
      </section>
    </main>
  );
}
