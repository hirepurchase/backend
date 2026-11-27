import { PrismaClient } from '@prisma/client';

/**
 * Time limits on the database connection, added to DATABASE_URL unless it
 * already sets them. Without them, connections the network has silently
 * dropped (between the app and the Supabase pooler) are never given up: every
 * request then waits for a connection that never frees, and the whole app,
 * sign-in included, fails until it is restarted.
 *
 *   connect_timeout  seconds to open a new connection
 *   pool_timeout     seconds a request waits for a free connection
 *   socket_timeout   seconds a single query may take before the connection is
 *                    dropped and replaced (generous: the longest reports run
 *                    well under this)
 */
const LIMITS: Record<string, string> = { connect_timeout: '15', pool_timeout: '20', socket_timeout: '90' };

export function withConnectionLimits(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    for (const [key, value] of Object.entries(LIMITS)) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return raw;
  }
}

const url = withConnectionLimits(process.env.DATABASE_URL);
const prisma = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();

export default prisma;
