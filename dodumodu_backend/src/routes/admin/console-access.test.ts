// Role-based access for the whole admin console, and manual order entry, through the real composed app
// (sessions, device rules, origin guard, registry, row scope). Each test names the property it pins down.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { app as composed } from "../../app";
import { normalizePhone } from "../../shared/normalizePhone";
import { q, sql } from "../../auth/sql";
import { openTestDb, closePools, testSecrets, makeTag, newVid, cleanupTag, createEnrolledUser, newTotpFlow } from "../../auth/mfa-test-kit";

const NS = "/4ehhi-5deggi", HOST = "shop.example.com";
const db = openTestDb(); const s = testSecrets(); const tag = makeTag("acc");
const env = {
  DATABASE_URL: process.env.DATABASE_URL!, ENVIRONMENT: "production", ADMIN_BASE_PATH: NS, ADMIN_AUTH_V2: "1", ALLOW_TEST_IP: "1",
  MAX_ORDER_QUANTITY: "20",
  OTP_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=", THROTTLE_KEY: "CwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwcHCwc=",
  TOTP_ENC_KEY: "DwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwcHDwc=",
  RATE_LIMIT_ADMIN_PER_MINUTE: "100000", RATE_LIMIT_ADMIN_WRITES_PER_MINUTE: "100000",
  RATE_LIMIT_KV: { get: async () => null, put: async () => undefined },
} as never;
const NET = 1 + Math.floor(Math.random() * 200); let n = 0; const ip = () => `10.${NET}.88.${(n++ % 250) + 1}`;
const call = async (method: string, path: string, cookie?: string, body?: unknown) => {
  const origin = `https://${HOST}`, addr = ip();
  return composed.fetch(new Request(`${origin}${NS}${path}`, {
    method, redirect: "manual",
    headers: { host: HOST, origin, "cf-connecting-ip": addr, "x-test-ip": addr,
      ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  }), env);
};
type Who = { id: string; email: string; cookie: string };
async function signIn(label: string, role: "admin" | "mono" | "general", grants: string[] = []): Promise<Who> {
  const u = await createEnrolledUser(db, s, `${tag}-${label}@example.com`, { role: "admin" });
  await q(db, sql`UPDATE aa_users SET role = ${role}, is_superuser = ${role === "admin"}, is_staff = true, device_window_until = now() + interval '1 hour' WHERE id = ${u.id}::uuid`);
  for (const g of grants) await q(db, sql`INSERT INTO aa_user_permissions (user_id, perm) VALUES (${u.id}::uuid, ${g})`);
  const vid = newVid(); const f = await newTotpFlow(db, s, u, { vid, stage: "ready" });
  const res = await call("POST", "/auth/session", `__Host-aaf=${f.token}; __Host-vid=${vid}`);
  assert.equal(res.status, 200, await res.text());
  const sc = res.headers.get("set-cookie") ?? ""; const did = /__Host-did=([^;]+)/.exec(sc)?.[1];
  return { id: u.id, email: u.email, cookie: `__Host-sid=${/__Host-sid=([^;]+)/.exec(sc)![1]}${did ? `; __Host-did=${did}` : ""}; __Host-vid=${vid}` };
}
let productId = 0;
let admin: Who, mono: Who, monoNoAdd: Who, general: Who, bare: Who;
before(async () => {
  productId = (await q<{ id: number }>(db, sql`INSERT INTO products (slug, name, description, price, package_options)
    VALUES (${`${tag}-serum`}, 'Access fixture', 'x', 1500000, '[{"id":"duo","label":"Duo","price":2800000}]') RETURNING id`))[0].id;
  admin = await signIn("admin", "admin");
  mono = await signIn("mono", "mono", ["orders.view", "orders.add", "orders.change", "orders.status.delivered", "reports.view"]);
  monoNoAdd = await signIn("mononoadd", "mono", ["orders.view"]);
  general = await signIn("general", "general", ["orders.view", "reports.view", "categories.view"]);
  bare = await signIn("bare", "general", []);
});
after(async () => {
  await q(db, sql`DELETE FROM notifications WHERE dedupe_key IN (SELECT 'order-created:' || id FROM orders WHERE product_id = ${productId})`).catch(() => undefined);
  await q(db, sql`DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE product_id = ${productId})`);
  await q(db, sql`DELETE FROM orders WHERE product_id = ${productId}`);
  await q(db, sql`DELETE FROM products WHERE id = ${productId}`);
  await cleanupTag(db, tag); await closePools();
});

let ph = 1000000 + Math.floor(Math.random() * 5000000);
const nextPhone = () => `0803${ph++}`;   // the assignment rules keep one customer with one staff member, so each order is a new customer
const order = (over: Record<string, unknown> = {}) => { const phone = nextPhone(); return ({
  productId, packageId: "duo", quantity: 1, customerName: "Ada Obi", phone, whatsapp: phone,
  address: "12 Allen Avenue, Ikeja", state: "Lagos", deliveryDate: "tomorrow", paymentMethod: "cod", ...over,
}); };
const json = async (r: Response) => (await r.json()) as any;

/* ----------------------------- manual orders ----------------------------- */

test("manual order: an admin creates one; it records who created it and the SERVER prices it", async () => {
  const r = await call("POST", "/admin-v2/orders", admin.cookie, order({ amount: 1, unitPrice: 1, subtotal: 1 }));
  assert.equal(r.status, 201, JSON.stringify(await r.clone().json()));
  const { order: o } = await json(r);
  assert.equal(o.createdBy, admin.email);
  assert.equal(o.unitPrice, 2800000, "the client's price is ignored");
  assert.equal(o.amount, 2800000);
  assert.equal(o.status, "confirmed_cod");
  const row = (await q<{ created_by: string }>(db, sql`SELECT created_by FROM orders WHERE id = ${o.id}`))[0];
  assert.equal(row.created_by, admin.email, "persisted in orders.created_by");
  const hist = await q<{ changed_by: string }>(db, sql`SELECT changed_by FROM order_status_history WHERE order_id = ${o.id}`);
  assert.equal(hist[0].changed_by, `admin:${admin.email}`, "the audit trail names the operator");
});

test("manual order: package prices apply, and an unknown package or product is a field error, not a 500", async () => {
  const ok = await call("POST", "/admin-v2/orders", admin.cookie, order({ quantity: 2 }));
  assert.equal(ok.status, 201); { const o = (await json(ok)).order; assert.equal(o.unitPrice, 2800000); assert.ok(o.amount > 0 && o.amount <= 5600000, "server-priced (quantity discounts may apply)"); }
  const noPack = await call("POST", "/admin-v2/orders", admin.cookie, order({ packageId: undefined }));
  assert.equal(noPack.status, 400); assert.ok((await json(noPack)).fields.packageId, "a product with packages needs one chosen");
  const badPack = await call("POST", "/admin-v2/orders", admin.cookie, order({ packageId: "nope" }));
  assert.equal(badPack.status, 400); assert.ok((await json(badPack)).fields.packageId);
  const badProd = await call("POST", "/admin-v2/orders", admin.cookie, order({ productId: 999999999 }));
  assert.equal(badProd.status, 400); assert.ok((await json(badProd)).fields.productId);
});

test("manual order: every required field is validated, with the field named", async () => {
  const r = await call("POST", "/admin-v2/orders", admin.cookie, { productId });
  assert.equal(r.status, 400);
  const fields = (await json(r)).fields;
  for (const f of ["quantity", "customerName", "phone", "whatsapp", "address", "state", "deliveryDate", "paymentMethod"]) assert.ok(fields[f], `${f} is required`);
  const state = await call("POST", "/admin-v2/orders", admin.cookie, order({ state: "Atlantis" }));
  assert.equal(state.status, 400); assert.ok((await json(state)).fields.state, "a state that is not on the list is refused");
  const qty = await call("POST", "/admin-v2/orders", admin.cookie, order({ quantity: 0 }));
  assert.equal(qty.status, 400);
});

test("manual order: the form's idempotency key stops a double-click creating two orders", async () => {
  const key = crypto.randomUUID();
  const a = await json(await call("POST", "/admin-v2/orders", admin.cookie, order({ idempotencyKey: key })));
  const b = await json(await call("POST", "/admin-v2/orders", admin.cookie, order({ idempotencyKey: key })));
  assert.equal(a.order.id, b.order.id);
});

test("manual order: only users granted orders.add may create (403 otherwise), and form-options needs the same key", async () => {
  for (const who of [monoNoAdd, general, bare]) {
    assert.equal((await call("POST", "/admin-v2/orders", who.cookie, order())).status, 403, who.email);
    assert.equal((await call("GET", "/admin-v2/orders/form-options", who.cookie)).status, 403, who.email);
  }
  const anon = await call("POST", "/admin-v2/orders", undefined, order());
  assert.equal(anon.status, 401);
  const fo = await call("GET", "/admin-v2/orders/form-options", mono.cookie);
  assert.equal(fo.status, 200);
  const j = await json(fo);
  assert.ok(j.products.some((p: any) => p.id === productId && p.packageOptions.length === 1));
  assert.ok(j.states.includes("Lagos") && j.deliveryDates.length === 3 && j.paymentMethods.length === 2);
});

test("manual order: a mono operator who creates one owns it, so it is in THEIR list (and created_by is them)", async () => {
  const r = await call("POST", "/admin-v2/orders", mono.cookie, order({ customerName: "Mono Made" }));
  assert.equal(r.status, 201);
  const j = await json(r);
  assert.equal(j.order.createdBy, mono.email);
  assert.equal(j.order.assignedTo, mono.email);
  assert.equal(j.visibleToCreator, true);
  const list = await json(await call("GET", "/orders?pageSize=100", mono.cookie));
  assert.ok(list.orders.some((o: any) => o.id === j.order.id), "visible in the creator's own list");
});

/* ------------------------- role-based access (legacy admin API) ------------------------- */

test("a non-admin session is let into the console API, but only to what their grants open (default deny)", async () => {
  // orders.view only: orders yes, everything else no
  assert.equal((await call("GET", "/orders", monoNoAdd.cookie)).status, 200);
  for (const p of ["/categories/tree", "/products", "/media", "/testimonials", "/discount-tiers", "/payment-rules", "/blocks", "/spam/shadow", "/reports/monthly-kpis"])
    assert.equal((await call("GET", p, monoNoAdd.cookie)).status, 403, p);
  // a user with no grants at all can open nothing
  for (const p of ["/orders", "/categories/tree", "/products", "/me".replace("/me", "/reports/monthly-kpis")])
    assert.equal((await call("GET", p, bare.cookie)).status, 403, p);
  assert.equal((await call("GET", "/me", bare.cookie)).status, 200, "identity is always available to a signed-in operator");
});

test("granting a section opens exactly that section; revoking closes it on the very next request", async () => {
  assert.equal((await call("GET", "/categories/tree", general.cookie)).status, 200, "categories.view granted");
  assert.equal((await call("POST", "/categories", general.cookie, { name: "x" })).status, 403, "view is not add");
  assert.equal((await call("GET", "/products", general.cookie)).status, 403, "products not granted");
  await q(db, sql`DELETE FROM aa_user_permissions WHERE user_id = ${general.id}::uuid AND perm = 'categories.view'`);
  assert.equal((await call("GET", "/categories/tree", general.cookie)).status, 403, "revoked");
  await q(db, sql`INSERT INTO aa_user_permissions (user_id, perm) VALUES (${general.id}::uuid, 'categories.view')`);
});

test("admin-only surfaces stay admin-only even if a grant for them is planted in the database", async () => {
  await q(db, sql`INSERT INTO aa_user_permissions (user_id, perm) VALUES (${general.id}::uuid, 'settings.manage'), (${general.id}::uuid, 'users.manage'), (${general.id}::uuid, 'orders.delete') ON CONFLICT DO NOTHING`);
  for (const [m, p] of [["GET", "/discount-tiers"], ["GET", "/payment-rules"], ["GET", "/blocks"], ["POST", "/orders/1/cancel"], ["DELETE", "/orders/1"], ["POST", "/orders/bulk-action"]] as const)
    assert.equal((await call(m, p, general.cookie)).status, 403, `${m} ${p}`);
  assert.equal((await call("GET", "/admin-v2/users", general.cookie)).status, 403);
});

test("orders are row-scoped: a mono operator sees only their own, and another's order answers 404", async () => {
  const mine = (await json(await call("POST", "/admin-v2/orders", admin.cookie, order({ customerName: "Assigned To Mono" })))).order;
  const other = (await json(await call("POST", "/admin-v2/orders", admin.cookie, order({ customerName: "Not For Mono" })))).order;
  await q(db, sql`UPDATE orders SET assigned_to = ${mono.email} WHERE id = ${mine.id}`);
  await q(db, sql`UPDATE orders SET assigned_to = ${admin.email} WHERE id = ${other.id}`);
  const list = await json(await call("GET", "/orders?pageSize=100", mono.cookie));
  const ids = list.orders.map((o: any) => o.id);
  assert.ok(ids.includes(mine.id)); assert.ok(!ids.includes(other.id));
  assert.equal((await call("GET", `/orders/${mine.id}`, mono.cookie)).status, 200);
  assert.equal((await call("GET", `/orders/${other.id}`, mono.cookie)).status, 404, "concealed, not 403");
  assert.equal((await call("POST", `/orders/${other.id}/deliver`, mono.cookie, {})).status, 404);
  const adminList = await json(await call("GET", "/orders?pageSize=100", admin.cookie));
  assert.ok(adminList.orders.some((o: any) => o.id === other.id), "admin still sees everything");
  const gList = await json(await call("GET", "/orders?pageSize=100", general.cookie));
  assert.ok(gList.orders.some((o: any) => o.id === other.id), "general sees all staff orders");
});

test("a mono operator cannot use an action their grants do not include (mark-paid), even on their own order", async () => {
  const o = (await json(await call("POST", "/admin-v2/orders", mono.cookie, order({ customerName: "Own Order" })))).order;
  assert.equal((await call("POST", `/orders/${o.id}/mark-paid`, mono.cookie, {})).status, 403);
  const g0 = await call("GET", `/orders/${o.id}`, mono.cookie); assert.equal(g0.status, 200, "own order readable " + JSON.stringify(o));
  const ed = await call("PATCH", `/orders/${o.id}`, mono.cookie, { customerName: "Edited" }); assert.equal(ed.status, 200, `orders.change granted: ${await ed.text()}`);
});

/* --------------------------------- reports --------------------------------- */

test("reports: a mono operator's report counts only orders assigned to them; admin and general see the general one", async () => {
  const reportTotal = async (who: Who) => {
    const j = await json(await call("GET", "/reports/monthly-kpis?months=1", who.cookie));
    assert.equal(j.reports.length >= 1, true);
    return Number(j.reports[j.reports.length - 1].totalOrders);
  };
  const monoOwn = Number((await q<{ c: number }>(db, sql`SELECT count(*)::int AS c FROM orders WHERE assigned_to = ${mono.email} AND created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')`))[0].c);
  assert.ok(monoOwn >= 1);
  const monoTotal = await reportTotal(mono);
  const adminTotal = await reportTotal(admin);
  assert.ok(monoTotal <= monoOwn, "never more than their own orders");
  assert.ok(adminTotal > monoTotal, "the general report is the whole business");
  assert.equal(await reportTotal(general), adminTotal, "general sees the general report");
});

test("reports: site-wide visitor analytics are part of the general report, not for a restricted operator", async () => {
  assert.equal((await call("GET", "/reports/visitors", mono.cookie)).status, 403);
  assert.equal((await call("GET", "/reports/visitors", admin.cookie)).status, 200);
  assert.equal((await call("GET", "/reports/visitors", general.cookie)).status, 200);
  assert.equal((await call("GET", "/reports/monthly-kpis", bare.cookie)).status, 403, "no reports.view, no reports");
});

test("/auth/me tells the console what each user may open and which controls to show", async () => {
  const a = await json(await call("GET", "/auth/me", admin.cookie));
  assert.ok(a.perms.includes("orders.add") && a.perms.includes("settings.manage") && a.perms.includes("media.view"));
  assert.ok(a.permissions.includes("products:write"));
  const m = await json(await call("GET", "/auth/me", mono.cookie));
  assert.deepEqual([...m.perms].sort(), ["orders.add", "orders.change", "orders.status.delivered", "orders.view", "reports.view"]);
  assert.ok(!m.permissions.includes("products:write") && !m.permissions.includes("categories:write"));
  const b = await json(await call("GET", "/auth/me", bare.cookie));
  assert.deepEqual(b.perms, []); assert.deepEqual(b.permissions, []);
});

test("manual order: when the assignment rules refuse (spam-flagged customer) the order is still created, and the creator is told it is not in their list", async () => {
  const phone = nextPhone();
  await q(db, sql`INSERT INTO spam_flags (phone_norm, reason, flagged_by) VALUES (${normalizePhone(phone)}, 'test fixture', 'test')`);
  try {
    const r = await call("POST", "/admin-v2/orders", mono.cookie, order({ phone, whatsapp: phone }));
    assert.equal(r.status, 201);
    const j = await json(r);
    assert.equal(j.order.createdBy, mono.email, "still records who entered it");
    assert.equal(j.visibleToCreator, false);
    const list = await json(await call("GET", "/orders?pageSize=100", mono.cookie));
    assert.ok(!list.orders.some((o: any) => o.id === j.order.id));
  } finally { await q(db, sql`DELETE FROM spam_flags WHERE reason = 'test fixture'`); }
});
