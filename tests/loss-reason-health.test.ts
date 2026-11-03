import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Telling an administrator why Closed Lost is unavailable.
 *
 * Before this the failure was silent in both directions: the recipient saw
 * "currently unavailable" and the administrator saw nothing unless they read
 * the deployment logs. The person who could fix it had the least information.
 *
 * What these tests hold: every refusal produces an ACTIONABLE remedy, a
 * healthy read produces NO banner, and the diagnostic can never break the page
 * it is diagnosing.
 */

async function healthWith(describe_: unknown) {
  vi.resetModules();
  vi.doMock("@/server/integrations/salesforce", () => ({
    getSalesforceService: () => ({ describeLossReasons: describe_ }),
  }));
  const mod = await import("@/server/services/loss-reason-health");
  return mod.lossReasonHealth();
}

afterEach(() => {
  vi.doUnmock("@/server/integrations/salesforce");
  vi.resetModules();
});

describe("when the read is working", () => {
  it("reports healthy so nothing is shown", async () => {
    const health = await healthWith(async () => ({
      options: [
        { value: "Lost to Competitor", label: "Lost to Competitor" },
        { value: "Reduced Scope", label: "Reduced Scope" },
      ],
      refusal: null,
    }));
    expect(health).toEqual({ ok: true, count: 2 });
  });
});

describe("when the provider cannot refuse at all", () => {
  it("returns nothing for a provider without the diagnostic", async () => {
    // The mock org's choices are fixed, so there is nothing to diagnose and a
    // banner would be noise.
    expect(await healthWith(undefined)).toBeNull();
  });
});

describe("every refusal gets an actionable remedy", () => {
  const refusals = [
    "FIELD_NOT_FOUND",
    "AMBIGUOUS_FIELD_LABEL",
    "NOT_A_PICKLIST",
    "DEPENDENT_PICKLIST",
    "RECORD_TYPE_SCOPED",
    "NO_ACTIVE_VALUES",
  ] as const;

  for (const refusal of refusals) {
    it(`explains and gives a remedy for ${refusal}`, async () => {
      const health = await healthWith(async () => ({ options: [], refusal }));
      expect(health).toMatchObject({ ok: false, refusal });
      if (health && !health.ok) {
        expect(health.detail.length).toBeGreaterThan(20);
        // A remedy says what to CHANGE. An explanation alone leaves "so what
        // do I do?" unanswered, which is the state this replaced.
        expect(health.remedy.length).toBeGreaterThan(20);
      }
    });
  }

  it("names field-level security first for FIELD_NOT_FOUND — the likeliest cause", async () => {
    // Salesforce omits fields the integration user cannot read, so a
    // permissions gap is indistinguishable from a missing field. Sending an
    // admin to hunt for a deleted field would waste the most time.
    const health = await healthWith(async () => ({ options: [], refusal: "FIELD_NOT_FOUND" }));
    if (health && !health.ok) {
      expect(health.remedy).toMatch(/field-level security|cannot read/i);
      expect(health.remedy).toMatch(/Read access/i);
    }
  });

  it("sends the record-type and dependent cases to developers, not to settings", async () => {
    // These two need a different metadata call, not a configuration change.
    // Telling an admin to "fix" them would send them to change something that
    // is not wrong.
    for (const refusal of ["RECORD_TYPE_SCOPED", "DEPENDENT_PICKLIST"] as const) {
      const health = await healthWith(async () => ({ options: [], refusal }));
      if (health && !health.ok) {
        expect(health.remedy, refusal).toMatch(/development team/i);
      }
    }
  });
});

describe("the diagnostic cannot break the page it diagnoses", () => {
  it("returns nothing when the describe call throws", async () => {
    // A transport failure is transient and already logged by the provider.
    // Reporting it as a configuration problem would send an administrator to
    // change settings that are not wrong.
    expect(
      await healthWith(async () => {
        throw new Error("socket hang up");
      }),
    ).toBeNull();
  });
});
