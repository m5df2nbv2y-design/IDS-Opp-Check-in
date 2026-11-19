import { prisma } from "@/lib/db";

export type CampaignProblems = { campaignId: string; campaignName: string; salesforce: number; invitations: number };

const SYNC_PROBLEMS = ["FAILED", "UNCERTAIN"];
const SEND_PROBLEMS = ["FAILED", "UNCERTAIN", "REMINDER_UNCERTAIN"];

/**
 * Per campaign, what an admin must act on: Salesforce updates that failed or
 * may have been written, and invitations or reminders that failed or have an
 * unknown outcome. A revoked link settles its invitation, so it stops counting;
 * a failed Salesforce write still needs fixing, so it counts either way.
 */
export async function listProblemsNeedingAttention(): Promise<CampaignProblems[]> {
  const [syncs, sends] = await Promise.all([
    prisma.checkInOpportunity.findMany({
      where: { syncStatus: { in: SYNC_PROBLEMS } },
      select: { recipient: { select: { campaignId: true } } },
    }),
    prisma.checkInRecipient.findMany({
      where: { sendStatus: { in: SEND_PROBLEMS }, revokedAt: null },
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
