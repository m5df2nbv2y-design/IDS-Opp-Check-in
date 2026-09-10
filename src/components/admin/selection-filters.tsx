"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

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

  // Debounced, so typing doesn't fire a query per keystroke.
  useEffect(() => {
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
  const hasFilters = Boolean(params.get("q") || params.get("status") || params.get("owner"));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search account, opportunity, contact or email…"
        aria-label="Search accounts, opportunities and contacts"
        className="h-10 min-w-[19rem] flex-1 rounded-xl border border-line bg-surface px-3.5 text-[14px] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none"
      />

      <select
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
      </select>

      <select
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
      </select>

      {hasFilters ? (
        <button
          type="button"
          onClick={() => startTransition(() => router.replace(pathname))}
          className="h-10 rounded-xl px-3 text-[13px] font-medium text-muted transition-colors hover:text-ink"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
