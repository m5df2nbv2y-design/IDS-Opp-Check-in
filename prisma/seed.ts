import "dotenv/config";
import { assertDemoEnvironment } from "@/lib/demo-guard";
import { prisma } from "@/lib/db";
import type { OpportunityStage } from "@/lib/stages";
import { MockSalesforceService } from "@/server/integrations/salesforce/mock/mock-salesforce-service";
import {
  getCampaignSummary,
  launchCampaign,
  previewCampaign,
  RECIPIENT_STATUS_LABELS,
} from "@/server/services/campaign-service";
import { refreshCatalogFromSalesforce } from "@/server/services/catalog-service";
import { completeCheckIn, saveResponse } from "@/server/services/response-service";
import { refreshSmartsheetSignals } from "@/server/services/smartsheet-signal-service";

/**
 * Builds a demo-ready dataset by driving the real workflow — mock Salesforce
 * org → catalog refresh → recipient resolution → campaign launch → emailed
 * links → contact submissions → sync. Nothing is written into workflow tables
 * by hand, so every seeded state is one the application can actually produce.
 *
 * The seed leaves ONE completed historical campaign (Spring 2026) and a
 * refreshed catalog, so the live demo is: open /admin → select → review.
 */

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  // FIRST — before any wipe, Salesforce call, or campaign launch. Fails closed
  // if either provider is missing or is anything other than "mock".
  assertDemoEnvironment("npm run db:seed");

  console.log("Resetting database…");
  await prisma.auditEvent.deleteMany();
  await prisma.emailMessage.deleteMany();
  await prisma.checkInOpportunity.deleteMany();
  await prisma.checkInRecipient.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.externalContact.deleteMany();
  await prisma.account.deleteMany();
  await prisma.salesRep.deleteMany();

  console.log("Loading the mock Salesforce org…");
  await new MockSalesforceService().resetOrg();

  console.log("Pulling opportunities and resolving recipients…");
  const catalog = await refreshCatalogFromSalesforce("seed");
  console.log(
    `  ${catalog.opportunities} opportunities · ${catalog.accounts} accounts · ${catalog.contacts} contacts`,
  );
  console.log(`  ${catalog.resolved} routed · ${catalog.unresolved} need attention`);

  // ---- Spring 2026: a finished campaign, for history ----------------------
  console.log("Simulating the Spring 2026 campaign (historical)…");
  // launchCampaign has no whole-catalog fallback. The seed genuinely wants
  // every resolved opportunity, so it asks for them explicitly — and is only
  // reachable at all behind assertDemoEnvironment() above.
  const everyResolved = await prisma.opportunity.findMany({
    where: { isOpen: true, resolutionStatus: "RESOLVED", contactId: { not: null } },
    select: { id: true },
  });
  const spring = await launchCampaign({
    opportunityIds: everyResolved.map((opportunity) => opportunity.id),
    name: "Spring 2026 Check-In",
    period: "Spring 2026",
    actor: "seed",
  });
  const tokens = await tokensFor(spring.campaignId);

  // Most contacts finished, largely confirming where things stood.
  const finished = [...tokens.keys()].filter(
    (name) => name !== "Tom Becker" && name !== "Morgan Lee",
  );

  for (const contactName of finished) {
    const token = tokens.get(contactName)!;
    await answerAll(spring.campaignId, contactName, token, SPRING_ANSWERS[contactName] ?? {});
    await completeCheckIn(token);
  }

  // Tom Becker never opened his — the "Sent, no response" state.
  // Morgan Lee opened hers and answered one of two — the "In Progress" state.
  const morganToken = tokens.get("Morgan Lee");
  if (morganToken) {
    const items = await itemsFor(spring.campaignId, "Morgan Lee");
    await prisma.checkInRecipient.updateMany({
      where: { campaignId: spring.campaignId, contact: { name: "Morgan Lee" } },
      data: { openedAt: new Date(Date.now() - 170 * DAY) },
    });
    await saveResponse({
      token: morganToken,
      itemId: items[0].id,
      stage: "NEGOTIATION",
      comment: "Customer moved the construction start to Q3.",
    });
  }

  await backdateCampaign(spring.campaignId, 178);

  // ---- Smartsheet signals --------------------------------------------------
  console.log("Pulling Smartsheet signals and matching them to opportunities…");
  const signals = await refreshSmartsheetSignals("seed");
  console.log(
    `  ${signals.fetched} signals · ${signals.matched} matched · ${signals.ambiguous} ambiguous · ${signals.unmatched} unmatched`,
  );

  // ---- Report -------------------------------------------------------------
  const summary = await getCampaignSummary(spring.campaignId);
  const preview = await previewCampaign();

  console.log("\nSeed complete.\n");
  console.log(`  ${summary!.name} (historical)`);
  for (const recipient of summary!.recipients) {
    console.log(
      `    ${recipient.contactName.padEnd(16)} ${recipient.accountName.padEnd(32)} ` +
        `${String(recipient.opportunityCount).padStart(2)} opps   ${RECIPIENT_STATUS_LABELS[recipient.status]}`,
    );
  }

  console.log("\n  Ready to launch:");
  console.log(`    ${preview.opportunityCount} open opportunities`);
  console.log(`    ${preview.recipientCount} external contacts`);
  console.log(`    ${preview.organizationCount} organizations`);
  console.log(`    ${preview.multiRepOrganizations} organizations spanning multiple IDS reps`);
  console.log(`    ${preview.unresolvedCount} opportunity needing a contact`);
  console.log("\n  Open /admin, select the opportunities to contact, then review.\n");
}

/**
 * Spring answers. Mostly confirmations so the Fall demo starts from the stages
 * the mock org was designed with, plus a few real movements for the audit trail.
 */
const SPRING_ANSWERS: Record<string, Record<string, { stage: OpportunityStage; comment?: string }>> =
  {
    "Jane Doe": {
      "MRI Suite Renovation": {
        stage: "PROPOSAL",
        comment: "Still tracking to the original schedule.",
      },
    },
    "Marcus Webb": {
      "Cardiac Cath Lab Modernization": {
        stage: "NEGOTIATION",
        comment: "Contract with their legal team.",
      },
    },
    "Dana Whitfield": {
      // Metro General's mammography record carries a validation rule in the
      // mock org, so this produces a reproducible Sync Error.
      "Mammography Suite Refresh": {
        stage: "NEGOTIATION",
        comment: "Moving to contract — please confirm the trade-in credit.",
      },
    },
  };

/**
 * Pull each contact's raw token back out of the emails that were "sent". This
 * is the only place tokens are recoverable, which is the point: they live in
 * the message, not in the database.
 */
async function tokensFor(campaignId: string): Promise<Map<string, string>> {
  const emails = await prisma.emailMessage.findMany({
    where: { campaignId, kind: "INVITE" },
    orderBy: { createdAt: "asc" },
  });

  const tokens = new Map<string, string>();
  for (const email of emails) {
    const token = email.linkUrl?.split("/checkin/")[1];
    if (token) tokens.set(email.toName, token);
  }
  return tokens;
}

async function itemsFor(campaignId: string, contactName: string) {
  return prisma.checkInOpportunity.findMany({
    where: { recipient: { campaignId, contact: { name: contactName } } },
    orderBy: { position: "asc" },
  });
}

async function answerAll(
  campaignId: string,
  contactName: string,
  token: string,
  overrides: Record<string, { stage: OpportunityStage; comment?: string }>,
) {
  for (const item of await itemsFor(campaignId, contactName)) {
    const override = overrides[item.projectName ?? item.opportunityName];
    await saveResponse({
      token,
      itemId: item.id,
      stage: override?.stage ?? (item.previousStatus as OpportunityStage),
      comment: override?.comment ?? null,
    });
  }
}

/** Shift a campaign's timestamps into the past so the demo looks lived-in. */
async function backdateCampaign(campaignId: string, daysAgo: number) {
  const shift = daysAgo * DAY;
  const shifted = (date: Date | null) => (date ? new Date(date.getTime() - shift) : null);

  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      createdAt: shifted(campaign.createdAt)!,
      startedAt: shifted(campaign.startedAt),
      completedAt: shifted(campaign.completedAt),
    },
  });

  for (const recipient of await prisma.checkInRecipient.findMany({ where: { campaignId } })) {
    await prisma.checkInRecipient.update({
      where: { id: recipient.id },
      data: {
        createdAt: shifted(recipient.createdAt)!,
        sentAt: shifted(recipient.sentAt),
        openedAt: shifted(recipient.openedAt),
        startedAt: shifted(recipient.startedAt),
        completedAt: shifted(recipient.completedAt),
      },
    });
  }

  for (const item of await prisma.checkInOpportunity.findMany({
    where: { recipient: { campaignId } },
  })) {
    await prisma.checkInOpportunity.update({
      where: { id: item.id },
      data: {
        createdAt: shifted(item.createdAt)!,
        submittedAt: shifted(item.submittedAt),
        syncedAt: shifted(item.syncedAt),
      },
    });
  }

  for (const event of await prisma.auditEvent.findMany({ where: { campaignId } })) {
    await prisma.auditEvent.update({
      where: { id: event.id },
      data: { createdAt: shifted(event.createdAt)! },
    });
  }

  for (const email of await prisma.emailMessage.findMany({ where: { campaignId } })) {
    await prisma.emailMessage.update({
      where: { id: email.id },
      data: { createdAt: shifted(email.createdAt)! },
    });
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
