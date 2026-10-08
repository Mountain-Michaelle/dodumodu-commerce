// One-off diagnostic: why does updatedAtVersionCondition miss on an identical timestamp?
// Run: node scripts/tz-probe.cjs
const { Client } = require("pg");

(async () => {
  const client = new Client({ connectionString: "postgresql://postgres@localhost:55432/dodumodu" });
  await client.connect();
  console.log("node TZ env:", process.env.TZ ?? "(unset)");
  const h = await client.query("SHOW timezone");
  console.log("db TimeZone:", h.rows[0].TimeZone);

  // A: what does a text->timestamp cast DO with an offset: drop it or convert it?
  const a = await client.query(String.raw`SELECT '2026-10-07T17:06:32.589-04:00'::timestamp::text AS drop_or_convert, '2026-10-07T21:06:32.589Z'::timestamp::text AS z_form`);
  console.log("A cast behavior:", JSON.stringify(a.rows[0]));

  // B: how does pg parse a naive timestamp column back into a JS Date?
  const b = await client.query("SELECT updated_at FROM orders WHERE id = 13639");
  console.log("B column read toISOString:", b.rows[0].updatedAt instanceof Date ? b.rows[0].updatedAt.toISOString() : b.rows[0].updatedAt);

  // C/D/E/F/G: the version predicate under every binding style.
  const dFrom = new Date("2026-10-07T21:06:32.589Z"), dTo = new Date("2026-10-07T21:06:32.590Z");
  const tNaiveFrom = "2026-10-07 21:06:32.589", tNaiveTo = "2026-10-07 21:06:32.590";
  const c = await client.query("SELECT updated_at >= $1 AND updated_at < $2 AS hit FROM orders WHERE id = 13639", [dFrom, dTo]);
  console.log("C Date params (app path):", c.rows[0].hit);
  const d = await client.query("SELECT updated_at >= $1::timestamp AND updated_at < $2::timestamp AS hit FROM orders WHERE id = 13639", [dFrom, dTo]);
  console.log("D forced ::timestamp:", d.rows[0].hit);
  const e = await client.query("SELECT updated_at >= $1::timestamptz AND updated_at < $2::timestamptz AS hit FROM orders WHERE id = 13639", [dFrom, dTo]);
  console.log("E forced ::timestamptz:", e.rows[0].hit);
  const f = await client.query("SELECT updated_at >= $1 AND updated_at < $2 AS hit FROM orders WHERE id = 13639", [tNaiveFrom, tNaiveTo]);
  console.log("F naive UTC string params:", f.rows[0].hit);
  const g = await client.query("SELECT $1::timestamp::text AS derived FROM orders WHERE id = 13639", [dFrom]);
  console.log("G Date param cast to naive:", g.rows[0].derived);

  // B1: round or truncate the microsecond fraction? Decides the bucket shape.
  const b1 = await client.query(String.raw`SELECT v::text AS stored, (SELECT t FROM (SELECT v::timestamp AS t) s) FROM (VALUES ('2026-10-07 21:06:32.589423'::timestamp), ('2026-10-07 21:06:32.589600'::timestamp), ('2026-10-07 21:06:32.589500'::timestamp), ('2026-10-07 21:06:32.589999'::timestamp), ('2026-10-07 21:06:32.590000'::timestamp)) v(v)`);
  for (const row of b1.rows) {
    const back = await client.query("SELECT $1::timestamp AS d", [row.stored]);
    console.log(`B1 parse ${row.stored} ->`, back.rows[0].d instanceof Date ? back.rows[0].d.toISOString() : back.rows[0].d);
  }

  // B2: full cycle as the fixed app would run it: Date write (node local form) ->
  // read back -> naive-UTC-string bucket -> guard hit?
  await client.query("DROP TABLE IF EXISTS tzc");
  await client.query("CREATE TEMP TABLE tzc (t timestamp)");
  await client.query("INSERT INTO tzc VALUES ($1)", [new Date()]);
  const storedTzc = await client.query("SELECT t::text AS s FROM tzc");
  const readTzc = await client.query("SELECT t FROM tzc");
  const asDate = readTzc.rows[0].t;
  const digits = asDate instanceof Date ? asDate.toISOString().replace("T", " ").replace("Z", "") : null;
  const plus1 = new Date(asDate.getTime() + 1).toISOString().replace("T", " ").replace("Z", "");
  const cyc = await client.query("SELECT t >= $1 AND t < $2 AS hit FROM tzc", [digits, plus1]);
  console.log("B2 cycle: stored =", storedTzc.rows[0].s, "| read =", asDate.toISOString(), "| digits =", digits, "| hit =", cyc.rows[0].hit);
  await client.query("DROP TABLE IF EXISTS tzc");
  await client.end();
})().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
