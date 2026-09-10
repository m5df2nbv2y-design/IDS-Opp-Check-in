"use client";

import Link from "next/link";
import { useTransition } from "react";
import { clearSelectionsAction } from "@/app/admin/actions";
import { pluralize } from "@/lib/format";
import type { DraftSummary } from "@/server/services/campaign-draft-service";

/**
 * Always-visible readout of exactly what is selected. Deliberately states the
 * full scope — opportunities, people, accounts — so the size of the action is
 * never a surprise, and it is inert at zero selection.
 */
export function SelectionBar({ summary }: { summary: DraftSummary }) {
  const [pending, startTransition] = useTransition();
  const { selectedOpportunities, selectedContacts, selectedAccounts } = summary;
  const nothingSelected = selectedOpportunities === 0;

  return (
    <div className="sticky bottom-0 z-20 border-t border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-3">
        <div className="text-[14px]">
          {nothingSelected ? (
            <span className="text-muted">
              Nothing selected. Choose the opportunities you want to contact.
            </span>
          ) : (
            <span className="text-ink">
              <strong className="font-semibold">
                {selectedOpportunities} {pluralize(selectedOpportunities, "check-in")}
              </strong>{" "}
              to{" "}
              <strong className="font-semibold">
                {selectedContacts} {pluralize(selectedContacts, "contact")}
              </strong>{" "}
              across{" "}
              <strong className="font-semibold">
                {selectedAccounts} {pluralize(selectedAccounts, "account")}
              </strong>
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {!nothingSelected ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(async () => void (await clearSelectionsAction()))}
              className="h-10 rounded-xl px-3 text-[13px] font-medium text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              {pending ? "Clearing…" : "Clear selection"}
            </button>
          ) : null}

          {nothingSelected ? (
            <span
              className="inline-flex h-11 cursor-not-allowed items-center rounded-xl border border-line bg-canvas px-5 text-sm font-semibold text-muted"
              aria-disabled
            >
              Review selection
            </span>
          ) : (
            <Link
              href="/admin/campaigns/review"
              className="inline-flex h-11 items-center rounded-xl border border-transparent bg-brand px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-dark"
            >
              Review {selectedOpportunities} {pluralize(selectedOpportunities, "check-in")} →
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
