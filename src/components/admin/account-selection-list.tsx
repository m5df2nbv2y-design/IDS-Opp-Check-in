"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { setSelectionAction } from "@/app/admin/actions";
import { AccountTypeBadge, Card } from "@/components/ui/primitives";
import { accountTypeLabel } from "@/lib/account-types";
import { formatAmount, formatDate, pluralize } from "@/lib/format";
import { stageLabel } from "@/lib/stages";
import type { DraftAccountGroup, DraftOpportunityRow } from "@/server/services/campaign-draft-service";

/**
 * Account-oriented browsing, opportunity-level selection.
 *
 * The account checkbox is shorthand ONLY for the sendable opportunities
 * currently displayed beneath it — never "everything for this account". When a
 * filter is active it therefore selects only what is on screen, which is why
 * the expanded rows always show precisely what a click just did.
 */
export function AccountSelectionList({ accounts }: { accounts: DraftAccountGroup[] }) {
  return (
    <div className="space-y-3">
      {accounts.map((account) => (
        <AccountGroup key={account.accountId} account={account} />
      ))}
    </div>
  );
}

function AccountGroup({ account }: { account: DraftAccountGroup }) {
  // Expanded by default when something is selected, so the consequences of a
  // previous click are never hidden.
  const [open, setOpen] = useState(account.selectedCount > 0);
  const [pending, startTransition] = useTransition();
  const checkboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = account.checkboxState === "indeterminate";
    }
  }, [account.checkboxState]);

  const selectable = account.opportunities.filter((row) => row.selectable);

  function toggleAccount(checked: boolean) {
    startTransition(async () => {
      await setSelectionAction(
        selectable.map((row) => row.id),
        checked,
      );
    });
  }

  return (
    <Card className={account.selectedCount > 0 ? "border-brand/40" : undefined}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={account.checkboxState === "checked"}
          disabled={pending || selectable.length === 0}
          onChange={(event) => toggleAccount(event.target.checked)}
          aria-label={`Select the ${selectable.length} sendable ${pluralize(selectable.length, "opportunity", "opportunities")} shown for ${account.accountName}`}
          className="size-4 shrink-0 accent-[var(--color-brand)] disabled:opacity-40"
        />

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
        >
          <span className="text-[15px] font-semibold text-ink">{account.accountName}</span>
          <AccountTypeBadge label={accountTypeLabel(account.accountType)} />
          <span className="text-[12px] text-muted" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>

        <div className="flex items-center gap-3 text-[13px]">
          {account.selectedCount > 0 ? (
            <span className="rounded-full bg-brand-soft px-2.5 py-1 text-[12px] font-semibold text-brand">
              {account.selectedCount} selected
            </span>
          ) : null}
          <span className="text-muted">
            {selectable.length} sendable
            {account.needsAttentionCount > 0 ? ` · ${account.needsAttentionCount} needs attention` : ""}
          </span>
        </div>
      </div>

      {open ? (
        <ul className="divide-y divide-line border-t border-line">
          {account.opportunities.map((row) => (
            <OpportunityRow key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function OpportunityRow({ row }: { row: DraftOpportunityRow }) {
  const [pending, startTransition] = useTransition();

  function toggle(checked: boolean) {
    startTransition(async () => {
      await setSelectionAction([row.id], checked);
    });
  }

  return (
    <li
      className={`flex flex-wrap items-start gap-3 px-4 py-3 ${
        row.selected ? "bg-brand-soft/40" : row.selectable ? "" : "bg-canvas"
      }`}
    >
      {row.selectable ? (
        <input
          type="checkbox"
          checked={row.selected}
          disabled={pending}
          onChange={(event) => toggle(event.target.checked)}
          aria-label={`Select ${row.opportunityName}`}
          className="mt-1 size-4 shrink-0 accent-[var(--color-brand)]"
        />
      ) : (
        // No checkbox at all — a needs-attention opportunity has no recipient,
        // so it must be impossible to select rather than merely discouraged.
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center" aria-hidden>
          <span className="size-2 rounded-full bg-danger/40" />
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-ink">{row.opportunityName}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
          <span className="rounded-full border border-line bg-surface px-2 py-0.5 font-medium">
            {stageLabel(row.currentStage)}
          </span>
          <span className="tabular-nums">{formatAmount(row.amount)}</span>
          {row.closeDate ? <span>closes {formatDate(row.closeDate)}</span> : null}
          <span>IDS: {row.ownerName}</span>
          <a
            href={row.salesforceUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand hover:underline"
          >
            SFX ↗
          </a>
        </div>

        {row.selectable ? (
          <div className="mt-1.5 text-[13px]">
            <span className="text-muted">Primary contact: </span>
            <span className="font-medium text-ink">{row.contactName}</span>
            <span className="text-muted"> — {row.contactEmail}</span>
          </div>
        ) : (
          <div className="mt-1.5 text-[13px] font-medium text-danger">
            Needs attention — {row.resolutionReason === "PRIMARY_CONTACT_NO_EMAIL"
              ? "primary contact has no email address"
              : "no primary contact role set on the opportunity"}
          </div>
        )}
      </div>
    </li>
  );
}
