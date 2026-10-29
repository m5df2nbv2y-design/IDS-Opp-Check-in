"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

type Owner = { id: string; name: string; count: number };

const STATUS_OPTIONS = [
  { value: "all", label: "All opportunities" },
  { value: "eligible", label: "Ready to select" },
  { value: "selected", label: "Selected only" },
  { value: "needs_attention", label: "Needs attention" },
];

/**
 * Filters live in the URL, so a filtered view is shareable and survives a
 * refresh — which matters when an admin is working through 140 accounts.
 */
export function SelectionFilters({ owners }: { owners: Owner[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const [search, setSearch] = useState(params.get("q") ?? "");
  const clearingFilters = useRef(false);

  // Debounced, so typing doesn't fire a query per keystroke.
  useEffect(() => {
    // A slower navigation must not let the debounce restore old owner/status
    // values while the reset is waiting for the unfiltered server response.
    if (clearingFilters.current) {
      if (!params.get("q") && !params.get("owner") && !params.get("status")) {
        clearingFilters.current = false;
      }
      return;
    }
    const current = params.get("q") ?? "";
    if (search === current) return;

    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (search) next.set("q", search);
      else next.delete("q");
      startTransition(() => router.replace(`${pathname}?${next.toString()}`));
    }, 300);

    return () => clearTimeout(timer);
  }, [search, params, pathname, router]);

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`${pathname}?${next.toString()}`));
  }

  const status = params.get("status") ?? "all";
  const owner = params.get("owner") ?? "all";
  const hasFilters = Boolean(
    params.get("q") || params.get("status") || params.get("owner") ||
    params.get("mfrom") || params.get("mto") || params.get("sort") || params.get("munknown"),
  );

  return (
    <div className="ids-filters flex flex-wrap items-center gap-3">
      <label className="min-w-0 basis-full flex-1 text-xs font-semibold text-muted sm:basis-auto">Search
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search account, opportunity, contact or email…"
        aria-label="Search accounts, opportunities and contacts"
        className="h-10 min-w-0 basis-full flex-1 rounded-xl border border-line bg-surface px-3.5 text-[14px] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none sm:min-w-[19rem] sm:basis-auto"
      /></label>

      <label className="text-xs font-semibold text-muted">Owner<select
        value={owner}
        onChange={(event) => update("owner", event.target.value)}
        aria-label="Filter by opportunity owner"
        className="h-10 rounded-xl border border-line bg-surface px-3 text-[14px] text-ink focus:border-brand focus:outline-none"
      >
        <option value="all">All owners</option>
        {owners.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name} ({entry.count})
          </option>
        ))}
      </select></label>

      <label className="text-xs font-semibold text-muted">Status<select
        value={status}
        onChange={(event) => update("status", event.target.value)}
        aria-label="Filter by resolution status"
        className="h-10 rounded-xl border border-line bg-surface px-3 text-[14px] text-ink focus:border-brand focus:outline-none"
      >
        {STATUS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select></label>

      {/*
        Salesforce modification window and ordering.

        These narrow and reorder the VIEW only. Selections live in
        CampaignSelection rows keyed by opportunity id, so nothing here adds or
        removes a selected opportunity — the selection bar keeps reporting the
        campaign-wide total, including rows this filter is hiding.
      */}
      <label className="text-xs font-semibold text-muted">SF modified from<input
        type="date"
        value={params.get("mfrom") ?? ""}
        onChange={(event) => update("mfrom", event.target.value || "all")}
        aria-label="Only opportunities modified in Salesforce on or after this date"
        className="h-10 rounded-xl border border-line bg-surface px-3 text-[14px] text-ink focus:border-brand focus:outline-none"
      /></label>

      <label className="text-xs font-semibold text-muted">to<input
        type="date"
        value={params.get("mto") ?? ""}
        onChange={(event) => update("mto", event.target.value || "all")}
        aria-label="Only opportunities modified in Salesforce on or before this date"
        className="h-10 rounded-xl border border-line bg-surface px-3 text-[14px] text-ink focus:border-brand focus:outline-none"
      /></label>

      <label className="text-xs font-semibold text-muted">Sort<select
        value={params.get("sort") ?? "all"}
        onChange={(event) => update("sort", event.target.value)}
        aria-label="Sort by Salesforce modification date"
        className="h-10 rounded-xl border border-line bg-surface px-3 text-[14px] text-ink focus:border-brand focus:outline-none"
      >
        <option value="all">Account order</option>
        <option value="modified_desc">Modified — newest first</option>
        <option value="modified_asc">Modified — oldest first</option>
      </select></label>

      <label className="flex items-center gap-2 text-xs font-semibold text-muted">
        <input
          type="checkbox"
          checked={params.get("munknown") !== "0"}
          onChange={(event) => update("munknown", event.target.checked ? "all" : "0")}
          aria-label="Include opportunities with no known Salesforce modification date"
          className="size-4 accent-[var(--color-brand)]"
        />
        Include unknown dates
      </label>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => {
            clearingFilters.current = true;
            setSearch("");
            startTransition(() => router.replace(pathname));
          }}
          className="h-10 rounded-xl px-3 text-[13px] font-medium text-muted transition-colors hover:text-ink"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
