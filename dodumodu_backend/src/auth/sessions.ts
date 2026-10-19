// Session finish (staff) + shared session types — Appendices C/F4.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { SESSION_ABSOLUTE_SECS } from "./config";
import { randomToken } from "./crypto";
import { tokenHashHex } from "./keys";
import { AuthRejectError } from "./errors";
import { loadFlow } from "./flows";

export type Tier = "normal" | "strict";

/** Tier from the device row already returned (adds no query, spec §5.3). */
export function tierFor(
  deviceLastPrefix: string | null, deviceLastCountry: string | null,
  prefix: string, country: string | null, hasDevice: boolean,
): Tier {
  if (!hasDevice) return "normal";
  if (deviceLastPrefix === null) return "normal";
  if (deviceLastPrefix !== prefix) return "strict";
  if ((deviceLastCountry ?? null) !== (country ?? null)) return "strict";
  return "normal";
}

export interface FinishedSession {
  sessionToken: string;
  deviceToken: string | null; // set only on the first admin login (claim won)
}

export interface FinishArgs {
  flowToken: string; ip: string; ua: string;
  prefix: string; country: string | null; tier: Tier;
  /** Browser __Host-did presented at finish (hash matched server-side). Lets an
   * email-path flow bind its existing active device when the one-time
   * first-device claim window is already consumed (Appendix F4 exception). */
  deviceToken?: string | null;
}

/** POST /auth/session for staff (role <> 'admin'). Flow must be ready.
 * Slice 5: 'ready' is only reachable through a proven TOTP (no stage-machine
 * shortcut survives), and the INSERT below hard-requires an enrolled
 * authenticator so no future slip can issue a session without one. */
export async function finishStaffSession(db: Db, a: FinishArgs): Promise<FinishedSession> {
  const flow = await loadFlow(db, a.flowToken);
  if (!flow || flow.stage !== "ready" || flow.user_id === null) {
    throw new AuthRejectError("flow");
  }
  const token = randomToken();
  const hashHex = await tokenHashHex(token);
  const row = await q1<{ user_id: string }>(db,
    sql`WITH f AS (
       UPDATE aa_auth_flows SET stage = 'done'
        WHERE id = ${flow.id} AND stage = 'ready' AND via <> 'resume' AND expires_at > now()
       RETURNING user_id, via)
      INSERT INTO aa_sessions
        (id_hash, user_id, session_version, absolute_expires_at, ip, ua,
         login_via, ip_prefix, country, tier)
      SELECT decode(${hashHex}, 'hex'), f.user_id, u.session_version,
        now() + (${SESSION_ABSOLUTE_SECS}::int * interval '1 second'),
        ${a.ip}, left(${a.ua}, 120), f.via, ${a.prefix}, ${a.country}, 'normal'
       FROM f JOIN aa_users u ON u.id = f.user_id AND u.is_active AND u.role <> 'admin'
         AND u.totp_enabled_at IS NOT NULL
      RETURNING user_id::text AS user_id`);
  if (!row) throw new AuthRejectError("flow");
  return { sessionToken: token, deviceToken: null };
}