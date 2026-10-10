import { Client } from "pg";
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const t = await c.query(
  "select tablename from pg_tables where schemaname='public' and tablename like 'aa_%' order by 1",
);
console.log("TABLES:", JSON.stringify(t.rows.map((r) => r.tablename)));
const f = await c.query(
  "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'aa_%' order by 1",
);
console.log("FUNCS:", JSON.stringify(f.rows.map((r) => r.proname)));
const cols = await c.query(
  "select column_name from information_schema.columns where table_name='aa_sessions' order by ordinal_position",
);
console.log("SESSION_COLS:", JSON.stringify(cols.rows.map((r) => r.column_name)));
await c.end();
