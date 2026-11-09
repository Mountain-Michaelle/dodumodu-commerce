// Empties a TEST database so the suites that need a fresh one (KPI, visitor analytics, ...)
// can run, then re-applies every migration. DESTRUCTIVE: it drops the whole public schema.
//
// Guards (all must hold, or nothing is touched):
//   * DATABASE_URL is set and valid
//   * the host is local, OR is named EXACTLY in ALLOW_REMOTE_TEST_DB (disposable branch)
//   * the database name contains "test" (so a production database is never matched)
//   * --yes is passed
// Usage:  node scripts/reset-test-db.mjs --yes
import { spawnSync } from "node:child_process";
import pg from "pg";

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const fail = (m) => { console.error(m); process.exit(1); };

const raw = process.env.DATABASE_URL;
if (!raw) fail("DATABASE_URL must be set.");
let u;
try { u = new URL(raw); } catch { fail("DATABASE_URL is not a valid URL."); }
const dbName = decodeURIComponent(u.pathname.replace(/^\//, ""));
if (!LOCAL.has(u.hostname) && process.env.ALLOW_REMOTE_TEST_DB !== u.hostname) {
  fail(`Refusing: "${u.hostname}" is not local. Set ALLOW_REMOTE_TEST_DB=${u.hostname} for a disposable remote database.`);
}
if (!/test/i.test(dbName)) fail(`Refusing: database "${dbName}" does not contain "test" in its name.`);
if (!process.argv.includes("--yes")) fail(`This DROPS every table in "${dbName}" on ${u.hostname}. Re-run with --yes.`);

const client = new pg.Client({ connectionString: raw });
await client.connect();
try {
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  console.log(`Emptied "${dbName}" on ${u.hostname}.`);
} finally {
  await client.end();
}
const mig = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "db:migrate"], { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
process.exit(mig.status ?? 1);
