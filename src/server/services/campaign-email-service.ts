import { prisma } from "@/lib/db";
import { requireEmailRevision, validateEmailCopy } from "@/lib/check-in-copy";

/** Atomic save and audit. A stale tab cannot overwrite another admin's copy. */
export async function saveCampaignEmail(campaignId: string, revision: number, input: unknown, actor: string) {
  const expectedRevision = requireEmailRevision(revision);
  const copy = validateEmailCopy(input);
  await prisma.$transaction(async (tx) => {
    const result = await tx.campaign.updateMany({
      where: { id: campaignId, status: "DRAFT", emailRevision: expectedRevision },
      data: {
        emailSubject: copy.mode === "custom" ? copy.subject : null,
        emailBody: copy.mode === "custom" ? copy.body : null,
        emailRevision: { increment: 1 },
      },
    });
    if (result.count !== 1) throw new Error("This shared draft changed. Reload before saving your email.");
    await tx.auditEvent.create({ data: {
      type: "CAMPAIGN_EMAIL_DRAFTED", actor, actorKind: "ADMIN", campaignId,
      summary: `Saved ${copy.mode} check-in email`,
      detail: `Email revision ${expectedRevision + 1}; draft only, nothing sent.`,
    } });
  });
  return { revision: expectedRevision + 1, copy };
}
