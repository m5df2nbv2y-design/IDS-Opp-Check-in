import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Each test RUN gets its own PostgreSQL schema.
 *
 * global-setup drops and recreates the schema before the suite runs, so a
 * single shared name means two concurrent runs — a watch process and a one-off,
 * or a CI job overlapping a local run — reset each other's tables mid-flight and
 * fail in scattered, baffling ways. Keying the schema to the process removes the
 * whole failure class rather than documenting it.
 *
 * A schema rather than a database: creating and dropping one is cheap, and it
 * keeps every run inside the single `ids_checkin_test` database so nothing can
 * reach development or production data.
 *
 * The URL is published on process.env here, at config load, so global-setup
 * (which runs later in this same process) is guaranteed to agree with the value
 * handed to the workers.
 */
const BASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://ids:ids_local_dev@localhost:5432/ids_checkin_test";

const schema = `test_${process.pid}`;
const testDatabaseUrl = `${BASE_URL}?schema=${schema}`;

process.env.VITEST_DB_URL = testDatabaseUrl;
process.env.VITEST_DB_SCHEMA = schema;

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    // Files within a run share the one schema, so they run in sequence and a
    // fixture reset cannot race another file's.
    fileParallelism: false,
    env: {
      DATABASE_URL: testDatabaseUrl,
      APP_BASE_URL: "https://checkin.test",
      SALESFORCE_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      CHECKIN_TOKEN_TTL_DAYS: "45",
    },
  },
});
