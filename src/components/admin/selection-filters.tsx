"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

type Owner = { id: string; name: string; count: number };

const STATUS_OPTIONS = [
  { value: "all", label: "All opportunities" },
  { value: "eligible", label: "Ready to select" },
  { value: "selected", label: "Selected only" },
  { value: "needs_attention", label: "Needs attention" },
];

const fieldClass = "h-10 rounded-xl border border-line bg-surface px-3 text-[14px] text-ink focus:border-brand focus:outline-none";

/**
 * Turns the submitted form into the dashboard's URL query. Blank and "all"
 * values are left out; the checkbox is on by default, so only unticking it is
 * written (munknown=0).
 */
export function filterQuery(form: FormData): string {
  const next = new URLSearchParams();
  for (const key of ["q", "owner", "status", "mfrom", "mto", "sort"]) {
    const value = String(form.get(key) ?? "").trim();
    if (value && value !== "all") next.set(key, value);
  }
  if (!form.get("munknown")) next.set("munknown", "0");
  return next.toString();
}

/**
 * Filters live in the URL, so a filtered view is shareable and survives a
 * refresh. Owner and status apply as soon as they are picked; the other
 * fields wait for Search (or Enter) (Josh, 2026-11-24). The fields are uncontrolled and the form is keyed on the URL,
 * so each applied search, and Clear filters, starts the fields from the URL.
 */
export function SelectionFilters({ owners }: { owners: Owner[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const go = (query: string) => startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname));
  // Submits the whole form, so anything already typed applies along with it.
  const applyNow = (event: React.ChangeEvent<HTMLSelectElement>) => event.currentTarget.form?.requestSubmit();
  const hasFilters = ["q", "status", "owner", "mfrom", "mto", "sort", "munknown"].some((key) => params.get(key));

  return (
    <form
      key={params.toString()}
      onSubmit={(event) => {
        event.preventDefault();
        go(filterQuery(new FormData(event.currentTarget)));
      }}
      className="ids-filters flex flex-wrap items-end gap-3"
    >
      <label className="min-w-0 basis-full flex-1 text-xs font-semibold text-muted sm:basis-auto">Search
      <input
        type="search"
        name="q"
        defaultValue={params.get("q") ?? ""}
        placeholder="Search account, opportunity, contact or email…"
        aria-label="Search accounts, opportunities and contacts"
        className={`${fieldClass} min-w-0 basis-full flex-1 px-3.5 placeholder:text-muted/70 sm:min-w-[19rem] sm:basis-auto`}
      /></label>

      <label className="text-xs font-semibold text-muted">Owner<select name="owner" defaultValue={params.get("owner") ?? "all"} onChange={applyNow} aria-label="Filter by opportunity owner" className={fieldClass}>
        <option value="all">All owners</option>
        {owners.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name} ({entry.count})
          </option>
        ))}
      </select></label>

      <label className="text-xs font-semibold text-muted">Status<select name="status" defaultValue={params.get("status") ?? "all"} onChange={applyNow} aria-label="Filter by resolution status" className={fieldClass}>
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
        name="mfrom"
        defaultValue={params.get("mfrom") ?? ""}
        aria-label="Only opportunities modified in Salesforce on or after this date"
        className={fieldClass}
      /></label>

      <label className="text-xs font-semibold text-muted">to<input
        type="date"
        name="mto"
        defaultValue={params.get("mto") ?? ""}
        aria-label="Only opportunities modified in Salesforce on or before this date"
        className={fieldClass}
      /></label>

      <label className="text-xs font-semibold text-muted">Sort<select name="sort" defaultValue={params.get("sort") ?? "all"} aria-label="Sort by Salesforce modification date" className={fieldClass}>
        <option value="all">Account order</option>
        <option value="modified_desc">Modified — newest first</option>
        <option value="modified_asc">Modified — oldest first</option>
      </select></label>

      <label className="flex h-10 items-center gap-2 text-xs font-semibold text-muted">
        <input
          type="checkbox"
          name="munknown"
          defaultChecked={params.get("munknown") !== "0"}
          aria-label="Include opportunities with no known Salesforce modification date"
          className="size-4 accent-[var(--color-brand)]"
        />
        Include unknown dates
      </label>

      <div className="ml-auto flex items-center gap-2">
        {hasFilters ? (
          <button
            type="button"
            onClick={() => go("")}
            className="h-10 rounded-xl px-3 text-[13px] font-medium text-muted transition-colors hover:text-ink"
          >
            Clear filters
          </button>
        ) : null}
        <Button type="submit" disabled={pending}>{pending ? "Searching…" : "Search"}</Button>
      </div>
    </form>
  );
}
