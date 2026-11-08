import { Pool } from "pg";
const pool = new Pool({
  host: "localhost",
  port: 55432,
  user: "postgres",
  database: "dodumodu",
});
try {
  const r = await pool.query("SELECT COUNT(*) FROM products");
  console.log("products count:", r.rows[0].count);
  const r2 = await pool.query("SELECT id FROM products LIMIT 5");
  console.log("product ids:", r2.rows.map(r => r.id));
  const r3 = await pool.query("SELECT COUNT(*) FROM orders");
  console.log("orders count:", r3.rows[0].count);
} catch (e) {
  console.error("Error:", e.message);
} finally {
  await pool.end();
}