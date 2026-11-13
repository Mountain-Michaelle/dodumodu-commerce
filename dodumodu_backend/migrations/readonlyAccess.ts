// Keeps the storefront build's read-only database role working, from code, on every database.
//
// The deploy workflow connects with NEON_READONLY_URL and reads exactly the tables in
// BUILD_READ_TABLES. A role is cluster-level and its password is a secret, so it cannot live in a
// .sql migration; this runs at the end of `npm run db:migrate` instead and is safe to repeat.
//
//   READONLY_DB_ROLE      role name; defaults to the username inside NEON_READONLY_URL
//   READONLY_DB_PASSWORD  only needed when the role does not exist yet - it is then created
//
// Only the tables the build needs are granted. Default privileges are deliberately NOT used:
// they would hand this role every future table, including ones holding sessions and secrets.
import type { Client } from "pg";

export const BUILD_READ_TABLES = ["products", "product_publishes"] as const;

export function readonlyRoleName(env: NodeJS.ProcessEnv): string | null {
  if (env.READONLY_DB_ROLE?.trim()) return env.READONLY_DB_ROLE.trim();
  const url = env.NEON_READONLY_URL?.trim();
  if (!url) return null;
  try { return decodeURIComponent(new URL(url).username) || null; } catch { return null; }
}

export async function ensureReadonlyAccess(client: Client, env: NodeJS.ProcessEnv = process.env) {
  const role = readonlyRoleName(env);
  if (!role) {
    console.log("Read-only build role: skipped (set READONLY_DB_ROLE or NEON_READONLY_URL to manage it).");
    return;
  }
  const id = (v: string) => client.escapeIdentifier(v);

  const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount! > 0;
  if (!exists) {
    const password = env.READONLY_DB_PASSWORD;
    if (!password) {
      console.warn(`Read-only build role "${role}" does not exist. Set READONLY_DB_PASSWORD and re-run db:migrate to create it.`);
      return;
    }
    await client.query(`CREATE ROLE ${id(role)} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
    console.log(`Created read-only role "${role}".`);
  }

  await client.query(`GRANT USAGE ON SCHEMA public TO ${id(role)}`);
  await client.query(`GRANT SELECT ON ${BUILD_READ_TABLES.map(id).join(", ")} TO ${id(role)}`);
  console.log(`Read-only role "${role}" can read: ${BUILD_READ_TABLES.join(", ")}.`);
}
