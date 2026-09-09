import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const testDatabaseUrl = `file:${fileURLToPath(new URL("./prisma/test.db", import.meta.url))}`;

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["./tests/global-setup.ts"],
    // The suite shares one SQLite file; running files in sequence keeps each
    // test's fixture reset from racing another file's.
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
