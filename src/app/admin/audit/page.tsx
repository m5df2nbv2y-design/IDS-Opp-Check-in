import { Card, EmptyState, StageChange } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import { listAuditEvents } from "@/server/services/audit-service";

export const dynamic = "force-dynamic";

const EVENT_TONE: Record<string, string> = {
  SYNC_FAILED: "bg-danger-soft text-danger",
  INVITE_FAILED: "bg-danger-soft text-danger",
  SYNC_SUCCEEDED: "bg-success-soft text-success",
  CHECKIN_COMPLETED: "bg-success-soft text-success",
  RESPONSE_SUBMITTED: "bg-brand-soft text-brand",
  RESPONSE_REVISED: "bg-brand-soft text-brand",
};

const ACTOR_LABEL: Record<string, string> = {
  EXTERNAL_CONTACT: "external contact",
  ADMIN: "IDS admin",
  SYSTEM: "system",
};

/**
 * Every entry carries the whole picture: opportunity, organization, external
 * contact, internal IDS rep, stage transition, note, campaign, and sync result.
 */
export default async function AuditPage() {
  const events = await listAuditEvents({ limit: 200 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight text-ink">Audit trail</h1>
        <p className="mt-1 text-[15px] text-muted">
          Every invitation, response, and Salesforce write, in order. This is the record to check
          when someone asks why a stage changed.
        </p>
      </div>

      {events.length === 0 ? (
        <EmptyState title="Nothing logged yet" body="Events appear as soon as a campaign starts." />
      ) : (
        <Card className="divide-y divide-line">
          {events.map((event) => (
            <div key={event.id} className="flex flex-wrap gap-x-4 gap-y-2 px-5 py-3.5">
              <div className="w-36 shrink-0 text-[13px] tabular-nums text-muted">
                {formatDateTime(event.createdAt)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${EVENT_TONE[event.type] ?? "bg-canvas text-muted"}`}
                  >
                    {event.type.replaceAll("_", " ").toLowerCase()}
                  </span>
                  <span className="text-[14px] text-ink">{event.summary}</span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                  <span>
                    by {event.actor}
                    {event.actorKind !== "SYSTEM"
                      ? ` (${ACTOR_LABEL[event.actorKind] ?? event.actorKind})`
                      : ""}
                  </span>
                  {event.account ? <span>· {event.account.name}</span> : null}
                  {event.rep ? <span>· IDS rep {event.rep.name}</span> : null}
                  {event.campaign ? <span>· {event.campaign.name}</span> : null}
                  {event.fromStatus && event.toStatus ? (
                    <StageChange
                      from={stageLabel(event.fromStatus)}
                      to={stageLabel(event.toStatus)}
                    />
                  ) : null}
                </div>

                {event.detail ? (
                  <p className="mt-1.5 text-[13px] text-body">{event.detail}</p>
                ) : null}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
