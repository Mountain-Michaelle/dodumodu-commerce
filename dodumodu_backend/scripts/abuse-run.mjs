/* No-mercy abuse driver. Node 22, fetch built in. Run: node scripts/abuse-run.mjs */
const BASE = process.env.BASE_URL || "http://localhost:8787";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`); }
};
const section = (n) => console.log(`\n=== ${n} ===`);

async function get(path, headers = {}) {
  const res = await fetch(`${BASE}${path}`, { headers });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}
const order = (over = {}) => ({
  productId: 1, quantity: 1,
  customerName: "Abuse Probe", phone: "08030000001",
  whatsapp: "08030000001", address: "1 Test Street Lagos Nigeria", state: "Lagos",
  deliveryDate: "today", paymentMethod: "cod", turnstileToken: "",
  idempotencyKey: crypto.randomUUID(), ...over,
});
const submit = (body, ip) => post("/create-order", body,
  ip ? { "cf-connecting-ip": ip } : {});

// --- 1. baseline: does one order even work ---
section("1. baseline order");
const base = await submit(order(), "203.0.113.99");
console.log("        baseline:", base.status, JSON.stringify(base.json)?.slice(0, 200));
check("baseline order creates", base.status === 200, `status=${base.status} ${JSON.stringify(base.json)}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
