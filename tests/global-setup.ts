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
  rmSync(dbPath, { force: true });

  execFileSync("npx", ["prisma", "db", "push"], {
    env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
    stdio: "ignore",
  });

  return () => rmSync(dbPath, { force: true });
}
