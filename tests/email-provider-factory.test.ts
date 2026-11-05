import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which provider EMAIL_PROVIDER selects. `env` is read once at module load, so
 * each case stubs the variable and imports a fresh copy of the factory.
 * liveEmailRefusal trims and lowercases the same value, so the factory must too:
 * otherwise "Graph" is guarded as live but resolves to Mock.
 */
afterEach(() => vi.unstubAllEnvs());

async function selectedProvider(value: string) {
  vi.stubEnv("EMAIL_PROVIDER", value);
  vi.resetModules();
  const { getEmailService } = await import("@/server/integrations/email");
  return getEmailService().info.id;
}

describe("getEmailService", () => {
  it.each([
    ["graph", "graph"],
    ["resend", "resend"],
    ["mock", "mock"],
    [" Graph ", "graph"],
    ["GRAPH", "graph"],
    ["\tResend\n", "resend"],
    [" MOCK ", "mock"],
  ])("EMAIL_PROVIDER=%j resolves to the %s provider", async (value, expected) => {
    expect(await selectedProvider(value)).toBe(expected);
  });

  it("falls back to Mock when EMAIL_PROVIDER is unset or blank", async () => {
    expect(await selectedProvider("")).toBe("mock");
    expect(await selectedProvider("   ")).toBe("mock");
  });
});
