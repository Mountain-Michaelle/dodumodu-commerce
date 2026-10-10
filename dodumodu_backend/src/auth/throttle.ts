// Reserve / settle / refund lifecycle — the security heart of R-NOLOCK.
//
// One failed-attempt reservation is made atomically BEFORE verification on
// exactly ONE key (never a second key that another client could trip):
//   - IP pair   key "stage:HMAC(email):ip"       -> anon tier   (spec §5.3)
//   - device    key "stage:HMAC(email):dev:<id>" -> device tier (trusted device)
//   - strict    key "stage:HMAC(email):dev:<id>:<prefix>" -> strict tier
// A per-email fuse ("fuse:HMAC(email)") only ever ADDS friction (Turnstile +
// alert email); it never locks (R-NOLOCK 2).
//
// Request lifecycle (Appendix F2):
//   reserve -> verify -> settle.
//   success  -> clearKeys()
//   wrong    -> noteFuse() (the reservation itself is the failure)
//   our fault-> refund() + 503 {retry:true} (R-NOLOCK 3; never 401 for a fault)
//
// PRECISION: aa_auth_refund's tripped-lock branch matches locked_until = p_lock
// EXACTLY, but Postgres stores microseconds and a JS Date keeps only ms. So we
// carry locked_until as its full-precision ::text from the reserve and hand the
// SAME string back to refund. Never round-trip it through Date.
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import {
  PAIR_THRESHOLD,
  LOCK_STEP_MIN,
  LOCK_MAX_MIN,
  DEVICE_THRESHOLD,
  DEVICE_LOCK_STEP_MIN,
  DEVICE_LOCK_MAX_MIN,
  STRICT_THRESHOLD,
  STRICT_LOCK_STEP_MIN,
  FUSE_FRICTION_THRESHOLD,
} from "./config";
import { AuthLockedError, AuthServerFaultError } from "./errors";

export type LockTier = "anon" | "device" | "strict";

interface TierParams {
  thr: number;
  stepMin: number;
  maxMin: number;
}

const TIERS: Record<LockTier, TierParams> = {
  anon: { thr: PAIR_THRESHOLD, stepMin: LOCK_STEP_MIN, maxMin: LOCK_MAX_MIN },
  device: { thr: DEVICE_THRESHOLD, stepMin: DEVICE_LOCK_STEP_MIN, maxMin: DEVICE_LOCK_MAX_MIN },
  strict: { thr: STRICT_THRESHOLD, stepMin: STRICT_LOCK_STEP_MIN, maxMin: LOCK_MAX_MIN },
};

/** A reservation made before verification. Keep it until you settle. */
export interface Reservation {
  key: string;
  /** Full-precision locked_until::text, or null if this reservation didn't trip a lock. */
  lockedUntil: string | null;
}

function msUntilLock(lockedUntil: string | null): number {
  if (!lockedUntil) return 0;
  const t = Date.parse(lockedUntil);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

/**
 * Reserve one attempt on a single key. Returns a Reservation when allowed.
 * Throws AuthLockedError (-> 429 with a countdown) when the key is locked.
 * Any DB/throw is a server fault: the caller answers 503 and does NOT get here.
 */
export async function reserve(db: Db, key: string, tier: LockTier): Promise<Reservation> {
  const p = TIERS[tier];
  const row = await q1<{ allowed: boolean; locked_until: string | null }>(
    db,
    sql`SELECT allowed, locked_until::text AS locked_until
        FROM aa_auth_reserve_v2(${key}, ${p.thr}, ${p.stepMin}, ${p.maxMin})`,
  );
  if (!row) throw new AuthServerFaultError("reserve returned no row");
  if (!row.allowed) throw new AuthLockedError(msUntilLock(row.locked_until));
  return { key, lockedUntil: row.locked_until };
}

/**
 * Refund one reservation after a fault of OURS (R-NOLOCK 3). Never call for a
 * wrong answer or a client abort. Returns whether the refund actually landed.
 */
export async function refund(db: Db, r: Reservation): Promise<boolean> {
  const row = await q1<{ aa_auth_refund: boolean }>(
    db,
    sql`SELECT aa_auth_refund(${r.key}, ${r.lockedUntil}) AS aa_auth_refund`,
  );
  return row?.aa_auth_refund ?? false;
}

/**
 * Non-blocking per-email fuse. Returns true when friction should turn on
 * (require Turnstile, send an alert email). Never locks (R-NOLOCK 2).
 * Called on a WRONG answer; not for our own faults.
 */
export async function noteFuse(db: Db, emailHmac: string): Promise<boolean> {
  const row = await q1<{ aa_auth_fuse_note: boolean }>(
    db,
    sql`SELECT aa_auth_fuse_note(${"fuse:" + emailHmac}, ${FUSE_FRICTION_THRESHOLD}) AS aa_auth_fuse_note`,
  );
  return row?.aa_auth_fuse_note ?? false;
}

/** Clear throttle state for these keys after a factor is verified (AUTH_CLEAR).
 * Each key is bound as its own scalar text param (via sql.join) instead of one
 * array param: drizzle serializes a JS array differently per driver, while
 * scalar text params serialize identically everywhere (see the bytea probe). */
export async function clearKeys(db: Db, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const list = sql.join(
    keys.map((k) => sql`${k}`),
    sql`, `,
  );
  await q(db, sql`DELETE FROM aa_auth_throttle WHERE key IN (${list})`);
}

/**
 * Fixed-window hourly send cap. Returns true while the window still has room,
 * false once the cap is hit (aa_auth_send_cap never sets locked_until). Uses
 * last_fail_at as the window START so a steady stream cannot extend the window.
 */
export async function sendCap(
  db: Db,
  key: string,
  limit: number,
  window: string,
): Promise<boolean> {
  const row = await q1<{ aa_auth_send_cap: boolean }>(
    db,
    sql`SELECT aa_auth_send_cap(${key}, ${limit}, ${window}) AS aa_auth_send_cap`,
  );
  return row?.aa_auth_send_cap ?? false;
}
