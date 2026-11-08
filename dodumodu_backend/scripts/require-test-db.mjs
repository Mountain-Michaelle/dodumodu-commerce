// Preloaded by `npm run test:db` / `npm run test:mfa` (node --import). It makes the
// database-backed suites impossible to skip by accident and impossible to point at a
// real database:
//   * no DATABASE_URL            -> exit 1 (a silently skipped security suite is a hole)
//   * host is not local          -> exit 1 (these tests insert and delete rows)
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set for the database-backed test suites — do not silently skip these regression tests.");
  process.exit(1);
}
let host;
try { host = new URL(url).hostname; } catch {
  console.error("DATABASE_URL is not a valid URL.");
  process.exit(1);
}
// A remote database is accepted ONLY when its exact hostname is named in
// ALLOW_REMOTE_TEST_DB (a disposable Neon branch, say). Never a blanket flag.
if (!LOCAL.has(host) && process.env.ALLOW_REMOTE_TEST_DB !== host) {
  console.error(`Refusing to run database tests against non-local host "${host}". Use a throwaway localhost database, or for a disposable remote branch set ALLOW_REMOTE_TEST_DB=${host}.`);
  process.exit(1);
}
