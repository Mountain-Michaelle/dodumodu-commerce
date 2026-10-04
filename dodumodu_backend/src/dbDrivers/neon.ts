// Production driver — Cloudflare Workers. Imported ONLY by src/index.ts, so
// neither this driver nor `pg` can leak into the local Node run, and the local
// run never touches Neon's HTTP endpoint.
//
// Neon's HTTP driver, not a TCP pool: a Worker invocation is short-lived and
// stateless, so a pooled `pg`-style connection would exhaust Postgres's
// connection limit under real traffic. `pg` is impossible here anyway — a
// Worker has no TCP sockets.
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "../schema";
import type { DbDriver } from "../db";

export const neonDriver: DbDriver = (databaseUrl) => {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
};