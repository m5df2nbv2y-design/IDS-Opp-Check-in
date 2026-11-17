import { describe, expect, it } from "vitest";
import { sanitizeProviderError } from "@/server/services/audit-service";

describe("sanitizeProviderError", () => {
  it("returns null for non-strings", () => {
    for (const v of [undefined, null, 42, {}, new Error("x")]) expect(sanitizeProviderError(v)).toBeNull();
  });

  it("replaces URLs and /checkin/ paths", () => {
    expect(sanitizeProviderError("a https://x.invalid/checkin/TOK b /checkin/TOK2 c")).toBe(
      "a [link removed] b [link removed] c",
    );
  });

  it("caps the text at 300 characters", () => {
    expect(sanitizeProviderError("x".repeat(500))).toHaveLength(300);
  });
});
