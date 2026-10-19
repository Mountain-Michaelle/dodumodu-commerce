// Auth-log writer (spec §4.7). One insert into aa_auth_log. Bytea columns
// (email_tag/ip_hash/device_id_hash) are bound as HEX and decoded in SQL — the
// codebase rule: crypto returns bytes, toHex() at the edge, decode($n,'hex') in
// SQL (see crypto.ts). ip_enc is the encrypted-IP blob (admins only).
//
// writeAuthLog is SYNCHRONOUS and returns the new row id: security-critical
// events call it inside the same transaction as the state change and let a
// failure roll that change back. logInfo is the fire-and-forget variant for
// informational events, whose loss is explicitly acceptable and must never fail
// a login.
import { q1, sql } from "./sql";
import type { Db } from "../db";

export type LogStatus = "success" | "fail" | "blocked" | "locked" | "rate_limited" | "info";

export interface AuthLogEntry {
  event: string;
  status: LogStatus;
  userId?: string | null;
  emailTagHex?: string | null;   // HMAC of the email, hex
  usernameAttempted?: string | null; // truncated, escaped only at display
  ipHashHex?: string | null;      // HMAC of the IP, hex
  ipEnc?: string | null;          // encrypted IP blob (admins only)
  ua?: string | null;
  deviceLabel?: string | null;
  deviceIdHashHex?: string | null;
  flowId?: string | null;
  stage?: string | null;
  reason?: string | null;
  meta?: Record<string, unknown> | null;
}

/** bytea from hex, or NULL. Never binds a raw byte array across the driver. */
const b = (hex: string | null | undefined) =>
  hex ? sql`decode(${hex}, 'hex')` : sql`NULL::bytea`;

export async function writeAuthLog(db: Db, e: AuthLogEntry): Promise<number> {
  const row = await q1<{ id: number }>(db,
    sql`INSERT INTO aa_auth_log
          (event, status, user_id, email_tag, username_attempted, ip_hash, ip_enc,
           ua, device_label, device_id_hash, flow_id, stage, reason, meta)
        VALUES (
          ${e.event}, ${e.status},
          ${e.userId ?? null}::uuid, ${b(e.emailTagHex)}, ${e.usernameAttempted ?? null},
          ${b(e.ipHashHex)}, ${e.ipEnc ?? null},
          ${e.ua ?? null}, ${e.deviceLabel ?? null}, ${b(e.deviceIdHashHex)},
          ${e.flowId ?? null}::uuid, ${e.stage ?? null}, ${e.reason ?? null},
          ${e.meta ? sql`${JSON.stringify(e.meta)}::jsonb` : sql`NULL::jsonb`})
        RETURNING id`);
  if (!row) throw new Error("auth log insert returned no row");
  return row.id;
}

/** Fire-and-forget informational log. A failure here NEVER fails the caller. */
export async function logInfo(db: Db, e: AuthLogEntry): Promise<void> {
  try {
    await writeAuthLog(db, { ...e, status: e.status === "info" ? "info" : e.status });
  } catch {
    /* informational logging loss is acceptable and must be invisible */
  }
}
