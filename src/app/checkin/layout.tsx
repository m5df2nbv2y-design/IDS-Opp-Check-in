import type { ReactNode } from "react";
import { RecipientShell } from "@/components/checkin/recipient-shell";

export default function CheckInLayout({ children }: { children: ReactNode }) {
  return <RecipientShell>{children}</RecipientShell>;
}
