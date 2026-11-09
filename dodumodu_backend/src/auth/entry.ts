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
import { OTP_SENDS_PER_HOUR, OTP_SENDS_PER_HOUR_GLOBAL, OTP_SENDS_PER_HOUR_IP, SEND_CAP_WINDOW,
  FLOW_TTL_SECS, DENIED_ALERT_COOLDOWN_HOURS } from "./config";
import { normalizeEmail, randomToken } from "./crypto";
import { emailTag, pairKey, trustedPairKey, sendSlotKey, sendEmailKey, sendIpKey, tokenHashHex } from "./keys";
import { reserve, noteFuse, refund, sendCap } from "./throttle";
import { AuthLockedError, AuthServerFaultError } from "./errors";
import { issueChallenge, deriveChallengeCode } from "./challenge";
import { isBlocked, vidHashHex, ipBlockHashHex, type ActiveBlock } from "./blocks";
import { logInfo } from "./authLog";
import { swallow, swallowNull } from "../shared/logger";

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
  trusted = false,
): Promise<string> {
  const token = randomToken();
  const hashHex = await tokenHashHex(token);
  await q(db,
    sql`INSERT INTO aa_auth_flows
      (token_hash, email, user_id, stage, via, device_id, expires_at, ip_prefix, country, vid_hash, trusted)
      VALUES (decode(${hashHex}, 'hex'), ${email}, ${userId},
        'otp', 'email', NULL,
        now() + (${FLOW_TTL_SECS}::int * interval '1 second'),
        ${ctx.prefix}, ${ctx.country},
        ${vidHash === null ? sql`NULL::bytea` : sql`decode(${vidHash}, 'hex')`},
        ${trusted})`);
  return token;
}

export interface EntrySecrets { otpKey: Uint8Array; throttleKey: Uint8Array; }

export async function requestCode(
  db: Db, secrets: EntrySecrets, rawEmail: unknown, ctx: RequestCtx,
  deviceToken: string | null, vid: string | null = null,
  /** true for POST /auth/resend: keep the live code and honour the cooldown/max (same code re-sent). */
  resend = false,
  /** /auth/resend continues THIS flow's code: the slot its browser was given, even if the cookie was lost. */
  slotOverride: string | null = null,
): Promise<RequestOutcome> {
  const email = normalizeEmail(rawEmail);
  const probe = email ?? `unknown:${randomToken()}`;
  const tag = await emailTag(secrets.throttleKey, email ?? probe);
  const vidHash = vid ? await vidHashHex(secrets.throttleKey, vid) : null;
  const netHash = await ipBlockHashHex(secrets.throttleKey, ctx.ip);
  const deviceHashHex = deviceToken ? await tokenHashHex(deviceToken) : null;
  // One browser's identity for caps and challenges: its vid, or the network for a cookie-less client.
  const slot = slotOverride ?? (vidHash ? `v:${vidHash}` : `i:${netHash}`);
  // Who is this, in one round trip (also the early recognition used for the throttle tier below).
  const early: Resolved | null = email
    ? await resolveUser(db, email, deviceHashHex).catch(swallowNull("entry_lookup_failed"))
    : null;
  // A RECOGNIZED browser (its own __Host-did matches an active/pending device of this user) is the
  // trusted one. Nothing a stranger does from another network, browser or the same shared network may
  // lock it out: it skips network blocks and uses its own throttle/send buckets (below).
  const recognizedBrowser = deviceHashHex !== null && early !== null && early.is_active && early.recognized;
  // Block lookup first (indexed; a blocked client burns no counters): a live device block on the
  // __Host-vid, or an ip block on the network (which a recognized browser is exempt from). The response
  // is the same dummy-flow 202 as unknown (spec §4.5).
  const block: ActiveBlock | null =
    (vidHash ? await isBlocked(db, "device", vidHash) : null) ??
    (recognizedBrowser ? null : await isBlocked(db, "ip", netHash));
  if (block) {
    const flowToken = await createFlow(db, email ?? probe, null, ctx, vidHash);
    await logInfo(db, {
      event: "request", status: "blocked", reason: block.kind,
      meta: { block_ref: block.blockRef },
    });
    return { flowToken, sendCode: null, sendDeniedAlert: null, friction: false };
  }
  // An EXISTING user's email arriving from a NEW device (no matching __Host-did) reserves the pair key
  // at the STRICT tier - thr=3 / 15-min steps - instead of anon. Unknown emails stay anon; the pair
  // shape binds email+IP in both cases (R-NOLOCK-1). A recognized browser gets its OWN bucket.
  const earlyStrict = deviceHashHex === null && early !== null && early.is_active &&
    (early.has_totp || early.enroll_open) && !early.recognized;
  const key = recognizedBrowser && vidHash ? trustedPairKey(tag, vidHash) : pairKey(tag, ctx.ip);
  let reservation;
  try {
    reservation = await reserve(db, key, earlyStrict ? "strict" : "anon");
  } catch (e) {
    if (e instanceof AuthLockedError && email) await noteFuse(db, tag).catch(swallow("entry_best_effort_failed"));
    throw e;
  }
  try {
    const found = early ?? (email ? await resolveUser(db, email, deviceHashHex) : null);
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
    // A cookie-matched ACTIVE device is the trusted browser: it keeps default
    // throttling. No cookie / a cookie that matches nothing = a new browser:
    // allowed in, but strict (3rd failure device-blocks it until an admin lifts).
    const trusted = deviceHashHex !== null && found.recognized;
    // Send allowances. Per BROWSER first (a stranger's requests can never spend the real user's), then the
    // shared limits that exist to stop inbox flooding: a high all-browsers backstop and the per-network
    // cap. A trusted (recognized) browser is exempt from the shared ones.
    const slotCap = await sendCap(db, sendSlotKey(tag, slot), OTP_SENDS_PER_HOUR, SEND_CAP_WINDOW);
    const emailCap = trusted || await sendCap(db, sendEmailKey(tag), OTP_SENDS_PER_HOUR_GLOBAL, SEND_CAP_WINDOW);
    const ipCap = trusted || await sendCap(db, sendIpKey(tag, ctx.ip), OTP_SENDS_PER_HOUR_IP, SEND_CAP_WINDOW);
    if (!slotCap || !emailCap || !ipCap) {
      const flowToken = await createFlow(db, email!, found.user_id, ctx, vidHash, trusted);
      const friction = await noteFuse(db, tag).catch(() => false);
      return { flowToken, sendCode: null, sendDeniedAlert: null, friction };
    }
    const ch = await issueChallenge(db, found.user_id, secrets.otpKey, !resend, slot);
    const flowToken = await createFlow(db, email!, found.user_id, ctx, vidHash, trusted);
    if (!ch.sendNow) return { flowToken, sendCode: null, sendDeniedAlert: null, friction: false };
    const code = await deriveChallengeCode(secrets.otpKey, found.user_id, ch.nonceHex);
    return { flowToken, sendCode: { to: email!, code }, sendDeniedAlert: null, friction: false };
  } catch (e) {
    if (e instanceof AuthLockedError) throw e;
    await refund(db, reservation).catch(swallow("entry_best_effort_failed"));
    throw new AuthServerFaultError(e, {
      code: "AUTH_DATABASE_REQUEST_FAILED",
      stage: "authentication.request",
      category: "dependency",
    });
  }
}
