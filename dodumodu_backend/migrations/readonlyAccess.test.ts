import { test } from "node:test";
import assert from "node:assert/strict";
import { readonlyRoleName, ensureReadonlyAccess, BUILD_READ_TABLES } from "./readonlyAccess";

test("role name comes from the explicit variable, then from the URL username", () => {
  assert.equal(readonlyRoleName({ READONLY_DB_ROLE: "ro" } as never), "ro");
  assert.equal(readonlyRoleName({ NEON_READONLY_URL: "postgresql://sf_ro:pw@h/db?sslmode=require" } as never), "sf_ro");
  assert.equal(readonlyRoleName({} as never), null);
});

test("grants only the build tables and never default privileges", async () => {
  const sql: string[] = [];
  const client = {
    escapeIdentifier: (v: string) => `"${v}"`, escapeLiteral: (v: string) => `'${v}'`,
    query: async (q: string) => { sql.push(q); return { rowCount: 1, rows: [] }; },
  };
  await ensureReadonlyAccess(client as never, { READONLY_DB_ROLE: "ro" } as never);
  const all = sql.join("\n");
  assert.match(all, /GRANT SELECT ON "products", "product_publishes" TO "ro"/);
  assert.doesNotMatch(all, /DEFAULT PRIVILEGES|ALL TABLES/);
  assert.equal(BUILD_READ_TABLES.length, 2);
});

test("creates the role only when missing and a password is provided", async () => {
  const sql: string[] = [];
  const mk = (exists: boolean) => ({
    escapeIdentifier: (v: string) => `"${v}"`, escapeLiteral: (v: string) => `'${v}'`,
    query: async (q: string) => { sql.push(q); return { rowCount: q.startsWith("SELECT 1") ? (exists ? 1 : 0) : 1, rows: [] }; },
  });
  await ensureReadonlyAccess(mk(false) as never, { READONLY_DB_ROLE: "ro" } as never);
  assert.ok(!sql.some((q) => q.startsWith("CREATE ROLE")), "no password -> no create");
  await ensureReadonlyAccess(mk(false) as never, { READONLY_DB_ROLE: "ro", READONLY_DB_PASSWORD: "x" } as never);
  assert.ok(sql.some((q) => q.startsWith("CREATE ROLE")));
});
