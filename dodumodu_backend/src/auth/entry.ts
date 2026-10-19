// Entry routing — spec §5.1. POST /auth/request {email} always looks the same
// on the wire (202 + flow cookie), but internally there are two cases:
//   REAL    known + active + (enrolled TOTP or open enrollment window) ->
//           challenge + email code, in ANY browser. A new/unrecognized device
//           only faces STRICT-tier throttling on the pair key (thr=3, 15-min
//           steps) — the flow itself is never denied for device reasons.
//   DUMMY   unknown or inactive email, or no TOTP and no open window ->
//           dummy flow, no email (a rate-limited alert may go to an admin
//           whose account cannot log in anyway).
// Admin device/IP blocks still silence (same dummy 202, §4.5).
// Unknown, inactive and unable-to-log-in get identical responses, counters and
// (best-effort) timing: no registration endpoint exists (spec §4).
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { OTP_SENDS_PER_HOUR, OTP_SENDS_PER_HOUR_IP, SEND_CAP_WINDOW,
  FLOW_TTL_SECS, DENIED_ALERT_COOLDOWN_HOURS } from "./config";
import { normalizeEmail, randomToken } from "./crypto";
import { emailTag, pairKey, sendEmailKey, sendIpKey, tokenHashHex } from "./keys";
import { reserve, noteFuse, refund, sendCap } from "./throttle";
import { AuthLockedError, AuthServerFaultError } from "./errors";
import { issueChallenge, deriveChallengeCode } from "./challenge";
import { isBlocked, vidHashHex, ipBlockHashHex, type ActiveBlock } from "./blocks";
import { logInfo } from "./authLog";

export interface RequestCtx {
  ip: string; prefix: string; country: string | null; ua: string;
}

export interface RequestOutcome {
  flowToken: string;
  sendCode: { to: string; code: string } | null;
  sendDeniedAlert: { to: string } | null;
  friction: boolean;
}

interface Resolved {
  user_id: string; role: string; is_active: boolean; window_open: boolean;
  has_totp: boolean; enroll_open: boolean;
  device_id: string | null;
  device_status: string | null; last_ip_prefix: string | null; last_country: string | null;
  recognized: boolean;
}

/** One round trip for entry routing and tier (Appendix F3 DEVICE_RESOLVE). */
async function resolveUser(
  db: Db, email: string, deviceHashHex: string | null,
): Promise<Resolved | null> {
  return q1<Resolved>(db,
    sql`SELECT u.id::text AS user_id, u.role, u.is_active,
      COALESCE(u.device_window_until > now(), false) AS window_open,
      (u.totp_enabled_at IS NOT NULL) AS has_totp,
      COALESCE(u.enroll_window_until > now(), false) AS enroll_open,
      d.id::text AS device_id, d.status AS device_status,
      d.last_ip_prefix, d.last_country,
      (d.id IS NOT NULL) AS recognized
      FROM aa_users u LEFT JOIN aa_admin_devices d
        ON d.user_id = u.id AND d.status IN ('active', 'pending')
       AND d.expires_at > now()
       AND (d.status = 'active' OR d.pending_until > now())
       AND ${deviceHashHex === null ? sql`TRUE` : sql`d.token_hash = decode(${deviceHashHex}, 'hex')`}
       AND TRUE
     WHERE u.email = ${email}`);
}

/** Server-side flow row. Dummy flows carry user_id NULL. */
async function createFlow(
  db: Db, email: string, userId: string | null, ctx: RequestCtx,
  vidHash: string | null,
): Promise<string> {
  const token = randomToken();
  const hashHex = await tokenHashHex(token);
  await q(db,
    sql`INSERT INTO aa_auth_flows
      (token_hash, email, user_id, stage, via, device_id, expires_at, ip_prefix, country, vid_hash)
      VALUES (decode(${hashHex}, 'hex'), ${email}, ${userId},
        'otp', 'email', NULL,
        now() + (${FLOW_TTL_SECS}::int * interval '1 second'),
        ${ctx.prefix}, ${ctx.country},
        ${vidHash === null ? sql`NULL::bytea` : sql`decode(${vidHash}, 'hex')`})`);
  return token;
}

export interface EntrySecrets { otpKey: Uint8Array; throttleKey: Uint8Array; }

export async function requestCode(
  db: Db, secrets: EntrySecrets, rawEmail: unknown, ctx: RequestCtx,
  deviceToken: string | null, vid: string | null = null,
): Promise<RequestOutcome> {
  const email = normalizeEmail(rawEmail);
  const probe = email ?? `unknown:${randomToken()}`;
  const tag = await emailTag(secrets.throttleKey, email ?? probe);
  const key = pairKey(tag, ctx.ip);
  // Block lookup first (indexed; a blocked client burns no counters): a live
  // device block on the __Host-vid or ip block on the network. The response is
  // the same dummy-flow 202 as unknown (spec §4.5).
  const vidHash = vid ? await vidHashHex(secrets.throttleKey, vid) : null;
  const netHash = await ipBlockHashHex(secrets.throttleKey, ctx.ip);
  const block: ActiveBlock | null =
    (vidHash ? await isBlocked(db, "device", vidHash) : null) ??
    (await isBlocked(db, "ip", netHash));
  if (block) {
    const flowToken = await createFlow(db, email ?? probe, null, ctx, vidHash);
    await logInfo(db, {
      event: "request", status: "blocked", reason: block.kind,
      meta: { block_ref: block.blockRef },
    });
    return { flowToken, sendCode: null, sendDeniedAlert: null, friction: false };
  }
  // Early recognition: an EXISTING user's email arriving from a NEW device
  // (no matching __Host-did) reserves the pair key at the STRICT tier —
  // thr=3 / 15-min steps — instead of anon. Unknown emails stay anon; the
  // pair shape binds email+IP in both cases (R-NOLOCK-1).
  const deviceHashHex = deviceToken ? await tokenHashHex(deviceToken) : null;
  let early: Resolved | null = null;
  let earlyStrict = false;
  if (email && deviceHashHex === null) {
    early = await resolveUser(db, email, null).catch(() => null);
    earlyStrict = early !== null && early.is_active &&
      (early.has_totp || early.enroll_open) && !early.recognized;
  }
  let reservation;
  try {
    reservation = await reserve(db, key, earlyStrict ? "strict" : "anon");
  } catch (e) {
    if (e instanceof AuthLockedError && email) await noteFuse(db, tag).catch(() => {});
    throw e;
  }
  try {
    // Reuse the early recognition when the caller sent no device cookie;
    // otherwise resolve with the cookie (cookie-match = recognized).
    const found = early !== null || deviceHashHex === null
      ? early ?? (email ? await resolveUser(db, email, null) : null)
      : email ? await resolveUser(db, email, deviceHashHex) : null;
    // REAL requires an enrolled authenticator OR an open enrollment window: a
    // user with neither cannot complete any v2 login (spec §5.1/M9), so they
    // take the identical dummy path — no email, no oracle.
    // Device recognition NEVER gates the flow: existing users get a real flow
    // in ANY browser. Unrecognized devices only face harsher (strict-tier)
    // throttling (see the early reserve above). Only admin blocks silence.
    const enrollOk = found !== null && (found.has_totp || found.enroll_open);
    const real = found !== null && found.is_active && enrollOk;
    if (!real) {
      const flowToken = await createFlow(db, email ?? probe, null, ctx, vidHash);
      let sendDeniedAlert: { to: string } | null = null;
      // Denied alert: an active admin whose account cannot log in anyway (no
      // TOTP and no open window) still gets a rate-limited notice (max 1/6h)
      // so a real admin learns someone probed their address. Merely-new
      // devices get the OTP (real flow above) — no alert.
      if (found !== null && found.is_active && found.role === "admin" && !enrollOk && email) {
        const allowed = await sendCap(db, `denied:${tag}`, 1, `${DENIED_ALERT_COOLDOWN_HOURS} hours`);
        if (allowed) sendDeniedAlert = { to: email };
      }
      return { flowToken, sendCode: null, sendDeniedAlert, friction: false };
    }
    const emailCap = await sendCap(db, sendEmailKey(tag), OTP_SENDS_PER_HOUR, SEND_CAP_WINDOW);
    const ipCap = await sendCap(db, sendIpKey(tag, ctx.ip), OTP_SENDS_PER_HOUR_IP, SEND_CAP_WINDOW);
    if (!emailCap || !ipCap) {
      const flowToken = await createFlow(db, email!, found.user_id, ctx, vidHash);
      const friction = await noteFuse(db, tag).catch(() => false);
      return { flowToken, sendCode: null, sendDeniedAlert: null, friction };
    }
    const ch = await issueChallenge(db, found.user_id, secrets.otpKey, true);
    const flowToken = await createFlow(db, email!, found.user_id, ctx, vidHash);
    if (!ch.sendNow) return { flowToken, sendCode: null, sendDeniedAlert: null, friction: false };
    const code = await deriveChallengeCode(secrets.otpKey, found.user_id, ch.nonceHex);
    return { flowToken, sendCode: { to: email!, code }, sendDeniedAlert: null, friction: false };
  } catch (e) {
    if (e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(() => {});
    throw new AuthServerFaultError(e);
  }
}
