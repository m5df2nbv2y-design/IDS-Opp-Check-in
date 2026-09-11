import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Each test RUN gets its own SQLite file.
 *
 * global-setup deletes the database before creating the schema, so a single
 * shared path means two concurrent runs — a watch process and a one-off, or a
 * CI job overlapping a local run — delete each other's database mid-flight and
 * fail in scattered, baffling ways. Keying the file to the process removes the
 * whole failure class rather than documenting it.
 *
 * The path is published on process.env here, at config load, so global-setup
 * (which runs later in this same process) is guaranteed to agree with the value
 * handed to the workers.
 */
const dbPath = fileURLToPath(new URL(`./prisma/test-${process.pid}.db`, import.meta.url));
process.env.VITEST_DB_PATH = dbPath;

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    // Files within a run share the one database, so they run in sequence and a
    // fixture reset cannot race another file's.
    fileParallelism: false,
    env: {
      DATABASE_URL: `file:${dbPath}`,
      APP_BASE_URL: "https://checkin.test",
      SALESFORCE_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      CHECKIN_TOKEN_TTL_DAYS: "45",
    },
  },
});
