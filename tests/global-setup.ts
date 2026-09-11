import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Builds a throwaway SQLite database with the current schema.
 *
 * The path comes from vitest.config.ts, which keys it to this process — so two
 * concurrent runs never share a file, and this setup's delete-then-create can
 * never pull the database out from under another run.
 */
const dbPath =
  process.env.VITEST_DB_PATH ?? fileURLToPath(new URL("../prisma/test.db", import.meta.url));

export default function setup() {
  removeDatabase();

  execFileSync("npx", ["prisma", "db", "push"], {
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "ignore",
  });

  return removeDatabase;
}

/**
 * SQLite keeps its journal beside the database. Removing only the .db can leave
 * a -wal/-shm pair behind, which a later run would read as committed state, so
 * all three go together.
 */
function removeDatabase() {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}
