import { CheckInFlow } from "@/components/checkin/check-in-flow";
import { requireAdminPage } from "@/server/auth/require-admin";
import { PREVIEW_CONTACT, PREVIEW_ITEMS, PREVIEW_LOSS_REASONS } from "@/lib/recipient-preview";

export const metadata = { title: "IDS recipient preview", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Standalone recipient UI, protected for admins; no real token or records. */
export default async function RecipientPreviewPage() {
  await requireAdminPage();
  return <CheckInFlow token="preview-only" contactName={PREVIEW_CONTACT} items={PREVIEW_ITEMS} lossReasons={PREVIEW_LOSS_REASONS} preview />;
}
