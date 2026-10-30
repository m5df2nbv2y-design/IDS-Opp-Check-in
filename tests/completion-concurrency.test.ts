import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS } from "@/server/services/audit-service";
import {
  completeCheckIn,
  resolveCheckInToken,
  saveResponse,
} from "@/server/services/response-service";
import { launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

/**
 * Completion under genuine concurrency.
 *
 * The SEC-001 analysis flagged this and was explicit about what would and
 * would not count as proof: "Verification needs a genuine concurrency test,
 * not two sequential calls." Sequential retries have always been safe — the
 * second call reads `completedAt` and reports `alreadyCompleted`. The question
 * is what happens when two calls genuinely overlap, which is reachable from a
 * double-tapped submit, a retrying proxy, or any client that is not ours.
 *
 * What must hold, and what goes wrong if it does not:
 *
 *   1. EXACTLY ONE caller completes. The others must report alreadyCompleted
 *      rather than completing a second time.
 *   2. EXACTLY ONE audit event. An audit trail that can double-record a
 *      completion is a defect in a system whose audit record is one of its
 *      stated guarantees — and it is the symptom that survives even when the
 *      duplicate work is otherwise harmless.
 *   3. EXACTLY ONE sync pass per item. Today write-back is disabled, so a
 *      duplicate sync performs no external Salesforce write. Once it is
 *      enabled, a duplicate sync is a duplicate CRM write.
 *
 * These tests exercise the real service against a real database. A mocked
 * transaction would prove nothing here, because the property under test is
 * precisely whether the database serialises the claim.
 */

async function answerEverything(campaignId: string, token: string) {
  const resolved = await resolveCheckInToken(token);
  if (!resolved.ok) throw new Error(`token did not resolve: ${resolved.reason}`);

  for (const item of resolved.session.items) {
    await saveResponse({
      token,
      itemId: item.id,
      stage: "PROPOSAL",
      comment: null,
      closeDate: null,
      lossReason: null,
    });
  }
  return resolved.session;
}

/** The busiest contact in the mock org, so the sync has several items to do. */
const CONTACT = "Jane Doe";

describe("concurrent completion", () => {
  let campaignId: string;
  let token: string;
  let recipientId: string;
  let itemCount: number;

  beforeEach(async () => {
    await resetDatabase();
    const launched = await launchCampaignAndCollectTokens("Concurrency Campaign");
    campaignId = launched.campaignId;
    token = launched.tokens.get(CONTACT)!;
    const session = await answerEverything(campaignId, token);
    recipientId = session.recipientId;
    itemCount = session.items.length;
    expect(itemCount).toBeGreaterThan(1);
  });

  it("lets exactly ONE of ten overlapping calls complete the check-in", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => completeCheckIn(token)),
    );

    // Every call must succeed from the caller's point of view: a recipient who
    // double-taps is not shown an error for doing so.
    for (const [index, result] of results.entries()) {
      expect(result.ok, `call ${index + 1}`).toBe(true);
    }

    const completers = results.filter((r) => r.ok && r.alreadyCompleted === false);
    const observers = results.filter((r) => r.ok && r.alreadyCompleted === true);

    expect(completers).toHaveLength(1);
    expect(observers).toHaveLength(9);
  });

  it("writes exactly ONE completion audit event, not one per caller", async () => {
    await Promise.all(Array.from({ length: 10 }, () => completeCheckIn(token)));

    const events = await prisma.auditEvent.count({
      where: { type: AUDIT_EVENTS.CHECKIN_COMPLETED, campaignId },
    });
    expect(events).toBe(1);
  });

  it("stamps completedAt once and does not move it afterwards", async () => {
    const first = await completeCheckIn(token);
    expect(first).toMatchObject({ ok: true, alreadyCompleted: false });

    const stampedAt = (
      await prisma.checkInRecipient.findUniqueOrThrow({
        where: { id: recipientId },
        select: { completedAt: true },
      })
    ).completedAt;
    expect(stampedAt).not.toBeNull();

    // A later burst must not re-stamp the completion time. If it did, the
    // audit trail would disagree with the record about when this happened.
    await Promise.all(Array.from({ length: 5 }, () => completeCheckIn(token)));

    const after = await prisma.checkInRecipient.findUniqueOrThrow({
      where: { id: recipientId },
      select: { completedAt: true },
    });
    expect(after.completedAt?.getTime()).toBe(stampedAt?.getTime());
  });

  it("syncs each item once, so an enabled write-back could not double-write", async () => {
    await Promise.all(Array.from({ length: 10 }, () => completeCheckIn(token)));

    const items = await prisma.checkInOpportunity.findMany({
      where: { recipientId },
      select: { id: true, syncStatus: true, syncAttempts: true },
    });
    expect(items).toHaveLength(itemCount);

    // The claim is atomic, so no item may be left mid-flight or attempted
    // more than once by this burst.
    for (const item of items) {
      expect(item.syncStatus, item.id).not.toBe("SYNCING");
      expect(item.syncAttempts, item.id).toBeLessThanOrEqual(1);
    }
  });

  it("does not complete a check-in that is not finished, however many calls arrive", async () => {
    await resetDatabase();
    const launched = await launchCampaignAndCollectTokens("Partial Campaign");
    const partialToken = launched.tokens.get(CONTACT)!;
    const resolved = await resolveCheckInToken(partialToken);
    if (!resolved.ok) throw new Error("token did not resolve");

    // Answer all but the last item.
    for (const item of resolved.session.items.slice(0, -1)) {
      await saveResponse({
        token: partialToken,
        itemId: item.id,
        stage: "PROPOSAL",
        comment: null,
        closeDate: null,
        lossReason: null,
      });
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, () => completeCheckIn(partialToken)),
    );

    // Concurrency must not be a way past the completeness check.
    for (const result of results) {
      expect(result).toEqual({ ok: false, reason: "INCOMPLETE" });
    }

    const recipient = await prisma.checkInRecipient.findUniqueOrThrow({
      where: { id: resolved.session.recipientId },
      select: { completedAt: true },
    });
    expect(recipient.completedAt).toBeNull();

    const events = await prisma.auditEvent.count({
      where: { type: AUDIT_EVENTS.CHECKIN_COMPLETED, campaignId: launched.campaignId },
    });
    expect(events).toBe(0);
  });
});

describe("the claim is the database's, not the client's", () => {
  /**
   * The browser serialises saves and disables the button during a wait, so our
   * own client does not generate overlapping completions. That is a UI
   * convention, not a server guarantee, and this asserts the guarantee holds
   * without it — the service is called directly here, exactly as a retrying
   * proxy or a third-party client would reach the route.
   */
  it("holds when calls arrive with no client-side coordination at all", async () => {
    await resetDatabase();
    const launched = await launchCampaignAndCollectTokens("Uncoordinated Campaign");
    const token = launched.tokens.get(CONTACT)!;
    await answerEverything(launched.campaignId, token);

    // Fired in the same tick, no awaits between them.
    const burst = [
      completeCheckIn(token),
      completeCheckIn(token),
      completeCheckIn(token),
      completeCheckIn(token),
      completeCheckIn(token),
      completeCheckIn(token),
    ];
    const results = await Promise.all(burst);

    expect(results.filter((r) => r.ok && r.alreadyCompleted === false)).toHaveLength(1);
    expect(
      await prisma.auditEvent.count({
        where: { type: AUDIT_EVENTS.CHECKIN_COMPLETED, campaignId: launched.campaignId },
      }),
    ).toBe(1);
  });
});
