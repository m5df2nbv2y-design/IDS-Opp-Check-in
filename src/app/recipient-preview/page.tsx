import { CheckInFlow } from "@/components/checkin/check-in-flow";
import { RecipientShell } from "@/components/checkin/recipient-shell";
import { requireAdminPage } from "@/server/auth/require-admin";
import { getSalesforceService } from "@/server/integrations/salesforce";
import { PREVIEW_CONTACT, PREVIEW_ITEMS } from "@/lib/recipient-preview";

export const metadata = { title: "IDS recipient preview", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Standalone recipient UI, protected for admins. Fictional projects, nothing is
 * saved, but the shell and the Loss Reason choices are the real ones, loaded
 * exactly as /checkin/[token] loads them.
 */
export default async function RecipientPreviewPage() {
  await requireAdminPage();
  const salesforce = getSalesforceService();
  const lossReasons = await salesforce.getLossReasonOptions?.().catch(() => []) ?? [];
  const note = lossReasons.length === 0
    ? "No Loss Reason choices are available right now, so recipients can't answer Closed Lost. Salesforce may be unreachable, or the Opportunity Loss Reason picklist can't be read; the server log says which."
    : salesforce.info.simulated
      ? "Simulated Salesforce: these Loss Reason choices are demo values, not your org's picklist."
      : null;
  return (
    <RecipientShell>
      {note ? (
        <p role="status" className="mx-auto mb-4 max-w-lg rounded-lg bg-white/95 px-4 py-3 text-sm text-ink shadow">{note}</p>
      ) : null}
      <CheckInFlow token="preview-only" contactName={PREVIEW_CONTACT} items={PREVIEW_ITEMS} lossReasons={lossReasons} preview />
    </RecipientShell>
  );
}
