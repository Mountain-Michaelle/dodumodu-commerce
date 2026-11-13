// Applies every migration in this folder, in order, to whichever PostgreSQL
// DATABASE_URL points at — a local server, or Neon from this machine (its
// connection string works unchanged; `pg` reads the sslmode from it).
//
//   npm run db:migrate
//
// One script, one set of .sql files, both environments. There is deliberately
// no environment-specific migration and no environment-specific schema: if a
// migration is only correct on one of them, it is the wrong migration.
//
// Uses `pg` (TCP) rather than the Neon HTTP driver because TCP is the one
// transport that works in both places. It is run by a developer machine or a
// CI job, never by the Worker.
import { Client } from "pg";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureReadonlyAccess } from "./readonlyAccess";

const dir = dirname(fileURLToPath(import.meta.url));
const rootEnvPath = resolve(dir, "..", "..", ".env");
// Optional, and never overrides a variable already in the environment.
if (existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Set DATABASE_URL before running this script — in the repository-root .env or in the environment.");
  process.exit(1);
}

// A database remembers which files it has already run, in a table of its own.
// Without it this script is a trap: the SQL here is not re-runnable (a plain
// CREATE TABLE fails on the second pass, taking the rest of the file with it),
// so the very first `npm run db:migrate` a second time explodes. Applied names
// are recorded, and applied files are skipped — which is also what makes the
// same command safe against Neon, where a deploy pipeline will run it again.
const client = new Client({ connectionString: databaseUrl });
await client.connect();

const TRACKING_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMP NOT NULL DEFAULT now()
  );`;

async function appliedNames(): Promise<Set<string>> {
  await client.query(TRACKING_DDL);
  const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
  return new Set(rows.map((r) => r.name));
}

const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const applied = await appliedNames();

// --baseline records the existing files as applied *without running them*, for
// exactly one situation: a database that was migrated before this table
// existed. It never guesses — if the schema is not actually there, the next
// `db:migrate` fails loudly on the missing table rather than silently skipping.
if (process.argv.includes("--baseline")) {
  for (const file of files) {
    if (applied.has(file)) continue;
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    console.log(`Recorded ${file} as already applied (no statements run).`);
  }
  await ensureReadonlyAccess(client);
  await client.end();
  console.log("Baseline recorded.");
  process.exit(0);
}

let ran = 0;
try {
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`Skipping ${file} (already applied).`);
      continue;
    }
    // Each file is one transaction, so a file that fails half way leaves the
    // schema exactly as it was and the name unrecorded, and re-running the
    // command retries that one file. The row is written inside the same
    // transaction as the DDL it describes: a migration can never claim to be
    // applied while its own schema changes are being rolled back.
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    console.log(`Applied ${file}`);
    ran += 1;
  }
  // After every run, applied or not: this is what repairs a fresh database or a new role.
  await ensureReadonlyAccess(client);
} finally {
  await client.end();
}

console.log(ran === 0 ? "Already up to date." : `Done — ${ran} migration(s) applied.`);
