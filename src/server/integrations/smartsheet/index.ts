import { env } from "@/lib/env";
import { LiveSmartsheetService } from "./live/smartsheet-service";
import { MockSmartsheetService } from "./mock/mock-smartsheet-service";
import type { SmartsheetService } from "./types";

let instance: SmartsheetService | null = null;

/**
 * The single entry point the application uses to reach Smartsheet.
 * Set SMARTSHEET_PROVIDER=smartsheet to switch from the demo signals to the
 * real integration once it's implemented (see live/smartsheet-service.ts).
 */
export function getSmartsheetService(): SmartsheetService {
  if (!instance) {
    instance =
      env.smartsheetProvider === "smartsheet"
        ? new LiveSmartsheetService()
        : new MockSmartsheetService();
  }
  return instance;
}

export * from "./types";
