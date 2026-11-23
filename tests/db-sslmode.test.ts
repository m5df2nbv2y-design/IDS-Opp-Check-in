import { describe, expect, it } from "vitest";
import { withVerifyFullSsl } from "@/lib/db";

/**
 * pg 8.23 warns on every connection that sslmode=require/prefer/verify-ca are
 * treated as verify-full. Neon's URL uses require; naming verify-full keeps
 * the same security and silences the warning (Josh, 2026-11-23).
 */
describe("withVerifyFullSsl", () => {
  const base = "postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/neondb";

  it.each(["require", "prefer", "verify-ca"])("rewrites sslmode=%s to verify-full, keeping other parameters", (mode) => {
    expect(withVerifyFullSsl(`${base}?sslmode=${mode}&channel_binding=require`))
      .toBe(`${base}?sslmode=verify-full&channel_binding=require`);
  });

  it.each([
    `${base}?sslmode=verify-full`,
    `${base}?sslmode=disable`,
    `${base}?uselibpqcompat=true&sslmode=require`,
    "postgresql://ids:ids@localhost:5432/ids_checkin?schema=test_1",
  ])("leaves %s unchanged", (url) => {
    expect(withVerifyFullSsl(url)).toBe(url);
  });
});
