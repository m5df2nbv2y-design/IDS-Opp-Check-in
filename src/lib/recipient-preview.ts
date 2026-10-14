import type { CheckInSessionItem } from "@/server/services/response-service";

export const PREVIEW_CONTACT = "Taylor Example";
export const PREVIEW_ITEMS: CheckInSessionItem[] = [
  { id: "fictional-meadow", customerName: "Example Parks Department", projectName: "Meadow View Playground", amount: 42000, currentStage: "PROPOSAL", selectedStage: null, currentCloseDate: "2027-05-15", selectedCloseDate: null, comment: "", submitted: false },
  { id: "fictional-river", customerName: "Example Community Center", projectName: "River Trail Climbing Area", amount: 28000, currentStage: "QUALIFICATION", selectedStage: null, currentCloseDate: "2027-08-01", selectedCloseDate: null, comment: "", submitted: false },
];
