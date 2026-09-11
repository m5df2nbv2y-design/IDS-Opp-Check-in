import { execFileSync } from "node:child_process";

/**
 * Builds a throwaway PostgreSQL schema for the run.
 *
 * Applies the committed migrations with `migrate deploy` rather than pushing
 * the schema directly. Two reasons: it is non-destructive — it only ever creates
 * objects in a schema made empty moments earlier — and it means every test run
 * exercises the same migration path production will use, so a migration that
 * would fail on deploy fails here first.
 *
 * The schema is dropped on teardown, so a run leaves nothing behind and can
 * never touch development or production data.
 */
const databaseUrl = process.env.VITEST_DB_URL!;
const schema = process.env.VITEST_DB_SCHEMA!;

/** Base URL without the ?schema= parameter, for admin statements. */
const adminUrl = databaseUrl.split("?")[0];

function psql(statement: string) {
  execFileSync(
    "docker",
    ["exec", "ids-checkin-postgres", "psql", adminUrl, "-v", "ON_ERROR_STOP=1", "-c", statement],
    { stdio: "pipe" },
  );
}

export default function setup() {
  try {
    psql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    psql(`CREATE SCHEMA "${schema}"`);

    // DATABASE_URL is set explicitly for this call so the migration can only
    // ever reach the throwaway schema, never the development database.
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    throw new Error(
      [
        "",
        "Could not prepare the test database.",
        "",
        "  The suite needs the local PostgreSQL container:",
        "    npm run db:up",
        "",
        `  Target: ${adminUrl.replace(/:[^:@]+@/, ":****@")} schema "${schema}"`,
        "",
        detail,
      ].join("\n"),
    );
  }

  return () => {
    try {
      psql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      // A leftover schema is harmless; the next run with this pid drops it.
    }
  };
}
