"use client";

import { useState, useTransition } from "react";
import { sendTestEmailAction } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import type { TestEmailResult } from "@/server/services/test-email-service";

type Props = {
  recipientId: string;
  /** Who the real check-in belongs to — shown so it is obvious whose data
   *  the demo email mirrors. */
  contactName: string;
  organizationName: string;
  /** The server-configured demo address, for display only. The server decides
   *  where the mail actually goes; this prop cannot influence it. */
  demoAddress: string;
};

/**
 * The demo test-email control.
 *
 * Deliberately styled apart from the normal send actions: real mail leaves the
 * building here, so it must never read as "just another button". There is no
 * address field — the destination is fixed on the server — and the button is
 * disabled while a send is in flight so a double-click cannot fire twice.
 */
export function TestEmailPanel({
  recipientId,
  contactName,
  organizationName,
  demoAddress,
}: Props) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<TestEmailResult | null>(null);

  return (
    <Card className="border-dashed border-warning/40 bg-warning-soft/30 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-warning">
            Demo — real email
          </div>
          <p className="mt-1 max-w-xl text-[13px] text-body">
            Sends one genuine email using {contactName}&rsquo;s check-in for {organizationName} —
            the same link, the same data. The response comes back into this campaign exactly
            like the simulated flow.
          </p>
          <p className="mt-1.5 text-[13px] font-medium text-ink">
            Demo email → <span className="tabular-nums">{demoAddress}</span>
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setResult(await sendTestEmailAction(recipientId));
              })
            }
          >
            {pending ? "Sending…" : "Send Test Email"}
          </Button>
          {result ? (
            <span
              className={`max-w-[16rem] text-right text-[12px] ${result.ok ? "text-success" : "text-danger"}`}
            >
              {result.ok
                ? result.alreadySent
                  ? `Already sent to ${result.sentTo} moments ago.`
                  : `Test email sent to ${result.sentTo}`
                : result.message}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
