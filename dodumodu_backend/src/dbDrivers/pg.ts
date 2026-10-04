// Local driver — Node against a real PostgreSQL server over TCP: a local
// Postgres, or Neon from your own machine (its connection string works with
// `pg` as-is, TLS included). Imported ONLY by src/node.ts, so this file and
// its `pg` dependency are absent from the Worker bundle.
//
// Nothing Neon-specific lives here: same schema, same queries, same
// migrations as the Worker (see migrations/migrate.ts, which uses `pg` too).
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import type { DbDriver } from "../db";

// Local development traffic is a handful of requests, and a runaway connection
// count shows up locally as a confusing "too many clients" rather than as a
// slow page — keep it small and obvious.
const MAX_POOL_CONNECTIONS = 5;

const pools = new Map<string, Pool>();

/**
 * One pool per connection string, reused for the process's lifetime. Routes
 * call createDb() on every request, so building a fresh Pool each time would
 * leak a connection per request until Postgres refuses new ones.
 */
function poolFor(databaseUrl: string): Pool {
  const existing = pools.get(databaseUrl);
  if (existing) return existing;
  const pool = new Pool({ connectionString: databaseUrl, max: MAX_POOL_CONNECTIONS });
  pools.set(databaseUrl, pool);
  return pool;
}

export const pgDriver: DbDriver = (databaseUrl) => drizzle(poolFor(databaseUrl), { schema });

/** Drains every pool — used on shutdown so the process exits without waiting. */
export async function closePools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end()));
}