// Read-only shadow evidence for reviewing the future policy.
//
// WHAT THIS IS FOR: answering "would this policy accidentally interfere with
// genuine customers?" from evidence rather than intuition.
//
// WHAT IT DELIBERATELY DOES NOT DO:
//
//   - No risk score. Collapsing distinct signals into one number would hide
//     exactly the thing that matters: a shared carrier NAT and a fraudster can
//     produce the SAME request volume and fail completely differently on
//     legitimate progression.
//   - No "spam" labels. Nothing here decides anybody is a spammer. The signals
//     and the legitimate counter-evidence are reported side by side, and the
//     judgement stays with a person.
//   - No enforcement, and no new thresholds. RL_MODE stays shadow; this reads
//     what was already recorded.
//
// THE SHARED-IP POINT, which is the reason the columns come in pairs: an IP is an
// AGGREGATION of customers, not a customer. Every "pressure" number is shown next
// to the successful progressions from the same IP, because a carrier NAT with 40
// real orders is not the same thing as 40 orders with no successes - and only the
// second would ever approach a restriction.
import { sql } from "drizzle-orm";
import type { Db } from "../db";
import { maskPhone } from "./spamRepo";

export type ShadowReport = {
  windowSeconds: number;
  since: Date;
  totals: {
    windows: number;
    uniqueIps: number;
    posts: number;
    validationFailures: number;
    turnstileFailures: number;
    successfulProgressions: number;
    distinctPhones: number;
    ordersInPeriod: number;
    ordersWithIdentity: number;
    ordersAwaitingPayment: number;
    ordersFailed: number;
    ordersConfirmedCod: number;
    ordersPaid: number;
    ordersDelivered: number;
    /** Orders whose phone could not be canonically resolved - excluded, not blocked. */
    ordersUnidentifiable: number;
  };
  ips: {
    ip: string;
    posts: number;
    distinctPhones: number;
    validationFailures: number;
    turnstileFailures: number;
    /**
     * The counter-evidence column, and the one that decides the reading. An IP with
     * high volume AND successes is a busy shared address; high volume with zero
     * successes is the only shape that could ever approach a restriction.
     */
    successfulProgressions: number;
    windowStart: number;
  }[];
  /** IPs whose volume is high relative to their successes: candidates to REVIEW. */
  candidatesForReview: {
    ip: string;
    posts: number;
    distinctPhones: number;
    failures: number;
    successfulProgressions: number;
    note: string;
  }[];
  recentObservations: {
    createdAt: Date;
    outcome: string;
    wouldRestrict: boolean;
    reason: string | null;
    phoneMasked: string | null;
  }[];
};


export async function buildShadowReport(
  db: Db,
  opts: { windowSeconds: number; now?: Date; limit?: number },
): Promise<ShadowReport> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - opts.windowSeconds * 1000);
  const sinceSeconds = Math.floor(since.getTime() / 1000);
  const limit = opts.limit ?? 100;

  // One window, one aggregate query for the IP-level table.
  const ipRows = await db.execute(sql`
    SELECT w.ip,
           sum(w.posts)::int                     AS posts,
           sum(w.validation_failures)::int       AS validation_failures,
           sum(w.turnstile_failures)::int        AS turnstile_failures,
           sum(w.successful_progressions)::int   AS successful_progressions,
           max(w.window_start)                   AS window_start
    FROM abuse_ip_windows w
    WHERE w.window_start >= ${sinceSeconds}
    GROUP BY w.ip
    ORDER BY posts DESC
    LIMIT ${limit}
  `);
  const ips = (ipRows as unknown as {
    rows: { ip: string; posts: number; validation_failures: number; turnstile_failures: number; successful_progressions: number; window_start: number }[];
  }).rows;

  // Distinct phones per IP, from the table that exists to count them exactly.
  const phoneRows = await db.execute(sql`
    SELECT ip, count(*)::int AS distinct_phones
    FROM abuse_ip_phones
    WHERE window_start >= ${sinceSeconds}
    GROUP BY ip
  `);
  const phonesByIp = new Map(
    (phoneRows as unknown as { rows: { ip: string; distinct_phones: number }[] }).rows
      .map((r) => [r.ip, Number(r.distinct_phones)]),
  );

  // Order-side truth, counted straight from the orders table by status.
  const orderRows = await db.execute(sql`
    SELECT count(*)::int AS total,
           count(phone_norm)::int AS with_identity,
           count(*) FILTER (WHERE phone_norm IS NULL)::int AS unidentifiable,
           count(*) FILTER (WHERE status = 'awaiting_payment')::int AS awaiting_payment,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE status = 'confirmed_cod')::int AS confirmed_cod,
           count(*) FILTER (WHERE status = 'paid')::int AS paid,
           count(*) FILTER (WHERE status = 'delivered')::int AS delivered
    FROM orders
    WHERE created_at >= ${since}
  `);
  const orderStats = (orderRows as unknown as {
    rows: { total: number; with_identity: number; unidentifiable: number; awaiting_payment: number; failed: number; confirmed_cod: number; paid: number; delivered: number }[];
  }).rows[0];

  const enriched = ips.map((row) => ({
    ip: row.ip,
    posts: Number(row.posts),
    distinctPhones: phonesByIp.get(row.ip) ?? 0,
    validationFailures: Number(row.validation_failures),
    turnstileFailures: Number(row.turnstile_failures),
    successfulProgressions: Number(row.successful_progressions),
    windowStart: Number(row.window_start),
  }));

  // The headline numbers, read from observation rather than recomputed.
  const totals = {
    windows: await countWindows(db, sinceSeconds),
    uniqueIps: await countDistinctIps(db, sinceSeconds),
    posts: sum(enriched.map((i) => i.posts)),
    validationFailures: sum(enriched.map((i) => i.validationFailures)),
    turnstileFailures: sum(enriched.map((i) => i.turnstileFailures)),
    successfulProgressions: sum(enriched.map((i) => i.successfulProgressions)),
    distinctPhones: await countDistinctPhones(db, sinceSeconds),
    ordersInPeriod: Number(orderStats?.total ?? 0),
    ordersWithIdentity: Number(orderStats?.with_identity ?? 0),
    ordersAwaitingPayment: Number(orderStats?.awaiting_payment ?? 0),
    ordersFailed: Number(orderStats?.failed ?? 0),
    ordersConfirmedCod: Number(orderStats?.confirmed_cod ?? 0),
    ordersPaid: Number(orderStats?.paid ?? 0),
    ordersDelivered: Number(orderStats?.delivered ?? 0),
    ordersUnidentifiable: Number(orderStats?.unidentifiable ?? 0),
  };

  // "Candidates for review" means: volume worth a human LOOKING at. It is not a
  // verdict and it deliberately favours showing shared-NAT shapes loudly rather
  // than quietly, because the cost of a false positive here is a real customer
  // being looked at as a suspect, and the cost of over-showing is an operator's
  // time.
  // The recorded shadow verdicts themselves: what the rule said at the time. In shadow
  // mode this is the only place a would-have-restricted decision is retained.
  const observationRows = await db.execute(sql`
    SELECT o.created_at, o.outcome, o.would_restrict, o.reason, o.phone_norm
    FROM abuse_observations o
    WHERE o.created_at >= ${since}
    ORDER BY o.created_at DESC
    LIMIT 50
  `);
  const recentObservations = (observationRows as unknown as {
    rows: { created_at: Date; outcome: string; would_restrict: boolean; reason: string | null; phone_norm: string | null }[];
  }).rows.map((row) => ({
    createdAt: row.created_at,
    outcome: row.outcome,
    wouldRestrict: row.would_restrict,
    reason: row.reason,
    // Masked: this list can be long, and a column of full numbers is customer data
    // the operator does not need in order to judge a policy.
    phoneMasked: row.phone_norm ? maskPhone(row.phone_norm) : null,
  }));

  const candidatesForReview = enriched
    .filter((i) => i.posts >= 5 && i.successfulProgressions === 0)
    .map((i) => ({
      ip: i.ip,
      posts: i.posts,
      distinctPhones: i.distinctPhones,
      failures: i.validationFailures + i.turnstileFailures,
      successfulProgressions: i.successfulProgressions,
      note: i.distinctPhones > 1
        ? `${i.distinctPhones} different numbers from one address and no successful order. `
          + "A shared mobile network can look like this, so check before concluding anything."
        : "Repeated attempts at one number with no successful order. More likely one "
          + "customer on a bad connection than an attacker.",
    }))
    .slice(0, 25);

  return {
    windowSeconds: opts.windowSeconds,
    since,
    totals,
    ips: enriched,
    candidatesForReview,
    recentObservations,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function countWindows(db: Db, sinceSeconds: number): Promise<number> {
  const result = await db.execute(sql`SELECT count(*)::int AS n FROM abuse_ip_windows WHERE window_start >= ${sinceSeconds}`);
  return Number((result as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);
}

async function countDistinctIps(db: Db, sinceSeconds: number): Promise<number> {
  const result = await db.execute(sql`SELECT count(DISTINCT ip)::int AS n FROM abuse_ip_windows WHERE window_start >= ${sinceSeconds}`);
  return Number((result as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);
}

async function countDistinctPhones(db: Db, sinceSeconds: number): Promise<number> {
  const result = await db.execute(sql`SELECT count(DISTINCT phone_norm)::int AS n FROM abuse_ip_phones WHERE window_start >= ${sinceSeconds}`);
  return Number((result as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0);
}
