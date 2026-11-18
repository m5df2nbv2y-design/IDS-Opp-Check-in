import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { AUDIT_EVENTS, recordAudit } from "@/server/services/audit-service";
import { SNAPSHOT_SOURCES } from "@/server/services/snapshot-service";

/**
 * One-off removal of pilot data before a real rollout. Every campaign counts as
 * pilot (drafts included); simulated (`mock`) outbox rows and demo test emails
 * (kind TEST) go with them. The Salesforce catalogue and its refresh/outcome
 * history stay. See docs/runbooks/pilot-data-cleanup.md.
 */

type Db = Prisma.TransactionClient;

/** What an apply would remove. Counts only: nothing here identifies a person. */
export type PilotCounts = {
  campaigns: number;
  recipients: number;
  checkInItems: number;
  /** Of checkInItems, those a contact answered. */
  submittedAnswers: number;
  selections: number;
  /** Simulated (`mock`) outbox rows, demo test emails (kind TEST, any provider), and FAILED (never delivered) sends on pilot campaigns. */
  pilotEmails: number;
  campaignAuditEvents: number;
  launchSnapshots: number;
};

/** Conditions that make an apply unsafe. Both must be 0. */
export type PilotBlockers = {
  /** Pilot items with a real Salesforce write attempt: SYNCED, SYNCING, UNCERTAIN or FAILED. */
  itemsWithSalesforceWrites: number;
  /** Real-provider INVITE/REMINDER rows, not FAILED, tied to a pilot campaign: someone may actually have been emailed. */
  realSendsInPilot: number;
};

/** SKIPPED sets syncedAt with no write; PENDING and WITHHELD never wrote. */
const WRITE_ATTEMPT_STATUSES = ["SYNCED", "SYNCING", "UNCERTAIN", "FAILED"];

type Inventory = {
  ids: { campaigns: string[]; emails: string[]; snapshots: string[] };
  counts: PilotCounts;
  blockers: PilotBlockers;
};

async function inventory(db: Db): Promise<Inventory> {
  // Sequential, not Promise.all: a transaction client runs one query at a time.
  const campaigns = (await db.campaign.findMany({ select: { id: true } })).map((row) => row.id);
  const emails = (
    await db.emailMessage.findMany({
      where: { OR: [{ provider: "mock" }, { kind: "TEST" }, { campaignId: { in: campaigns }, status: "FAILED" }] },
      select: { id: true },
    })
  ).map((row) => row.id);
  const snapshots = (
    await db.opportunitySnapshot.findMany({ where: { source: SNAPSHOT_SOURCES.CAMPAIGN_LAUNCH }, select: { id: true } })
  ).map((row) => row.id);

  const inPilot = { in: campaigns };
  const pilotItems = { recipient: { campaignId: inPilot } };
  return {
    ids: { campaigns, emails, snapshots },
    counts: {
      campaigns: campaigns.length,
      recipients: await db.checkInRecipient.count({ where: { campaignId: inPilot } }),
      checkInItems: await db.checkInOpportunity.count({ where: pilotItems }),
      submittedAnswers: await db.checkInOpportunity.count({ where: { ...pilotItems, submittedAt: { not: null } } }),
      selections: await db.campaignSelection.count({ where: { campaignId: inPilot } }),
      pilotEmails: emails.length,
      campaignAuditEvents: await db.auditEvent.count({ where: { campaignId: inPilot } }),
      launchSnapshots: snapshots.length,
    },
    blockers: {
      itemsWithSalesforceWrites: await db.checkInOpportunity.count({
        where: { ...pilotItems, syncStatus: { in: WRITE_ATTEMPT_STATUSES } },
      }),
      realSendsInPilot: await db.emailMessage.count({
        where: { campaignId: inPilot, provider: { not: "mock" }, kind: { in: ["INVITE", "REMINDER"] }, status: { not: "FAILED" } },
      }),
    },
  };
}

/** Read-only: what an apply would remove, and what would stop it. */
export async function inventoryPilotData(db: Db = prisma): Promise<{ counts: PilotCounts; blockers: PilotBlockers }> {
  const { counts, blockers } = await inventory(db);
  return { counts, blockers };
}

export class PilotCleanupRefused extends Error {
  constructor(readonly blockers: PilotBlockers) {
    super(
      [
        blockers.itemsWithSalesforceWrites > 0 &&
          `${blockers.itemsWithSalesforceWrites} pilot check-in item(s) had a real Salesforce write attempt`,
        blockers.realSendsInPilot > 0 &&
          `${blockers.realSendsInPilot} real-provider invitation/reminder email(s) not marked FAILED are tied to a pilot campaign`,
      ]
        .filter(Boolean)
        .join("; ") + ". Nothing was removed.",
    );
    this.name = "PilotCleanupRefused";
  }
}

/**
 * Removes the pilot data in one Serializable transaction and records one
 * PILOT_DATA_CLEARED event with the counts. Ids are taken once and every delete
 * is by those ids, so nothing written mid-run is removed unchecked; a concurrent
 * write fails the transaction instead. Throws PilotCleanupRefused (writing
 * nothing) when a blocker is present.
 */
export async function clearPilotData(input: { actor: string }): Promise<PilotCounts> {
  return prisma.$transaction(
    async (tx) => {
      const { ids, counts, blockers } = await inventory(tx);
      if (blockers.itemsWithSalesforceWrites > 0 || blockers.realSendsInPilot > 0) throw new PilotCleanupRefused(blockers);

      // Before the campaigns: the audit→campaign relation is SetNull and would orphan them.
      await tx.auditEvent.deleteMany({ where: { campaignId: { in: ids.campaigns } } });
      await tx.emailMessage.deleteMany({ where: { id: { in: ids.emails } } });
      await tx.opportunitySnapshot.deleteMany({ where: { id: { in: ids.snapshots } } });
      // Recipients, items and selections cascade from Campaign.
      await tx.campaign.deleteMany({ where: { id: { in: ids.campaigns } } });

      await recordAudit(
        {
          type: AUDIT_EVENTS.PILOT_DATA_CLEARED,
          summary: `${input.actor} cleared pilot data: ${counts.campaigns} campaign(s), ${counts.pilotEmails} simulated or test email(s)`,
          actor: input.actor,
          actorKind: "ADMIN",
          detail: JSON.stringify({ version: 1, ...counts }),
        },
        tx,
      );
      return counts;
    },
    // A one-off bulk delete; the 5s interactive default is too tight for a real pilot's volume.
    { isolationLevel: "Serializable", timeout: 120_000, maxWait: 10_000 },
  );
}

/** Host of a database URL, or null. */
export function databaseHost(databaseUrl: string): string | null {
  try {
    return new URL(databaseUrl).hostname || null;
  } catch {
    return null;
  }
}

/** First label of the host (a Neon `ep-…` endpoint id): tells branches apart, and is not a credential. */
export function hostLabel(databaseUrl: string): string {
  const host = databaseHost(databaseUrl);
  return host ? host.split(".")[0] : "(not a valid URL)";
}

export type CleanupArgs = { ok: true; apply: false } | { ok: true; apply: true; actor: string } | { ok: false; message: string };

/**
 * `--apply` needs `--confirm <host>` matching DATABASE_URL's host, and `--actor`.
 * A flag given twice is refused. Error messages never echo either host or any
 * part of the URL.
 */
export function parseCleanupArgs(argv: string[], databaseUrl: string): CleanupArgs {
  const seen = new Set<string>();
  let apply = false;
  let confirm: string | undefined;
  let actor: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--apply" && flag !== "--confirm" && flag !== "--actor") {
      return { ok: false, message: "Unknown argument. Use --apply --confirm <database host> --actor <name>." };
    }
    if (seen.has(flag)) return { ok: false, message: `${flag} was given more than once.` };
    seen.add(flag);
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return { ok: false, message: `${flag} needs a value.` };
    if (flag === "--confirm") confirm = value.trim();
    else actor = value.trim();
    index += 1;
  }

  if (!apply) {
    if (confirm !== undefined || actor !== undefined) return { ok: false, message: "--confirm and --actor are only used with --apply." };
    return { ok: true, apply: false };
  }
  if (!actor) return { ok: false, message: "--apply requires --actor <name>." };
  if (!confirm) return { ok: false, message: "--apply requires --confirm <database host>." };

  const host = databaseHost(databaseUrl);
  if (!host) return { ok: false, message: "DATABASE_URL is not a valid URL." };
  if (host.toLowerCase() !== confirm.toLowerCase()) {
    return { ok: false, message: "--confirm does not match the host in DATABASE_URL. Nothing was written." };
  }
  return { ok: true, apply: true, actor };
}
