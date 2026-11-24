import { describe, expect, it } from "vitest";
import { filterQuery } from "@/components/admin/selection-filters";

/** The Search button applies the whole filter form at once (Josh, 2026-11-24). */
function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("filterQuery", () => {
  it("writes every chosen filter and leaves out blanks and 'all'", () => {
    const query = new URLSearchParams(filterQuery(form({
      q: "  surgical ", owner: "rep1", status: "all", mfrom: "2026-01-15", mto: "", sort: "modified_desc", munknown: "on",
    })));
    expect(Object.fromEntries(query)).toEqual({ q: "surgical", owner: "rep1", mfrom: "2026-01-15", sort: "modified_desc" });
  });

  it("is empty for an untouched form", () => {
    expect(filterQuery(form({ q: "", owner: "all", status: "all", mfrom: "", mto: "", sort: "all", munknown: "on" }))).toBe("");
  });

  it("records an unticked 'Include unknown dates' as munknown=0", () => {
    expect(filterQuery(form({ q: "", owner: "all" }))).toBe("munknown=0");
  });
});
