import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { hashToken, issueToken } from "@/lib/tokens";
import { sendReminders } from "@/server/services/campaign-service";
import { resolveCheckInToken, saveResponse } from "@/server/services/response-service";
import { itemsForContact, launchCampaignAndCollectTokens, resetDatabase } from "./fixtures";

describe("check-in tokens", () => {
  let campaignId: string;
  let tokens: Map<string, string>;

  beforeAll(async () => {
    await resetDatabase();
    const result = await launchCampaignAndCollectTokens();
    campaignId = result.campaignId;
    tokens = result.tokens;
  });

  it("issues cryptographically random, unique tokens", () => {
    const issued = Array.from({ length: 500 }, () => issueToken().token);

    expect(new Set(issued).size).toBe(500);
    for (const token of issued) {
      // 32 random bytes, base64url encoded.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("never stores the raw token", async () => {
    const recipients = await prisma.checkInRecipient.findMany();
    const rawTokens = [...tokens.values()];

    expect(recipients.length).toBeGreaterThan(0);
    for (const recipient of recipients) {
      for (const raw of rawTokens) {
        expect(recipient.tokenHash).not.toBe(raw);
        expect(recipient.tokenHash).not.toContain(raw);
      }
      expect(recipient.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(recipient.tokenHint).toHaveLength(6);
    }

    for (const raw of rawTokens) {
      const matches = recipients.filter((r) => r.tokenHash === hashToken(raw));
      expect(matches).toHaveLength(1);
    }
  });

  it("puts nothing but the token in the link", async () => {
    const emails = await prisma.emailMessage.findMany({ where: { campaignId } });
    const contacts = await prisma.externalContact.findMany();
    const accounts = await prisma.account.findMany();
    const opportunities = await prisma.opportunity.findMany();

    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) {
      const url = email.linkUrl!;
      const token = url.split("/checkin/")[1];

      expect(url).toBe(`https://checkin.test/checkin/${token}`);
      expect(url).not.toContain("@");

      for (const contact of contacts) {
        expect(url).not.toContain(contact.email);
        expect(url).not.toContain(contact.externalId);
      }
      for (const account of accounts) {
        expect(url).not.toContain(account.externalId);
        expect(url).not.toContain(encodeURIComponent(account.name));
      }
      for (const opportunity of opportunities) {
        expect(url).not.toContain(opportunity.externalId);
        expect(url).not.toContain(encodeURIComponent(opportunity.customerName));
      }
    }
  });

  it("fails closed on unknown, malformed, and empty tokens", async () => {
    for (const bad of ["", "short", "x".repeat(43), "../../admin", "null", "undefined"]) {
      const result = await resolveCheckInToken(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("NOT_FOUND");
    }
  });

  it("rejects expired and revoked check-ins", async () => {
    const token = tokens.get("Jane Doe")!;
    const recipient = await prisma.checkInRecipient.findUniqueOrThrow({
      where: { tokenHash: hashToken(token) },
    });

    await prisma.checkInRecipient.update({
      where: { id: recipient.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await resolveCheckInToken(token);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toBe("EXPIRED");

    await prisma.checkInRecipient.update({
      where: { id: recipient.id },
      data: { expiresAt: recipient.expiresAt, revokedAt: new Date() },
    });
    const revoked = await resolveCheckInToken(token);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.reason).toBe("REVOKED");

    await prisma.checkInRecipient.update({
      where: { id: recipient.id },
      data: { revokedAt: null },
    });
  });

  it("invalidates the previous link when a reminder is sent", async () => {
    const before = tokens.get("Ray Ortiz")!;
    expect((await resolveCheckInToken(before)).ok).toBe(true);

    await sendReminders(campaignId, "test");

    const reminder = await prisma.emailMessage.findFirstOrThrow({
      where: { campaignId, kind: "REMINDER", toName: "Ray Ortiz" },
      orderBy: { createdAt: "desc" },
    });
    const after = reminder.linkUrl!.split("/checkin/")[1];

    expect(after).not.toBe(before);

    const old = await resolveCheckInToken(before);
    expect(old.ok).toBe(false);
    if (!old.ok) expect(old.reason).toBe("NOT_FOUND");

    expect((await resolveCheckInToken(after)).ok).toBe(true);

    // A reminder run rotates every unfinished recipient's link.
    const reminders = await prisma.emailMessage.findMany({
      where: { campaignId, kind: "REMINDER" },
      orderBy: { createdAt: "asc" },
    });
    for (const message of reminders) {
      tokens.set(message.toName, message.linkUrl!.split("/checkin/")[1]);
    }
  });

  it("resolves a token to exactly one contact's own opportunities", async () => {
    const token = tokens.get("Jane Doe")!;
    const resolved = await resolveCheckInToken(token);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const janesItems = await itemsForContact(campaignId, "Jane Doe");
    expect(resolved.session.contactName).toBe("Jane Doe");
    expect(resolved.session.organizationName).toBe("ABC Distribution");
    expect(resolved.session.items).toHaveLength(6);
    expect(resolved.session.items.map((item) => item.id).sort()).toEqual(
      janesItems.map((item) => item.id).sort(),
    );
  });

  it("refuses to let one contact write to another contact's opportunity", async () => {
    const janesToken = tokens.get("Jane Doe")!;
    const marcusItem = (await itemsForContact(campaignId, "Marcus Webb"))[0];

    const result = await saveResponse({
      token: janesToken,
      itemId: marcusItem.id,
      stage: "NEGOTIATION",
      comment: "should never be written",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_FOUND");

    const untouched = await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: marcusItem.id },
    });
    expect(untouched.updatedStatus).toBeNull();
    expect(untouched.repComment).toBeNull();
    expect(untouched.submittedAt).toBeNull();
  });

  it("refuses cross-contact access even within the same organization", async () => {
    // Elena Ruiz and Tom Becker are both at Northstar Agency.
    const elenasToken = tokens.get("Elena Ruiz")!;
    const tomsItem = (await itemsForContact(campaignId, "Tom Becker"))[0];

    const result = await saveResponse({
      token: elenasToken,
      itemId: tomsItem.id,
      stage: "NEGOTIATION",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("NOT_FOUND");

    const untouched = await prisma.checkInOpportunity.findUniqueOrThrow({
      where: { id: tomsItem.id },
    });
    expect(untouched.submittedAt).toBeNull();
  });

  it("never exposes internal IDS rep names to the recipient session", async () => {
    const resolved = await resolveCheckInToken(tokens.get("Marcus Webb")!);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const reps = await prisma.salesRep.findMany();
    const payload = JSON.stringify(resolved.session);
    for (const rep of reps) {
      expect(payload).not.toContain(rep.name);
      expect(payload).not.toContain(rep.email);
    }
  });

  it("rejects stage values outside the controlled list", async () => {
    const token = tokens.get("Jane Doe")!;
    const item = (await itemsForContact(campaignId, "Jane Doe"))[0];

    const result = await saveResponse({ token, itemId: item.id, stage: "CLOSED_WON" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_STAGE");
  });
});
