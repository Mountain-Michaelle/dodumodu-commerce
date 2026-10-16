import { Client } from "pg";
const c = new Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query("SELECT id, email, role, device_window_until FROM aa_users WHERE email = $1", ["michaelnabeau@gmail.com"]);
console.log(JSON.stringify(r.rows, null, 2));
await c.end();
