import Link from "next/link";
import { AdminNav } from "@/components/admin/admin-nav";
import { SignOutButton } from "@/components/admin/sign-out-button";
import Image from "next/image";
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
    <div className="ids-admin min-h-dvh bg-canvas">
      <aside className="ids-sidebar">
        <Link href="/admin" aria-label="IDS dashboard" className="mx-6 mt-6 flex justify-center rounded-xl bg-white p-3"><Image src="/brand/ids-orange-logo.png" alt="IDS" width={219} height={128} className="h-auto w-36" /></Link>
        <p className="px-6 pb-6 pt-4 text-sm font-semibold text-white">{brand.productName}</p>
        <AdminNav />
        <p className="mt-auto px-6 py-8 text-xs leading-relaxed text-white/65">Designed to inspire.<br />Built to last.</p>
      </aside>
      <div className="ids-admin-body">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-line bg-white px-4 py-5 sm:px-8">
          <Link href="/admin" className="text-sm font-semibold text-ink">IDS / Opportunity Check-In</Link>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="rounded-full bg-brand-soft px-3 py-2 font-medium text-brand">{demo ? "Salesforce simulated" : "Salesforce catalog"} · {email.info.simulated ? "Email simulated" : "Email live"}</span>
            <span className="break-all text-muted">{admin.email ?? admin.name}</span><SignOutButton />
          </div>
        </header>
        <div className="ids-mobile-nav"><AdminNav /></div>
        <main id="admin-content" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
