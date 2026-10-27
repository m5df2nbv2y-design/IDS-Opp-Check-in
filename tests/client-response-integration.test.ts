import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { completeCheckIn, resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { SubmissionController } from "@/lib/checkin-submission";
import type { RequestOutcome } from "@/lib/throttle";
import { WIN_PROBABILITIES, lossReasonOptionsFromDescribe } from "@/lib/client-response";
import { MockSalesforceService } from "@/server/integrations/salesforce/mock/mock-salesforce-service";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { itemsForContact, launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/**
 * The seam between two independently built pieces.
 *
 * Client Response V2 decides WHAT is asked and persisted. The submission
 * controller decides HOW an answer reaches the server. Each was tested alone;
 * neither branch could test them together, because neither contained the other.
 *
 * These cover the combination: V2's save-before-advance contract driven through
 * the controller, and V2's server rules reached by the controller's transport.
 */

/** Scripted transport, mirroring the controller's own test harness. */
class FakeTransport {
  clock = 1_000_000;
  answerScript = new Map<number, (RequestOutcome | "ok" | "throttle" | "fail")[]>();
  completionScript: (RequestOutcome | "ok" | "throttle" | "fail")[] = ["ok"];
  log: string[] = [];
  now() { return this.clock; }
  advance(seconds: number) { this.clock += seconds * 1000; }
  private resolve(v: RequestOutcome | "ok" | "throttle" | "fail"): RequestOutcome {
    if (v === "ok") return { kind: "ok" };
    if (v === "fail") return { kind: "failed", status: null };
    if (v === "throttle") return { kind: "throttled", retryAfterSeconds: 10 };
    return v;
  }
  async sendAnswer(position: number): Promise<RequestOutcome> {
    this.log.push(`save:${position}`);
    const queue = this.answerScript.get(position) ?? ["ok"];
    return this.resolve(queue.length > 1 ? queue.shift()! : queue[0]);
  }
  async sendCompletion(): Promise<RequestOutcome> {
    this.log.push("complete");
    return this.resolve(this.completionScript.length > 1 ? this.completionScript.shift()! : this.completionScript[0]);
  }
  countOf(entry: string) { return this.log.filter((e) => e === entry).length; }
}

/** The save-before-advance rule, exactly as the component applies it. */
async function advance(
  controller: SubmissionController,
  position: number,
  key: string,
): Promise<"advanced" | "held"> {
  await controller.queueSave(position, key);
  return controller.outcomeOf(position)?.kind === "ok" ? "advanced" : "held";
}

describe("save-before-advance, driven through the controller", () => {
  it("HOLDS the recipient on a throttled project rather than moving on", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(2, transport);
    transport.answerScript.set(0, ["throttle", "ok"]);

    // V2's stricter contract: an answer the server did not accept must not be
    // left behind. This is what removes the earlier multi-item recovery problem.
    expect(await advance(controller, 0, "open|2027-01-15|75%")).toBe("held");
    expect(controller.isWaiting()).toBe(true);

    transport.advance(10);
    expect(await advance(controller, 0, "open|2027-01-15|75%")).toBe("advanced");
    expect(transport.countOf("save:0")).toBe(2);
    // Project 2 was never touched while project 1 was unresolved.
    expect(transport.countOf("save:1")).toBe(0);
  });

  it("submits the answer as EDITED during the wait, not the throttled one", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.answerScript.set(0, ["throttle", "ok"]);

    expect(await advance(controller, 0, "open|2027-01-15|50%")).toBe("held");
    transport.advance(10);
    // The recipient corrects the probability while held.
    expect(await advance(controller, 0, "open|2027-01-15|90%")).toBe("advanced");
    expect(transport.countOf("save:0")).toBe(2);
  });

  it("does not resave the final answer when only COMPLETION was throttled", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(2, transport);
    transport.completionScript = ["throttle", "ok"];

    expect(await advance(controller, 0, "a")).toBe("advanced");
    expect(await advance(controller, 1, "b")).toBe("advanced");

    const held = await controller.submit();
    expect(held.kind).toBe("waiting");
    if (held.kind === "waiting") expect(held.pendingAnswers).toBe(false);

    transport.advance(10);
    // The retry tap: the component re-queues the current answer first.
    await controller.queueSave(1, "b");
    expect(await controller.submit()).toEqual({ kind: "done" });

    expect(transport.log).toEqual(["save:0", "save:1", "complete", "complete"]);
  });

  it("a network failure also holds, and is not reported as a rate limit", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);
    transport.answerScript.set(0, ["fail", "ok"]);

    expect(await advance(controller, 0, "a")).toBe("held");
    // No cooldown: there is no limit to respect, so the recipient may retry now.
    expect(controller.isWaiting()).toBe(false);
    expect(await advance(controller, 0, "a")).toBe("advanced");
  });

  it("a genuine edit after a successful save is still sent", async () => {
    const transport = new FakeTransport();
    const controller = new SubmissionController(1, transport);

    expect(await advance(controller, 0, "open|2027-01-15|50%")).toBe("advanced");
    expect(await advance(controller, 0, "open|2027-03-01|90%")).toBe("advanced");
    expect(transport.countOf("save:0")).toBe(2);
  });
});

describe("V2 server rules reached through the recipient contract", () => {
  let token: string;
  let itemIds: string[];

  beforeEach(async () => {
    await resetDatabase();
    const campaign = await launchCampaignAndCollectTokens("V2 Integration");
    token = campaign.tokens.get("Marcus Webb")!;
    itemIds = (await itemsForContact(campaign.campaignId, "Marcus Webb")).map((i) => i.id);
  });

  it("stores an Open answer with its date and probability-mapped stage", async () => {
    const stage = WIN_PROBABILITIES.find((p) => p.label === "75%")!.stage;
    expect(stage).toBe("SPECIFIED");

    const saved = await saveResponse({
      token, itemId: itemIds[0], stage, flowVersion: 2, closeDate: "2027-04-09",
    });
    expect(saved.ok).toBe(true);

    const stored = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemIds[0] } });
    expect(stored.updatedStatus).toBe("SPECIFIED");
    expect(stored.updatedCloseDate?.toISOString().slice(0, 10)).toBe("2027-04-09");
    expect(stored.lossReason).toBeNull();
  });

  it("REFUSES an Open answer with no usable date, storing nothing", async () => {
    for (const closeDate of [null, "2027-02-30", "not-a-date"]) {
      const result = await saveResponse({
        token, itemId: itemIds[0], stage: "PROPOSAL", flowVersion: 2, closeDate,
      });
      expect(result, `closeDate ${String(closeDate)}`).toEqual({ ok: false, reason: "INVALID_CLOSE_DATE" });
    }
    const stored = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemIds[0] } });
    expect(stored.submittedAt).toBeNull();
  });

  it("REFUSES an invented loss reason", async () => {
    const result = await saveResponse({
      token, itemId: itemIds[0], stage: "CLOSED_LOST", flowVersion: 2, lossReason: "made-up",
    });
    expect(result).toEqual({ ok: false, reason: "INVALID_LOSS_REASON" });
  });

  it("NEVER accepts Closed Won, whatever the flow version", async () => {
    for (const flowVersion of [undefined, 2]) {
      const result = await saveResponse({
        token, itemId: itemIds[0], stage: "CLOSED_WON", flowVersion, closeDate: "2027-04-09",
      });
      expect(result).toEqual({ ok: false, reason: "INVALID_STAGE" });
    }
  });

  it("clears the open close date when the answer switches to Closed Lost", async () => {
    await saveResponse({ token, itemId: itemIds[0], stage: "PROPOSAL", flowVersion: 2, closeDate: "2027-04-09" });
    const open = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemIds[0] } });
    expect(open.updatedCloseDate).not.toBeNull();

    // Must be an option the SERVER recognises — it validates against the
    // provider's metadata, not against anything the client supplies.
    const reasons = await new MockSalesforceService().getLossReasonOptions();
    expect(reasons.length).toBeGreaterThan(0);

    const saved = await saveResponse({
      token, itemId: itemIds[0], stage: "CLOSED_LOST", flowVersion: 2,
      lossReason: reasons[0].value, comment: reasons[0].label,
    });
    expect(saved.ok).toBe(true);
    const closed = await prisma.checkInOpportunity.findUniqueOrThrow({ where: { id: itemIds[0] } });
    expect(closed.updatedStatus).toBe("CLOSED_LOST");
    expect(closed.lossReason).toBe(reasons[0].value);
    // The obsolete open-branch value must not linger.
    expect(closed.updatedCloseDate).toBeNull();
  });

  it("keeps amount and the Salesforce stage INTERNAL, out of the client props", async () => {
    const resolved = await resolveCheckInToken(token);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // The internal session DOES retain them — administration and history need
    // them, and Update 19 asks that they be preserved internally.
    const session = Object.keys(resolved.session.items[0]);
    expect(session).toContain("amount");

    // The boundary that matters is the page's explicit allowlist: only these
    // keys become client props, so the browser never receives the rest.
    const page = readFileSync(
      fileURLToPath(new URL("../src/app/checkin/[token]/page.tsx", import.meta.url)),
      "utf8",
    );
    const mapping = page.slice(page.indexOf("session.items.map"), page.indexOf("return <CheckInFlow"));
    expect(mapping).toContain("projectName");
    expect(mapping).toContain("createdDate");
    expect(mapping, "amount must not be mapped into client props").not.toMatch(/\bamount\b/);
    expect(mapping, "the Salesforce stage must not be mapped into client props").not.toMatch(/currentStage/);
  });

  it("reports an unavailable creation date rather than the import timestamp", async () => {
    const item = (await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: itemIds[0] }, select: { opportunityId: true },
    }));
    await prisma.opportunity.update({ where: { id: item.opportunityId }, data: { salesforceCreatedAt: null } });

    const resolved = await resolveCheckInToken(token);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const target = resolved.session.items.find((i) => i.id === itemIds[0])!;
    // Null, so the screen can say "date unavailable". Substituting the local
    // import time would quietly invent a Salesforce fact.
    expect(target.createdDate).toBeNull();
  });

  it("refuses to complete while an answer is still outstanding", async () => {
    await saveResponse({ token, itemId: itemIds[0], stage: "PROPOSAL", flowVersion: 2, closeDate: "2027-04-09" });
    const result = await completeCheckIn(token);
    expect(result).toEqual({ ok: false, reason: "INCOMPLETE" });
  });

  it("refuses an item belonging to a DIFFERENT recipient", async () => {
    const campaign = await launchCampaignAndCollectTokens("V2 Cross Recipient");
    const otherToken = campaign.tokens.get("Jane Doe");
    const otherItems = await itemsForContact(campaign.campaignId, "Jane Doe");
    if (!otherToken || otherItems.length === 0) return;

    // A valid token must not reach another recipient's opportunity.
    const result = await saveResponse({
      token: otherToken, itemId: itemIds[0], stage: "PROPOSAL", flowVersion: 2, closeDate: "2027-04-09",
    });
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });

  it("refuses an invalid token outright", async () => {
    const result = await saveResponse({
      token: "not-a-real-token-but-long-enough-to-pass", itemId: itemIds[0],
      stage: "PROPOSAL", flowVersion: 2, closeDate: "2027-04-09",
    });
    expect(result).toEqual({ ok: false, reason: "NOT_FOUND" });
  });
});

describe("loss-reason metadata fails closed", () => {
  it("returns nothing when the picklist is ambiguous, dependent or record-typed", () => {
    const picklist = { active: true, value: "Budget", label: "Budget" };
    // Two fields share the label — which one did the user mean?
    expect(lossReasonOptionsFromDescribe({
      fields: [
        { label: "Loss Reason", type: "picklist", picklistValues: [picklist] },
        { label: "Loss Reason", type: "picklist", picklistValues: [picklist] },
      ],
    })).toEqual([]);
    // Dependent picklists need a controlling value we do not have.
    expect(lossReasonOptionsFromDescribe({
      fields: [{ label: "Loss Reason", type: "picklist", dependentPicklist: true, picklistValues: [picklist] }],
    })).toEqual([]);
    // A non-master record type means Object Describe is not authoritative.
    expect(lossReasonOptionsFromDescribe({
      fields: [{ label: "Loss Reason", type: "picklist", picklistValues: [picklist] }],
      recordTypeInfos: [{ available: true, master: false }],
    })).toEqual([]);
    // And an empty result must leave the recipient unable to submit a guess.
    expect(lossReasonOptionsFromDescribe({ fields: [] })).toEqual([]);
  });
});
