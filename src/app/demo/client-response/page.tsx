import { notFound } from "next/navigation";
import { CheckInFlow } from "@/components/checkin/check-in-flow";

export default function ClientResponsePreview() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <CheckInFlow token="fictional-preview" contactName="Alex Taylor" preview
    lossReasons={[
      { value: "DEMO_BUDGET", label: "Budget unavailable" },
      { value: "DEMO_CANCELLED", label: "Project cancelled" },
      { value: "DEMO_COMPETITOR", label: "Selected another supplier" },
    ]}
    items={[
      { id: "preview-1", projectName: "Riverside Community Playground", createdDate: "2026-03-18", selectedStage: null, currentCloseDate: "2026-12-15", selectedCloseDate: null, selectedLossReason: null, comment: "" },
      { id: "preview-2", projectName: "Meadow Park Nature Play", createdDate: "2026-06-05", selectedStage: null, currentCloseDate: null, selectedCloseDate: null, selectedLossReason: null, comment: "" },
    ]} />;
}
