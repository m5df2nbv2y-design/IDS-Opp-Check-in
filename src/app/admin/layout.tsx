import Link from "next/link";
import { AdminNav } from "@/components/admin/admin-nav";
import { SignOutButton } from "@/components/admin/sign-out-button";
import { Wordmark } from "@/components/ui/primitives";
import { brand } from "@/lib/brand";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { getEmailService } from "@/server/integrations/email";
import { requireAdminPage } from "@/server/auth/require-admin";

/**
 * Every /admin route renders through this layout, and nothing else does, which
 * makes it the natural place for the page-level guard.
 *
 * It is NOT the only guard. A layout does not protect a POST, so every server
 * action in ./actions.ts asserts for itself via requireAdmin(). See
 * src/server/auth/require-admin.ts.
 *
 * The external check-in experience at /checkin/[token] deliberately renders
 * outside this layout and has no authentication — recipients authenticate with
 * the token in their email and must never see a login screen.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  // Page-level enforcement. Redirects an unauthenticated visitor to sign-in.
  const admin = await requireAdminPage();

  const salesforce = getSalesforceService();
  const email = getEmailService();
  const demo = salesforce.info.simulated;

  return (
    <div className="flex min-h-dvh flex-col">
      {demo ? (
        <div className="bg-brand px-5 py-2 text-center text-[12px] font-medium text-white/95">
          Demo mode — {salesforce.info.label.toLowerCase()}, emails to the{" "}
          {email.info.label.toLowerCase()}. No real records are touched.
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
            <div className="hidden items-center gap-3 sm:flex">
              <span className="text-[13px] text-muted">{admin.email ?? admin.name}</span>
              <SignOutButton />
            </div>
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
