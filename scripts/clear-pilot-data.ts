import "dotenv/config";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import {
  clearPilotData,
  hostLabel,
  inventoryPilotData,
  parseCleanupArgs,
  PilotCleanupRefused,
  type PilotBlockers,
  type PilotCounts,
} from "@/server/ops/pilot-cleanup";

/**
 * Clears pilot campaigns, simulated sends and demo test emails before rollout.
 *
 *   npm run db:clear-pilot                                              # dry run: counts only
 *   npm run db:clear-pilot -- --apply --confirm <db host> --actor Josh  # deletes, one transaction
 *
 * Prints counts only — never names, emails, links, tokens or the connection
 * string. Runbook: docs/runbooks/pilot-data-cleanup.md.
 */

function print(title: string, values: PilotCounts | PilotBlockers) {
  console.log(title);
  for (const [key, value] of Object.entries(values)) console.log(`  ${key.padEnd(26)} ${value}`);
}

/** Error name and Prisma code only: a driver message can carry row values or connection details. */
function describe(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return `${error instanceof Error ? error.name : "Unknown error"}${typeof code === "string" ? ` (${code})` : ""}`;
}

async function main(): Promise<number> {
  console.log(`Target database endpoint: ${hostLabel(env.databaseUrl)}\n`);
  const args = parseCleanupArgs(process.argv.slice(2), env.databaseUrl);
  if (!args.ok) {
    console.error(args.message);
    return 2;
  }

  let before: Awaited<ReturnType<typeof inventoryPilotData>>;
  try {
    before = await inventoryPilotData();
  } catch (error) {
    console.error(`${args.apply ? "Read before apply failed" : "Dry run failed"}. Nothing was changed. ${describe(error)}`);
    return 1;
  }
  print("Pilot data:", before.counts);
  print("Blockers (must be 0 to apply):", before.blockers);

  if (!args.apply) {
    console.log("\nDry run. Nothing was changed.");
    return 0;
  }

  try {
    await clearPilotData({ actor: args.actor });
  } catch (error) {
    if (error instanceof PilotCleanupRefused) {
      console.error(`\nRefused: ${error.message}`);
      return 1;
    }
    if ((error as { code?: unknown } | null)?.code === "P2034") {
      console.error(
        "\nRolled back: something else wrote to the database during the run. Nothing was changed. Run it again when the app is quiet.",
      );
      return 1;
    }
    // A failed commit can still have committed; only a fresh read can tell.
    console.error("\nApply failed. Outcome unknown: run the dry run again before assuming anything changed.");
    console.error(describe(error));
    return 1;
  }

  let after: Awaited<ReturnType<typeof inventoryPilotData>>;
  try {
    after = await inventoryPilotData();
  } catch (error) {
    console.error(`\nApply committed; the check afterwards failed. Run the dry run to confirm the counts. ${describe(error)}`);
    return 1;
  }
  print("\nAfter apply (all should be 0):", after.counts);
  if (Object.values(after.counts).some((value) => value !== 0)) {
    console.error("\nThe apply committed, but new rows appeared afterwards. Check for admin activity and run the dry run again.");
    return 1;
  }
  console.log("\nApply committed. One PILOT_DATA_CLEARED event was recorded.");
  return 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(`Outcome unknown: run the dry run again before assuming anything changed. ${describe(error)}`);
    await prisma.$disconnect();
    process.exit(1);
  });
