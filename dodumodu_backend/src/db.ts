// Layer rule: this file is the ONLY place that decides how a database
// connection is made. Which driver runs underneath is chosen by the
// composition root — src/index.ts (Worker + Neon) or src/node.ts (Node +
// PostgreSQL) — never by a route, service or repository, so the same schema,
// queries and repositories run in both environments unchanged.
//
// Neither driver is imported here, on purpose: a static import would pull one
// of them into whichever bundle this file ends up in. The concrete drivers
// live in src/dbDrivers/ and are imported only by their own entry point.
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

/**
 * The shared handle every repository takes. Both drivers are the same pg-core
 * query builder over the same schema; the only difference is the query-result
 * marker each one carries, which no repository ever names.
 */
export type Db = NeonHttpDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export type DbDriver = (databaseUrl: string) => Db;

let registeredDriver: DbDriver | null = null;

/** Called once by the entry point, before the first request. */
export function registerDbDriver(driver: DbDriver): void {
  registeredDriver = driver;
}

export function createDb(databaseUrl: string): Db {
  if (!registeredDriver) {
    throw new Error(
      "No database driver registered — reach the app through an entry point (src/index.ts for the Worker, src/node.ts for Node) so a driver is registered.",
    );
  }
  return registeredDriver(databaseUrl);
}
