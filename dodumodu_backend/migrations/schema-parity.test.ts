import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema";

/* The fake database behind most route tests has no schema, so a column that is in schema.ts but in NO migration
   (or a migration nobody ran) passes every one of them and then answers 500 in production. This is the one test
   that holds the two together: every column the code can SELECT must exist in a database built by the migrations.

   Runs when DATABASE_URL points at a migrated local database (npm run db:migrate first); the database suites
   (test:db) set it. Without one it is skipped, loudly, rather than passing vacuously. */
const url = process.env.DATABASE_URL;

test("every column in schema.ts exists in the migrated database", { skip: url ? false : "DATABASE_URL not set" }, async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()");
    const have = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!have.has(r.table_name)) have.set(r.table_name, new Set());
      have.get(r.table_name)!.add(r.column_name);
    }
    const missing: string[] = [];
    let tables = 0;
    for (const value of Object.values(schema)) {
      if (!(value instanceof PgTable)) continue;
      const cfg = getTableConfig(value);
      tables += 1;
      const cols = have.get(cfg.name);
      if (!cols) { missing.push(`table ${cfg.name}`); continue; }
      for (const c of cfg.columns) if (!cols.has(c.name)) missing.push(`${cfg.name}.${c.name}`);
    }
    assert.ok(tables > 5, "no tables were inspected - the schema import is wrong");
    assert.deepEqual(missing, [], `In schema.ts but not in the database (a migration is missing or not applied): ${missing.join(", ")}`);
  } finally {
    await client.end();
  }
});
