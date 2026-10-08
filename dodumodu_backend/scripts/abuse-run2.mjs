/* Stage 2: suspect flood. */
const BASE = process.env.BASE_URL || "http://localhost:8787";
let pass = 0, fail = 0;
const check = (l, ok, d = "") => { if (ok) { pass++; console.log(`  PASS  ${l}`); } else { fail++; console.log(`  FAIL  ${l}${d ? " -- " + d : ""}`); } };
const order = (over = {}) => ({ productId: 1, quantity: 1, customerName: "Abuse Probe", phone: "08030000001", whatsapp: "08030000001", address: "1 Test Street Lagos Nigeria", state: "Lagos", deliveryDate: "today", paymentMethod: "cod", turnstileToken: "", idempotencyKey: crypto.randomUUID(), ...over });
const submit = (body, ip) => fetch(`${BASE}/create-order`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

console.log("\n=== 2. suspect flood ===");
const PHONE = "08039990011";
for (let i = 0; i < 6; i++) {
  const r = await submit(order({ phone: PHONE, whatsapp: PHONE }), `203.0.113.${100 + i}`);
  check(`flood order ${i + 1} accepted`, r.status === 200, `status=${r.status} ${JSON.stringify(r.json)?.slice(0,120)}`);
}
const s = await fetch(`${BASE}/admin/spam/suspects?page=1&pageSize=50`).then((r) => r.json());
console.log("        total:", s.total, "rows:", s.suspects?.length);
check("suspects endpoint answers", typeof s.total === "number", JSON.stringify(s)?.slice(0,160));
check("flood phone surfaces", (s.suspects ?? []).some((x) => (x.orders ?? 0) >= 5), JSON.stringify(s.suspects)?.slice(0,400));
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
