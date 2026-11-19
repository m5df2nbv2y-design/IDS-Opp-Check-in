import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDay } from "@/lib/format";

describe("dates and times for IDS (Mountain Time)", () => {
  it("shows date-times in Mountain Time with the zone, across daylight saving", () => {
    expect(formatDateTime(new Date("2026-11-18T21:53:32Z"))).toBe("Nov 18, 2:53 PM MST");
    expect(formatDateTime(new Date("2026-07-01T18:00:00Z"))).toBe("Jul 1, 12:00 PM MDT");
  });

  it("keeps plain dates (close dates, due dates) on their own day", () => {
    expect(formatDate(new Date("2027-01-15T00:00:00Z"))).toBe("January 15, 2027");
  });

  it("gives the Mountain calendar day of a moment", () => {
    // 03:00 UTC on the 19th is still the evening of the 18th in Mountain Time.
    expect(formatDay(new Date("2026-11-19T03:00:00Z"))).toBe("November 18, 2026");
    expect(formatDay(null)).toBe("—");
  });
});
