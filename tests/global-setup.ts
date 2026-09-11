import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dbPath = fileURLToPath(new URL("../prisma/test.db", import.meta.url));

/**
 * Builds a throwaway SQLite database with the current schema.
 * The file is deleted first, so `db push` only ever creates — it never has to
 * reset anything, and the suite can't touch a real database.
 */
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
