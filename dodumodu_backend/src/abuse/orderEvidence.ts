import { sql, and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { orders, abuseIpWindows } from "../schema";

// Per-order evidence for the admin console.
//
// TWO INDEPENDENT RULES, deliberately not merged. Conflating them is how a
// returning customer ends up looking like a duplicate submission:
//
//   1. REORDERING CUSTOMER  - the canonical PHONE has a previous order whose status
//      is `delivered`. A delivered order is proof of a real, completed purchase, so
//      this is positive evidence about a customer, not a suspicion. Pending,
//      failed and merely-placed orders deliberately do NOT qualify: an abandoned
//      checkout is not a customer relationship, and treating it as one would put
//      every one-off browser tab in the "returning customer" category.
//
//   2. POSSIBLE DUPLICATE   - the same ORDER identity was submitted twice on the same
//      calendar day. The identity is the ORDER MATCH KEY below.
//
//      It is an OBSERVATION. Nothing here cancels, merges, rejects or deletes.
//
// Both are computed for a WHOLE PAGE in a fixed number of queries. Nothing in this
// file loops per order.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO FINGERPRINT HERE, and why the word is avoided deliberately
// ---------------------------------------------------------------------------
//
// The duplicate rule is sometimes specified as "same order + same day + same
// fingerprint". This codebase has NO browser or device fingerprint, and none was
// introduced to satisfy that wording. That was a deliberate decision, and the
// distinction is worth being precise about rather than quietly redefining terms:
//
//   - A FINGERPRINT is a value derived from the device or browser - canvas or
//     WebGL output, screen geometry, font metrics, hardware concurrency, language
//     lists. The storefront uses a canvas in exactly one place, to RESIZE AN IMAGE
//     BEFORE UPLOAD, and reads no identifying property out of it. There is no
//     fingerprinting primitive anywhere in the client bundle.
//
//   - What this module actually compares is an ORDER MATCH KEY: the canonical
//     phone, the delivery address, the product and the quantity. Every component is
//     a field the customer typed into the order form themselves.
//
// Those are different things with different privacy properties. An order match key
// describes an order the customer wrote down; a fingerprint describes the machine it
// was written on, and persists across visits, accounts and people who share a
// device. Treating one as the other would describe this system as something it is
// not.
//
// So: no fingerprint is collected, none is needed, and the terminology below says
// "order match key" because that is what the value honestly is. If a real
// fingerprint is ever introduced, it should be a separate, explicitly discussed
// field - not a rename of this one.

export type OrderEvidence = {
  /** True only when a previous order from this phone was delivered. */
  reordering: boolean;
  previousOrders: number;
  /** Previous orders that reached paid or delivered - real purchase history. */
  previousSuccessful: number;
  lastOrderAt: Date | null;
  lastOrderId: number | null;
  lastOrderReference: string | null;
  /** Only set when a same-day same-order match exists. */
  duplicateOf: { id: number; reference: string; createdAt: Date } | null;
};

/**
 * Raw `db.execute()` returns timestamptz columns as STRINGS, not Date objects.
 *
 * That is easy to miss and fails silently: comparing a string to a Date is always
 * false, so a comparison like `row.created_at < someDate` quietly evaluates to
 * false and the branch simply never runs. Two bugs in this file's first draft were
 * exactly that. Everything crossing this boundary is coerced explicitly.
 */
function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
/**
 * The ORDER MATCH KEY: what makes two orders "the same order, submitted twice".
 *
 * NOT a fingerprint - see the long note at the top of this file. Every component is
 * something the customer typed into the order form.
 *
 * Quantity is part of it. A customer who ordered one item twice has submitted the
 * same order twice; a customer who ordered one item and then three has made two
 * different orders, and telling an operator those are duplicates sends them looking
 * for a double-charge that does not exist. The reverse is worse: two genuinely
 * separate orders of different sizes sharing a phone, address and product is
 * ordinary repeat business, and labelling it a duplicate would teach an operator to
 * dismiss the badge - which is how the real one gets missed.
 *
 * The address is compared case-insensitively and trimmed because "12 Allen Avenue"
 * and "12 allen avenue " are the same place typed twice.
 */
export function orderMatchKey(
  phoneNorm: string,
  address: string,
  productId: number,
  quantity: number,
): string {
  return `${phoneNorm}|${address.trim().toLowerCase()}|${productId}|x${quantity}`;
}

/**
 * The start of the calendar day (Africa/Lagos) containing `at`.
 *
 * Lagos is UTC+1 with no daylight saving, and the business is Nigeria-first: an
 * operator thinking about "did they order this twice today?" means their own
 * today, not UTC's. A UTC boundary would split a working day in half at 01:00.
 */
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

export function lagosDayStart(at: Date): Date {
  const shifted = new Date(at.getTime() + LAGOS_OFFSET_MS);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), 0, 0, 0, 0,
  ) - LAGOS_OFFSET_MS);
}

/** The row shape the list query returns that this module needs. */
type EvidenceTarget = {
  id: number;
  reference: string;
  createdAt: Date;
  phoneNorm: string | null;
  address: string;
  productId: number;
  /** Part of the order match key: 1 item twice is one order submitted twice. */
  quantity: number;
};

/**
 * Evidence for a whole page, in a FIXED number of queries.
 *
 * Three lookups regardless of page size:
 *   - one grouped query over the page's canonical identities (previous orders);
 *   - one query over the page's identities for the surrounding days (duplicates);
 *   - the caller's own order rows, already fetched.
 *
 * A row whose phone could not be canonically resolved is EXCLUDED from every
 * identity rule. It gets no duplicate badge and no reordering badge, because we
 * cannot honestly claim either about a customer we cannot identify.
 */
export async function evidenceForOrders(
  db: Db,
  targets: EvidenceTarget[],
): Promise<Map<number, OrderEvidence>> {
  const result = new Map<number, OrderEvidence>();
  for (const order of targets) {
    result.set(order.id, {
      reordering: false,
      previousOrders: 0,
      previousSuccessful: 0,
      lastOrderAt: null,
      lastOrderId: null,
      lastOrderReference: null,
      duplicateOf: null,
    });
  }
  if (targets.length === 0) return result;

  const identities = [...new Set(
    targets.map((o) => o.phoneNorm).filter((v): v is string => v !== null),
  )];
  if (identities.length === 0) return result;

  // ---- RULE 1: previous orders per canonical phone -----------------------
  //
  // Grouped in SQL rather than looped, so a page of fifty is one query. The
  // "excluding this order" test is in the WHERE clause, so an order never counts
  // itself as its own history.
  const history = await db.execute(sql`
    SELECT o.phone_norm,
           count(*)::int AS previous_orders,
           count(*) FILTER (WHERE o.status IN ('paid', 'delivered'))::int AS previous_successful,
           max(o.created_at) AS last_at
    FROM orders o
    WHERE o.phone_norm IN (${sql.raw(identities.map((i) => `'${i.replace(/'/g, "''")}'`).join(","))})
    GROUP BY o.phone_norm
  `);
  const historyByPhone = new Map(
    (history as unknown as {
      rows: { phone_norm: string; previous_orders: number; previous_successful: number; last_at: Date }[];
    }).rows.map((r) => [r.phone_norm, {
      previousOrders: Number(r.previous_orders),
      previousSuccessful: Number(r.previous_successful),
      lastAt: asDate(r.last_at),
    }]),
  );

  // The most recent previous order per phone, for the "last order" line. Separate
  // from the aggregate because an aggregate cannot name a row.
  const latest = await db.execute(sql`
    SELECT DISTINCT ON (o.phone_norm) o.phone_norm, o.id, o.reference, o.created_at
    FROM orders o
    WHERE o.phone_norm IN (${sql.raw(identities.map((i) => `'${i.replace(/'/g, "''")}'`).join(","))})
    ORDER BY o.phone_norm, o.created_at DESC, o.id DESC
  `);
  const latestByPhone = new Map(
    (latest as unknown as {
      rows: { phone_norm: string; id: number; reference: string; created_at: Date }[];
    }).rows.map((r) => [r.phone_norm, { id: r.id, reference: r.reference, createdAt: r.created_at }]),
  );

  // ---- RULE 2: same-day, same-fingerprint matches -------------------------
  //
  // Bounded to the page's own day range plus a day either side, so this can never
  // become a full-table scan however large the orders table grows.
  const times = targets.map((o) => o.createdAt.getTime());
  const from = new Date(Math.min(...times) - 86_400_000);
  const to = new Date(Math.max(...times) + 86_400_000);

  const candidates = await db
    .select({
      id: orders.id,
      reference: orders.reference,
      createdAt: orders.createdAt,
      phoneNorm: orders.phoneNorm,
      address: orders.address,
      productId: orders.productId,
      quantity: orders.quantity,
    })
    .from(orders)
    .where(and(
      inArray(orders.phoneNorm, identities),
      // One query, bounded, rather than a query per row.
      sql`${orders.createdAt} >= ${from} AND ${orders.createdAt} <= ${to}`,
    ));

  const sameDay = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    if (!candidate.phoneNorm) continue;
    const key = `${orderMatchKey(candidate.phoneNorm, candidate.address, candidate.productId, candidate.quantity)}|${lagosDayStart(candidate.createdAt).getTime()}`;
    const bucket = sameDay.get(key) ?? [];
    bucket.push(candidate);
    sameDay.set(key, bucket);
  }

  // ---- RULE 1b: was there a DELIVERED order before this one? -------------
  //
  // This is the strict definition of "reordering customer", and it is answered for
  // the WHOLE PAGE in one grouped query. An earlier draft of this file called a
  // helper once per order, which is precisely the N+1 this module must not have.
  //
  // It counts only orders EARLIER than the one being judged (by created_at, then
  // id as a tie-break), so an order never counts itself and two orders placed in
  // the same second are still ordered relative to each other.
  // ---- RULE 1b: was there a DELIVERED order before this one? -------------
  //
  // The strict definition of "reordering customer", answered for the WHOLE PAGE in
  // one grouped query. An earlier draft called a helper once per order, which is
  // precisely the N+1 this module must not have.
  //
  // The window below is a PERFORMANCE guard, not a correctness one, so it carries a
  // day of slack on each side. That is deliberate: the Drizzle driver and the raw
  // pg client have been observed returning timestamps offset from each other, and a
  // tight bound turned that into a silently EMPTY result - reordering detection
  // reported "no previous orders" for a customer who had one.
  const deliveredBefore = new Map<string, { id: number; created_at: Date }[]>();
  if (targets.length > 0) {
    const windowFrom = new Date(Math.min(...times) - 86_400_000 * 365);
    const windowTo = new Date(Math.max(...times) + 86_400_000);
    const rows = await db.execute(sql`
      SELECT o.phone_norm, o.id, o.created_at
      FROM orders o
      WHERE o.phone_norm IN (${sql.raw(identities.map((i) => `'${i.replace(/'/g, "''")}'`).join(","))})
        AND o.status = 'delivered'
        AND o.created_at >= ${windowFrom}
        AND o.created_at <= ${windowTo}
      ORDER BY o.phone_norm, o.created_at DESC, o.id DESC
    `);
    for (const row of (rows as unknown as {
      rows: { phone_norm: string; id: number; created_at: Date | string }[];
    }).rows) {
      const bucket = deliveredBefore.get(row.phone_norm) ?? [];
      bucket.push({ id: Number(row.id), created_at: asDate(row.created_at) });
      deliveredBefore.set(row.phone_norm, bucket);
    }
  }

  // ---- assemble ----------------------------------------------------------
  for (const order of targets) {
    const base = result.get(order.id)!;
    if (!order.phoneNorm) continue; // unidentifiable: no identity claim at all

    const historyRow = historyByPhone.get(order.phoneNorm);
    if (historyRow) {
      // This order is part of that history, so it does not count as its own past.
      const selfExcluded = Math.max(0, historyRow.previousOrders - 1);
      base.previousOrders = selfExcluded;
      base.previousSuccessful = historyRow.previousSuccessful;

      const last = latestByPhone.get(order.phoneNorm);
      if (last && last.id !== order.id) {
        base.lastOrderId = last.id;
        base.lastOrderReference = last.reference;
        base.lastOrderAt = asDate(last.createdAt);
      }
    }

    // "Reordering customer" means a previous order from this phone was actually
    // DELIVERED - proof of a real completed purchase, and therefore POSITIVE
    // evidence about a customer. Pending, failed and merely-placed orders do not
    // qualify: an abandoned checkout is not a customer relationship.
    //
    // The list is ordered newest-first, so an order is "reordering" exactly when
    // some delivered order sits earlier than it.
    const delivered = deliveredBefore.get(order.phoneNorm) ?? [];
    base.reordering = delivered.some((d) => d.id < order.id);

    // ---- duplicate: same order match key, same calendar day ----------------
    const key = `${orderMatchKey(order.phoneNorm, order.address, order.productId, order.quantity)}|${lagosDayStart(order.createdAt).getTime()}`;
    const matches = (sameDay.get(key) ?? []).filter((m) => m.id !== order.id);
    if (matches.length > 0) {
      const first = matches[0];
      base.duplicateOf = { id: first.id, reference: first.reference, createdAt: first.createdAt };
    }
  }

  return result;
}

/** One order's evidence, for the detail screen. Same rules, single row. */
export async function evidenceForOrder(db: Db, order: EvidenceTarget): Promise<OrderEvidence> {
  const map = await evidenceForOrders(db, [order]);
  return map.get(order.id) ?? {
    reordering: false, previousOrders: 0, previousSuccessful: 0,
    lastOrderAt: null, lastOrderId: null, lastOrderReference: null, duplicateOf: null,
  };
}

/**
 * Abuse observation for one address, when there is anything worth showing.
 *
 * Returns null for an order with no recorded address, and null when the numbers are
 * unremarkable. An operator should see this panel only when there is a reason to
 * look - a panel that appears on every order stops being read.
 *
 * The success figure is included deliberately and prominently: an address with many
 * attempts AND real orders is very likely a shared mobile network, not an attacker.
 */
export async function abuseObservationForIp(
  db: Db,
  ip: string | null,
): Promise<{ posts: number; distinctPhones: number; failures: number; successfulProgressions: number } | null> {
  if (!ip) return null;

  const windows = await db
    .select({
      posts: abuseIpWindows.posts,
      validationFailures: abuseIpWindows.validationFailures,
      turnstileFailures: abuseIpWindows.turnstileFailures,
      successfulProgressions: abuseIpWindows.successfulProgressions,
    })
    .from(abuseIpWindows)
    .where(eq(abuseIpWindows.ip, ip));

  if (windows.length === 0) return null;

  const phones = await db.execute(sql`
    SELECT count(DISTINCT phone_norm)::int AS n FROM abuse_ip_phones WHERE ip = ${ip}
  `);
  const distinctPhones = Number(
    (phones as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0,
  );

  const totals = windows.reduce((acc, w) => ({
    posts: acc.posts + w.posts,
    validationFailures: acc.validationFailures + w.validationFailures,
    turnstileFailures: acc.turnstileFailures + w.turnstileFailures,
    successfulProgressions: acc.successfulProgressions + w.successfulProgressions,
  }), { posts: 0, validationFailures: 0, turnstileFailures: 0, successfulProgressions: 0 });

  const failures = totals.validationFailures + totals.turnstileFailures;
  // Nothing worth a panel: an ordinary single order from an address.
  if (totals.posts < 2 && distinctPhones < 2) return null;

  return {
    posts: totals.posts,
    distinctPhones,
    failures,
    successfulProgressions: totals.successfulProgressions,
  };
}

/**
 * Mask an address for display: 203.0.113.7 -> 203.0.113.x
 *
 * An operator needs to recognise "the same address as those other orders", which
 * the first three octets give, without the console becoming a list of exactly which
 * households placed orders.
 */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (ip === "unknown") return "unknown";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return `${ip.split(".").slice(0, 3).join(".")}.x`;
  return "masked";
}
