import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";

/**
 * Prisma 7 connects through a driver adapter. The adapter is picked from the
 * DATABASE_URL scheme so that moving from local SQLite to Vercel Postgres is a
 * configuration change, not a code change.
 */
function createPrismaClient() {
  const url = env.databaseUrl;
  const isPostgres = url.startsWith("postgres://") || url.startsWith("postgresql://");

  const adapter = isPostgres
    ? new PrismaPg({ connectionString: url })
    : new PrismaBetterSqlite3({ url });

  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createPrismaClient> };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
