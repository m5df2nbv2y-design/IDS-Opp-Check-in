import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** The admin recipient preview must match a real check-in: live loss reasons and the IDS shell. */

const state = vi.hoisted(() => ({
  session: null as unknown,
  lossReasons: [] as { value: string; label: string }[] | "throw",
  simulated: false,
}));
vi.mock("@/server/auth/config", () => ({ auth: async () => state.session, DEV_BYPASS_ENABLED: false }));
vi.mock("@/server/integrations/salesforce", () => ({
  getSalesforceService: () => ({
    info: { simulated: state.simulated },
    getLossReasonOptions: async () => {
      if (state.lossReasons === "throw") throw new Error("describe down");
      return state.lossReasons;
    },
  }),
}));
// Render the props the page hands the real flow, so the test sees exactly what recipients would get.
vi.mock("@/components/checkin/check-in-flow", () => ({
  CheckInFlow: (props: { lossReasons: unknown; preview?: boolean; token: string }) =>
    createElement("pre", null, JSON.stringify({ lossReasons: props.lossReasons, preview: props.preview, token: props.token })),
}));

import RecipientPreviewPage from "@/app/recipient-preview/page";

const ADMIN = { user: { id: "u1", name: "Josh Young", email: "josh@idsculpture.com", roles: ["SalesOps.Admin"], oid: "oid-1" } };
const LIVE = [
  { value: "Lost to Competitor", label: "Lost to Competitor" },
  { value: "Reduced Scope", label: "Reduced Scope" },
  { value: "Project Delayed Indefinitely", label: "Project Delayed Indefinitely" },
];

const render = async () => renderToStaticMarkup(await RecipientPreviewPage());

describe("recipient preview parity", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_REQUIRED_APP_ROLE", "SalesOps.Admin");
    state.session = ADMIN;
    state.lossReasons = LIVE;
    state.simulated = false;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes the live Salesforce loss reasons to the flow, not samples", async () => {
    const html = await render();
    for (const r of LIVE) expect(html).toContain(r.label);
    expect(html).not.toContain("Sample");
    expect(html).not.toContain("SAMPLE_");
    expect(html).toContain("&quot;preview&quot;:true");
    expect(html).toContain("preview-only");
  });

  it("renders inside the recipient shell: background image and IDS logo", async () => {
    const html = await render();
    expect(html).toContain("ids-recipient-background");
    expect(html).toContain("ids-client-background");
    expect(html).toContain("ids-orange-logo");
  });

  it("warns the admin when Salesforce returns no loss reasons", async () => {
    state.lossReasons = [];
    const html = await render();
    expect(html).toContain("No Loss Reason choices are available right now");
  });

  it("treats a failed lookup like an empty list and still renders", async () => {
    state.lossReasons = "throw";
    const html = await render();
    expect(html).toContain("No Loss Reason choices are available right now");
    expect(html).toContain("&quot;lossReasons&quot;:[]");
  });

  it("shows no warning when choices are present", async () => {
    expect(await render()).not.toContain("No Loss Reason choices are available right now");
  });

  it("labels demo choices when Salesforce is simulated", async () => {
    state.simulated = true;
    expect(await render()).toContain("these Loss Reason choices are demo values");
  });

  it("does not label live choices as demo values", async () => {
    expect(await render()).not.toContain("demo values");
  });

  it("still requires an admin", async () => {
    state.session = null;
    await expect(render()).rejects.toThrow();
  });
});
