import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Prisma 7 connects through a driver adapter.
 *
 * PostgreSQL everywhere — local development, test, and production all run the
 * same engine, so there is no dialect gap for a bug to hide in. The Prisma
 * schema pins one provider and cannot switch on an environment variable, and a
 * SQLite/Postgres split would mean two migration histories drifting apart.
 *
 * A non-Postgres URL is refused rather than quietly adapted: the previous
 * SQLite fallback meant a missing DATABASE_URL produced a working app serving
 * an empty local file, which is the worst kind of failure.
 */
function createPrismaClient() {
  const url = env.databaseUrl;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. This deployment has no database configured. " +
        "Local development uses the Docker Postgres started by `npm run db:up`.",
    );
  }

  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      `DATABASE_URL must be a PostgreSQL connection string, got "${url.split(":")[0]}:…". ` +
        "Local development uses the Docker Postgres started by `npm run db:up`.",
    );
  }

  // The `?schema=` parameter is honoured by Prisma's CLI but NOT by the driver
  // adapter, which hands the URL straight to `pg` and lets it ignore unknown
  // parameters. Left alone, migrations land in the named schema while the
  // running app queries `public` and reports that every table is missing. So it
  // is parsed here and passed to the adapter explicitly.
  const schema = readSchemaParam(url);

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: withVerifyFullSsl(url) }, schema ? { schema } : undefined),
  });
}

/**
 * pg 8.23 already treats sslmode=require/prefer/verify-ca as verify-full and
 * warns on every connection. Naming verify-full keeps that security and stops
 * the warning. A URL that opts into libpq semantics is left as written.
 */
export function withVerifyFullSsl(url: string): string {
  if (/[?&]uselibpqcompat=true\b/.test(url)) return url;
  return url.replace(/([?&]sslmode=)(require|prefer|verify-ca)\b/, "$1verify-full");
}

function readSchemaParam(url: string): string | undefined {
  try {
    const value = new URL(url).searchParams.get("schema");
    return value && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createPrismaClient> };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

// Cached across HMR reloads in development only. In production each server
// instance loads the module once, which is the connection behaviour we want.
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
