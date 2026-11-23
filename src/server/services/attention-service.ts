import { prisma } from "@/lib/db";
import { INTERRUPTED_INVITATION_AGE_MS } from "./reconcile-service";

export type CampaignProblems = { campaignId: string; campaignName: string; salesforce: number; invitations: number };

const SYNC_PROBLEMS = ["FAILED", "UNCERTAIN"];
const SEND_PROBLEMS = ["FAILED", "UNCERTAIN", "REMINDER_UNCERTAIN", "REMINDER_PENDING"];

/**
 * Per campaign, what an admin must act on: Salesforce updates that failed or
 * may have been written, and invitations or reminders that failed or have an
 * unknown outcome. A revoked link settles its invitation, so it stops counting;
 * a failed Salesforce write still needs fixing, so it counts either way.
 * A row stuck mid-write for longer than any request runs (SYNCING, PENDING)
 * counts too, as does REMINDER_PENDING, which carries no timestamp to age it by.
 */
export async function listProblemsNeedingAttention(now = new Date()): Promise<CampaignProblems[]> {
  const stuckBefore = new Date(now.getTime() - INTERRUPTED_INVITATION_AGE_MS);
  const [syncs, sends] = await Promise.all([
    prisma.checkInOpportunity.findMany({
      where: { OR: [{ syncStatus: { in: SYNC_PROBLEMS } }, { syncStatus: "SYNCING", updatedAt: { lt: stuckBefore } }] },
      select: { recipient: { select: { campaignId: true } } },
    }),
    prisma.checkInRecipient.findMany({
      where: { revokedAt: null, OR: [{ sendStatus: { in: SEND_PROBLEMS } }, { sendStatus: "PENDING", createdAt: { lt: stuckBefore } }] },
      select: { campaignId: true },
    }),
  ]);

  const counts = new Map<string, { salesforce: number; invitations: number }>();
  const bump = (campaignId: string, key: "salesforce" | "invitations") => {
    const entry = counts.get(campaignId) ?? { salesforce: 0, invitations: 0 };
    entry[key] += 1;
    counts.set(campaignId, entry);
  };
  for (const s of syncs) bump(s.recipient.campaignId, "salesforce");
  for (const r of sends) bump(r.campaignId, "invitations");
  if (counts.size === 0) return [];

  const campaigns = await prisma.campaign.findMany({ where: { id: { in: [...counts.keys()] } }, select: { id: true, name: true }, orderBy: { createdAt: "desc" } });
  return campaigns.map((c) => ({ campaignId: c.id, campaignName: c.name, ...counts.get(c.id)! }));
}
