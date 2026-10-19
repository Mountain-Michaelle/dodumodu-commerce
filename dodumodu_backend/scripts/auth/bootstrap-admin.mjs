// scripts/auth/bootstrap-admin.mjs — operator only (spec §5.10).
// Creates the FIRST admin and opens the 72h first-device window. Refuses if any
// admin already exists. Never run against production by this feature.
//
// The repository-root .env (loaded at startup) owns DATABASE_URL, e.g.
//   DATABASE_URL=postgresql://postgres@localhost:5432/dodumodu
// For a live/Neon run the operator exports DATABASE_URL to the Neon URL and
// passes it to the environment instead. Real env vars always win over the file.
//
//   cd dodumodu_backend
//   DATABASE_URL=postgresql://postgres@localhost:5432/dodumodu npx tsx scripts/auth/bootstrap-admin.mjs michaelnabeau@gmail.com 72
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
// Resolve the repository-root .env. The script lives in dodumodu_backend/scripts/auth/,
// so the repo root is 3 levels up (scripts -> dodumodu_backend -> repo root).
const rootEnvPath = join(here, "..", "..", "..", ".env");
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("usage: node scripts/auth/bootstrap-admin.mjs <email> [window_hours]");
  process.exit(2);
}
const windowHours = Number(process.argv[3] ?? 72);

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error("DATABASE_URL is not set.");
  console.error("  Add it to the repository-root .env (see .env.example), or pass it in:");
  console.error("    DATABASE_URL=postgresql://user@localhost:5432/dodumodu npm run dev");
  process.exit(1);
}
const c = new Client({ connectionString: raw });
await c.connect();
try {
  // Refuse if any admin exists (bootstrap is one-shot).
  const existing = await c.query(
    "select count(*)::int AS n from aa_users where role = 'admin'",
  );
  if (existing.rows[0].n > 0) {
    console.error("refused: an admin already exists. Bootstrap is one-shot.");
    process.exit(1);
  }
  // Idempotent-ish: if this exact email exists as staff, promote it; else insert.
  const found = await c.query("select id from aa_users where email = $1", [email]);
  let id;
  if (found.rows[0]) {
    const up = await c.query(
      `update aa_users set role = 'admin',
         device_window_until = now() + make_interval(hours => $2::int)
       where id = $1 returning id::text AS id`,
      [found.rows[0].id, windowHours],
    );
    id = up.rows[0].id;
    console.log(`promoted existing user to admin: ${email}`);
  } else {
    const ins = await c.query(
      `insert into aa_users (email, role, device_window_until)
       values ($1, 'admin', now() + make_interval(hours => $2::int))
       returning id::text AS id`,
      [email, windowHours],
    );
    id = ins.rows[0].id;
    console.log(`created admin: ${email}`);
  }
  await c.query(
    `insert into aa_audit_events (actor_id, target_id, event, meta)
     values ($1, $1, 'admin_bootstrapped', $2::jsonb)`,
    [id, JSON.stringify({ window_hours: windowHours })],
  );
  console.log(`first-device window open for ${windowHours}h. The admin's first full`);
  console.log("login on any browser claims it and registers that device.");
} finally {
  await c.end();
}
