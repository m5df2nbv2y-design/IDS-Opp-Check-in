/**
 * Next.js startup hook — runs once per server instance, before the first
 * request is served.
 *
 * Production configuration is validated here rather than at module load so the
 * failure is a clear boot error naming every missing value, instead of a
 * confusing runtime symptom later (an empty database, or check-in links
 * pointing at localhost). Development is untouched.
 */
export async function register() {
  const { assertProductionConfig } = await import("@/lib/production-config");
  assertProductionConfig();
}
