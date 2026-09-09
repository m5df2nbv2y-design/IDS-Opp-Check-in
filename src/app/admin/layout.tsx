import Link from "next/link";
import { AdminNav } from "@/components/admin/admin-nav";
import { Wordmark } from "@/components/ui/primitives";
import { brand } from "@/lib/brand";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { getEmailService } from "@/server/integrations/email";

/**
 * ===========================================================================
 *  ADMIN AUTHENTICATION GOES HERE — REQUIRED BEFORE PRODUCTION.
 * ===========================================================================
 *
 * Everything under /admin renders through this layout, and nothing else in the
 * app does. That makes this the single choke point for Microsoft Entra ID SSO.
 *
 * The rep experience (/checkin/[token]) deliberately sits outside this layout
 * and must stay that way — reps authenticate with their emailed token and must
 * never be asked to sign in.
 *
 * To add Entra ID:
 *   1. Register the app in Entra (Azure AD): redirect URI
 *      https://<host>/api/auth/callback/microsoft-entra-id, and grant the
 *      delegated `openid profile email` scopes.
 *   2. Install an OIDC library (NextAuth/Auth.js has a `microsoft-entra-id`
 *      provider) and add its route handler under /app/api/auth.
 *   3. At the top of this component, resolve the session and redirect to the
 *      sign-in route when there is none:
 *
 *        const session = await auth();
 *        if (!session) redirect("/api/auth/signin");
 *
 *   4. Restrict to the Sales Operations group — check the group/role claim from
 *      the token rather than allow-listing individual emails.
 *   5. Belt and braces: add a `proxy.ts` matcher for "/admin/:path*" so a new
 *      admin route can never be added outside this check. The server actions in
 *      ./actions.ts must assert the session too — a layout guard does not
 *      protect a POST.
 *
 * Until that lands, this area is unauthenticated and the banner below says so.
 */
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  const salesforce = getSalesforceService();
  const email = getEmailService();
  const demo = salesforce.info.simulated;

  return (
    <div className="flex min-h-dvh flex-col">
      {demo ? (
        <div className="bg-brand px-5 py-2 text-center text-[12px] font-medium text-white/95">
          Demo mode — {salesforce.info.label.toLowerCase()}, emails to the{" "}
          {email.info.label.toLowerCase()}, admin area unauthenticated. No real records are touched.
        </div>
      ) : null}

      <header className="border-b border-line bg-surface">
        <div className="mx-auto w-full max-w-6xl px-5">
          <div className="flex h-16 items-center justify-between gap-4">
            <Link href="/admin" className="flex items-baseline gap-2.5">
              <Wordmark />
              <span className="text-[15px] font-semibold tracking-tight text-ink">
                {brand.productName}
              </span>
            </Link>
            <span className="hidden text-[13px] text-muted sm:block">Sales Operations</span>
          </div>
          <AdminNav />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>

      <footer className="border-t border-line bg-surface px-5 py-5">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 text-[12px] text-muted">
          <span>
            Salesforce provider: <span className="font-medium text-body">{salesforce.info.id}</span>
          </span>
          <span>
            Email provider: <span className="font-medium text-body">{email.info.id}</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
