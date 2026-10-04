import { sql } from "drizzle-orm";
import type { Db } from "../db";
import type { AbuseConfig } from "./config";

// Burst detection: "how fast did real orders arrive", answered by reading `orders`.
//
// WHY THIS IS A QUERY AND NOT A COUNTER. A separate velocity counter would be a
// second source of truth about something `orders` already records, and the two can
// disagree - a counter that survives a rollback, or counts an order that never
// committed. Counting committed rows cannot describe an order that does not exist.
// It is also the only form that can answer the question that separates a script from
// a crowd: how many DISTINCT identities, not how many requests.
//
// THE DB CLOCK. Every window is `now() - interval`, evaluated by PostgreSQL. The
// application clock is never used for these bounds. A worker whose clock drifts
// would otherwise compute a window that silently excludes recent orders (firing
// late) or includes old ones (firing early), and neither failure is visible from
// the outside. Delegating the comparison removes the possibility rather than
// documenting it.
//
// THE ONLY REFUSAL IN THE SYSTEM lives here and behind RL_AUTO_BLOCK. Everything
// else in the abuse layer observes.

// ---------------------------------------------------------------------------
// V1 - device scoped. The primary rule.
//
// One client, several DIFFERENT identities, inside a very short window. The
// distinct-phone requirement is what makes this safe rather than merely strict: a
// customer retrying a declined payment ten times has ONE phone and cannot match it,
// however fast they click. Rotating through numbers is not something a person does.
export type DeviceBurst = { orders: number; phones: number };

/**
 * Count a device's recent committed orders.
 *
 * device_id is matched EXACTLY, with no trimming or folding: it is an opaque
 * client-supplied token, not an identity we are entitled to reinterpret.
 */
export async function deviceBurst(
  db: Db,
  deviceId: string,
  windowSeconds: number,
): Promise<DeviceBurst> {
  const result: any = await db.execute(sql`
    SELECT count(*)::int                   AS orders,
           count(DISTINCT phone_norm)::int AS phones
    FROM orders
    WHERE device_id = ${deviceId}
      AND created_at >= now() - make_interval(secs => ${windowSeconds})
  `);
  const row = result?.rows?.[0] ?? {};
  return { orders: Number(row.orders ?? 0), phones: Number(row.phones ?? 0) };
}

// ---------------------------------------------------------------------------
// V2 - address scoped. The last resort, and off by default.
//
// V1 is defeated by spreading one burst across several devices. V2 exists to see
// that, which makes it the rule most likely to be WRONG: a shared address is not
// distinguishable from a bot by volume alone. The concentration test is the only
// thing separating them, and it is why a crowd of real people - each on their own
// device, each ordering once - cannot match.
export type IpBurst = {
  orders: number;
  phones: number;
  devices: number;
  /** Orders carrying no usable device id. A bot that omits it lands here. */
  noDevice: number;
  /** Orders on the single busiest device. The concentration numerator. */
  topDeviceOrders: number;
  /** max(topDeviceOrders, noDevice) / orders, as a proportion. */
  concentration: number;
  /**
   * True when the volume looks like a burst but the identities are spread thinly
   * across many devices - the rotating-id bot. A DOCUMENTED GAP, not a verdict:
   * no honest rule separates that from a real crowd, so it is reported rather than
   * guessed at.
   */
  rotatingIds: boolean;
};

export async function ipBurst(
  db: Db,
  ip: string,
  windowSeconds: number,
): Promise<IpBurst> {
  const result: any = await db.execute(sql`
    WITH scoped AS (
      SELECT phone_norm, NULLIF(btrim(device_id), '') AS device
      FROM orders
      WHERE created_from_ip = ${ip}
        AND created_at >= now() - make_interval(secs => ${windowSeconds})
    ),
    agg AS (
      SELECT count(*)::int                              AS orders,
             count(DISTINCT phone_norm)::int             AS phones,
             count(DISTINCT device)::int                 AS devices,
             count(*) FILTER (WHERE device IS NULL)::int AS no_device
      FROM scoped
    ),
    top AS (
      SELECT COALESCE(max(c), 0)::int AS top_device_orders
      FROM (
        SELECT count(*)::int AS c
        FROM scoped
        WHERE device IS NOT NULL
        GROUP BY device
      ) g
    )
    SELECT agg.orders, agg.phones, agg.devices, agg.no_device, top.top_device_orders
    FROM agg CROSS JOIN top
  `);
  const row = result?.rows?.[0] ?? {};
  const orders = Number(row.orders ?? 0);
  const phones = Number(row.phones ?? 0);
  const noDevice = Number(row.no_device ?? 0);
  const topDeviceOrders = Number(row.top_device_orders ?? 0);
  const concentration = orders > 0 ? Math.max(topDeviceOrders, noDevice) / orders : 0;
  return {
    orders,
    phones,
    devices: Number(row.devices ?? 0),
    noDevice,
    topDeviceOrders,
    concentration,
    rotatingIds: orders > 0 && concentration < 0.7 && phones >= 4,
  };
}
// ---------------------------------------------------------------------------
// The decision. Pure functions, no database, so every threshold can be reasoned
// about - and tested - without a running server.
// ---------------------------------------------------------------------------

export type BurstDecision = {
  matched: boolean;
  /** Which rule, for the log line and the evidence JSON. */
  rule: "v1_device" | "v2_ip" | null;
  /** The subject to block: a device id or an address. Never a phone. */
  scope: "device" | "ip" | null;
  subject: string | null;
  /** The arithmetic, in the order an operator would ask for it. */
  arithmetic: string;
  /** Which test failed, when it did. Same purpose as the volume rule's. */
  shortOf: string[];
  /** V2 only: volume present, identities too scattered to act on. */
  rotatingIds: boolean;
};

const NO_MATCH: BurstDecision = {
  matched: false, rule: null, scope: null, subject: null,
  arithmetic: "", shortOf: [], rotatingIds: false,
};

/**
 * V1. One device, several identities, inside a very short window.
 *
 * `burst` counts COMMITTED orders only, and the incoming attempt is deliberately NOT
 * included. So the order that reaches the threshold always completes, and the NEXT
 * attempt is the one refused - a customer is never left wondering whether the order
 * they submitted happened.
 */
export function decideDeviceBurst(
  burst: DeviceBurst,
  config: AbuseConfig,
  subject: string,
): BurstDecision {
  const ordersHigh = burst.orders >= config.v1MinOrders;
  const phonesHigh = burst.phones >= config.v1MinPhones;
  const arithmetic = `${burst.orders} orders on one device in ${config.velocityWindowSeconds}s`
    + ` (floor ${config.v1MinOrders}), ${burst.phones} distinct numbers (floor ${config.v1MinPhones})`;

  if (ordersHigh && phonesHigh) {
    return { matched: true, rule: "v1_device", scope: "device", subject, arithmetic, shortOf: [], rotatingIds: false };
  }
  return {
    ...NO_MATCH,
    arithmetic,
    shortOf: [
      !ordersHigh && `orders ${burst.orders}/${config.v1MinOrders}`,
      !phonesHigh && `distinct numbers ${burst.phones}/${config.v1MinPhones}`,
    ].filter(Boolean) as string[],
  };
}

/**
 * V2. The address-scoped last resort.
 *
 * Volume and identity count are NECESSARY but nowhere near sufficient. The
 * concentration test is the rule's real content: an address only matches when its
 * burst sits on one device, or arrives with no device at all. A crowd of separate
 * real devices spreads the same orders thin and can never reach the ratio - which is
 * the property that makes this safe to enable at all.
 */
export function decideIpBurst(
  burst: IpBurst,
  config: AbuseConfig,
  subject: string,
): BurstDecision {
  const ordersHigh = burst.orders >= config.v2MinOrders;
  const phonesHigh = burst.phones >= config.v2MinPhones;
  const concentrated = burst.concentration >= config.v2DeviceRatio;
  const arithmetic = `${burst.orders} orders from one address in ${config.velocityWindowSeconds}s`
    + ` (floor ${config.v2MinOrders}), ${burst.phones} distinct numbers (floor ${config.v2MinPhones}),`
    + ` concentration ${(burst.concentration * 100).toFixed(0)}%`
    + ` = max(${burst.topDeviceOrders} on the busiest device, ${burst.noDevice} with no device)`
    + ` / ${burst.orders} (floor ${(config.v2DeviceRatio * 100).toFixed(0)}%),`
    + ` ${burst.devices} distinct devices`;

  if (ordersHigh && phonesHigh && concentrated) {
    return { matched: true, rule: "v2_ip", scope: "ip", subject, arithmetic, shortOf: [], rotatingIds: false };
  }
  return {
    ...NO_MATCH,
    arithmetic,
    rotatingIds: burst.rotatingIds,
    shortOf: [
      !ordersHigh && `orders ${burst.orders}/${config.v2MinOrders}`,
      !phonesHigh && `distinct numbers ${burst.phones}/${config.v2MinPhones}`,
      !concentrated && `concentration ${(burst.concentration * 100).toFixed(0)}%`
        + `/${(config.v2DeviceRatio * 100).toFixed(0)}%`,
    ].filter(Boolean) as string[],
  };
}

/**
 * Both rules, in the order they are tried.
 *
 * V1 first because it is the narrower claim: it blocks ONE DEVICE and leaves the
 * rest of the address alone. V2 blocks the whole address, a far larger action, so it
 * is reached only when V1 has nothing and only when switched on.
 *
 * A null device id skips V1 - there is no subject to block - and a null address skips
 * both. Neither is an error: it is the absence of evidence, and this function never
 * invents a subject to act on.
 *
 * This function ONLY decides. Whether the decision is acted on is the caller's
 * business, and in shadow mode it never is. Keeping the two apart is what makes
 * "observe" a property of the wiring rather than a promise.
 */
export async function evaluateBurst(
  db: Db,
  config: AbuseConfig,
  subject: { ip: string | null; deviceId: string | null },
): Promise<BurstDecision> {
  if (config.autoBlock === "off") return NO_MATCH;

  if (subject.deviceId) {
    const burst = await deviceBurst(db, subject.deviceId, config.velocityWindowSeconds);
    const decision = decideDeviceBurst(burst, config, subject.deviceId);
    if (decision.matched) return decision;
    if (subject.ip === null) return decision; // no address left to try V2 on
  }

  if (subject.ip === null) return NO_MATCH;

  if (!config.v2Enabled) {
    // Reported rather than silent, so an operator reading the log can tell "did not
    // match" apart from "was never consulted".
    return { ...NO_MATCH, shortOf: ["V2 is disabled (RL_V2_ENABLED=off)"] };
  }

  const burst = await ipBurst(db, subject.ip, config.velocityWindowSeconds);
  return decideIpBurst(burst, config, subject.ip);
}