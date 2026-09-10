import { requireAdmin, ForbiddenError, UnauthorizedError } from "@/server/auth/require-admin";
import { AUDIT_EVENTS, recordAudit } from "@/server/services/audit-service";

/**
 * The authorization boundary for report generation.
 *
 * Reports read the entire pipeline — every account, amount and owner — so they
 * are guarded exactly like the admin pages: requireAdmin() at the top of the
 * handler, before any data is touched. There is deliberately no unauthenticated
 * or token-based path to a report.
 */
export type ExportGuard =
  | { ok: true; actor: string }
  | { ok: false; response: Response };

export async function authorizeExport(label: string): Promise<ExportGuard> {
  try {
    const admin = await requireAdmin();
    const actor = admin.email ?? admin.name ?? "admin";
    await recordAudit({
      type: AUDIT_EVENTS.REPORT_EXPORTED,
      summary: `${actor} exported the ${label}`,
      actor,
      actorKind: "ADMIN",
    });
    return { ok: true, actor };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { ok: false, response: new Response("Sign in required", { status: 401 }) };
    }
    if (error instanceof ForbiddenError) {
      return { ok: false, response: new Response("Not authorized", { status: 403 }) };
    }
    throw error;
  }
}
