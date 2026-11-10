// ===== FILE: <your-auth-dir>/routes.ts =====
// Auth v2 HTTP surface — spec §5.7. Mounted at AUTH_BASE (/auth) and
// ADMIN_BASE (/admin). Every route is behind flagGate (404 when off) and
// originGuard for unsafe methods. Errors map to neutral 401 / 429 {retry_after}
// / 503 {retry:true} / 403 so real, unknown and denied look identical.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../db";
import { AuthRejectError, AuthLockedError, AuthServerFaultError,
  AuthUnauthorizedError, AuthForbiddenError, AuthRecoverableError } from "./errors";
import type { AuthEnv } from "./middleware";
import { flagGate, originGuard, authInit, guard,
  requireSession, requireAdmin, requireStepUp, securityHeaders } from "./middleware";
import { loadAuthSecrets } from "./secrets";
import { INVITE_CREATE_PER_HOUR, INVITE_ACCEPT_PER_HOUR_IP, SEND_CAP_WINDOW } from "./config";
import { listSessionsAdmin, listDevicesAdmin, revokeSessionOfUser, deviceBelongsTo, UUID_RE } from "./admin-lists";
import { inviteLink, PUBLIC_ORIGIN_HEADER } from "./public-origin";
import { FLOW_TTL_SECS, FLOW_STEP_RESUME_SECS, DEVICE_TTL_SECS, SESSION_ABSOLUTE_SECS, VID_TTL_SECS, isV2Perm } from "./config";

/** Mask an email for the status endpoint (o***@e*** shape). Never leaks full address. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dl = local.length <= 1 ? local : local[0] + "***";
  const at2 = domain.indexOf(".");
  const dom = at2 <= 0 ? domain[0] + "***" : domain[0] + "***" + domain.slice(at2);
  return `${dl}@${dom}`;
}
import { requestCode } from "./entry";
import { verifyCode } from "./factors";
import { totpEnrollStart, totpEnrollConfirm, genBackupCodes, ackBackupCodes, reissueBackupCodes,
  normalizeBackupCode, normalizeTotpCode } from "./totp";
import { verifyTotp } from "./totp-verify";
import { requestLostEmail } from "./lost-email";
import { recoverWithBackup } from "./recovery";
import { finishStaffSession } from "./sessions";
import { finishAdminSession } from "./sessions-admin";
import { deviceStart } from "./devices";
import { createDeviceInvite, acceptDeviceInvite, revokeDevice, listDevices } from "./device-invites";
import { listUsers, getUserDetail, registryPayload, listAuthLog, listBlocksAdmin,
  listAccountRequests, resolveAccountRequest, listNotifications } from "./admin-reads";
import { notificationService } from "../services/notificationService";
import { liftBlock } from "./blocks";
import { grantStepup, listSessions,
  revokeSession, revokeOtherSessions, revokeAllSessions, createUser, grantPerm, revokePerm, patchUser,
  deactivateUser, adminResetTotp, forceLogout, regenerateBackupCodes, replaceGrants, setPrimaryUser } from "./admin-ops";
import { tokenHashHex, emailTag } from "./keys";
import { ipBlockHashHex } from "./blocks";
import { q, q1, sql } from "./sql";
import { reserve, noteFuse, refund, clearKeys, sendCap } from "./throttle";
import { sha256, toHex, decryptSecret, totpMatch, randomToken } from "./crypto";
import { providerForEnv, sendLoginCode, sendInBackground, testMailbox, fromForEnv } from "./email";
import { authCorrelationId, authFailureDiagnostic, logAuthFailure } from "./diagnostics";
import { setFlowCookie, setSidCookie, setDidCookie, setVidCookie, clearSidCookie, clearFlowCookie,
  getFlowToken, afterResponse } from "./ctx";
import { loadFlow } from "./flows";
import { orderV2Routes } from "../routes/admin/ordersV2";
import { recordLoginSuccess, recordRateLimited, recordUserCreated, type EventCtx } from "./security-events";
import { swallow, swallowNull, logError, logWarn } from "../shared/logger";

type AppEnv = { Bindings: AuthEnv };

const NEUTRAL_401 = { error: "Invalid or expired code" };

/** Map a thrown auth error to the neutral wire response. */
function mapError(c: Context<AppEnv>, e: unknown): Response {
  if (e instanceof AuthLockedError) {
    return c.json({ error: "Too many attempts", retry_after: e.retryAfterSecs }, 429);
  }
  if (e instanceof AuthServerFaultError) {
    const correlationId = authCorrelationId();
    logAuthFailure(authFailureDiagnostic(c, e, correlationId));
    c.header("X-Correlation-ID", correlationId);
    return c.json({ error: "Something went wrong", retry: true, error_id: correlationId }, 503);
  }
  if (e instanceof AuthForbiddenError) return c.json({ error: e.message }, 403);
  if (e instanceof AuthUnauthorizedError) return c.json({ error: e.message }, 401);
  if (e instanceof AuthRecoverableError) {
    // Uniform "invalid" body; the ONLY extra field is recovery_available, a
    // property of the caller's own flow counter — not an account-enumeration
    // oracle. The UI reveals the recovery link on this; the server still gates.
    return c.json({ error: "Invalid code", recovery_available: true }, 401);
  }
  if (e instanceof AuthRejectError) return c.json(NEUTRAL_401, 401);
  const correlationId = authCorrelationId();
  logAuthFailure(authFailureDiagnostic(c, { code: "AUTH_UNEXPECTED", stage: "handler", cause: e }, correlationId));
  c.header("X-Correlation-ID", correlationId);
  return c.json({ error: "Something went wrong", error_id: correlationId }, 500);
}

async function guarded(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthLockedError) await afterResponse(c, notifyRateLimited(c));
    // The client only ever sees the neutral 401; the server log says WHY (reason is an audit
    // code, never user data), so "Invalid or expired code" is diagnosable in Workers Logs.
    if (e instanceof AuthRejectError) {
      let path = "";
      try { path = new URL(c.req.url).pathname; } catch { /* log without it */ }
      logWarn("auth_rejected", { path, reason: e.reason, ray: c.req.header("cf-ray") ?? null });
    }
    return mapError(c, e);
  }
}

/** Request facts the security notifications need (device id + IP + keys). */
function eventCtx(c: Context<AppEnv>): EventCtx {
  const s = authInit(c);
  return {
    ip: s.ctx.ip, ua: s.ctx.ua, country: s.ctx.country, vid: s.vidToken,
    throttleKey: loadAuthSecrets(c.env).throttleKey,
  };
}

/** A 429 on a sign-in path: tell the admin, but only when the email is a real account. */
async function notifyRateLimited(c: Context<AppEnv>): Promise<void> {
  try {
    const s = authInit(c);
    let email: string | null = null;
    const flowToken = getFlowToken(c as never);
    if (flowToken) email = (await loadFlow(s.db, flowToken))?.email ?? null;
    if (!email) {
      const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
      email = typeof body.email === "string" ? body.email : null;
    }
    await recordRateLimited(s.db, eventCtx(c), email);
  } catch (e) {
    logError("rate_limit_notification_failed", e);   // observing a 429 must never change the 429
  }
}

const secretsOf = (c: Context<AppEnv>) => loadAuthSecrets(c.env);
/** Origin the platform reported for THIS request (the dispatcher sets it after stripping any client copy). */
const requestOrigin = (c: Context<AppEnv>) => c.req.header(PUBLIC_ORIGIN_HEADER) ?? new URL(c.req.url).origin;
/** Invite link on the trusted origin + admin base path; a misconfigured origin is a server fault, never a bad link. */
function inviteUrl(c: Context<AppEnv>, token: string): string {
  const url = inviteLink(c.env as never, requestOrigin(c), token);
  if (!url) throw new AuthServerFaultError(undefined, { code: "INVITE_ORIGIN", stage: "invite", category: "configuration" });
  return url;
}
/** Network key for rate limits: a keyed hash, never the raw address. */
async function ipKeyOf(c: Context<AppEnv>): Promise<string> {
  const s = authInit(c);
  return ipBlockHashHex(loadAuthSecrets(c.env).throttleKey, s.ctx.ip);
}
/** Cap invite actions per hour. Over the cap = 429, nothing else changes. */
async function inviteCap(db: Db, key: string, limit: number): Promise<void> {
  if (!(await sendCap(db, key, limit, SEND_CAP_WINDOW))) throw new AuthLockedError(3600);
}
const json = async <T>(c: Context<AppEnv>): Promise<Partial<T>> =>
  (await c.req.json().catch(() => ({}))) as Partial<T>;

/** Get the __Host-vid, minting + setting it when absent (flow creation). */
function ensureVid(c: Context<AppEnv>, s: { vidToken: string | null }): string {
  if (s.vidToken) return s.vidToken;
  const vid = randomToken();
  setVidCookie(c as never, vid, VID_TTL_SECS);
  return vid;
}

/** Email on a flow (for the otpauth label). Rejects if the flow is unknown. */
async function flowEmail(db: Db, flowToken: string): Promise<string> {
  const f = await loadFlow(db, flowToken);
  if (!f || f.user_id === null) throw new AuthRejectError("flow");
  return f.email;
}

/** Stage + via for a flow (to decide the strict-device backup-code refusal). */
async function flowStage(db: Db, flowToken: string): Promise<{ stage: string; via: string; strict: boolean }> {
  const row = await q1<{ stage: string; via: string; ip_prefix: string | null }>(db,
    sql`SELECT stage, via, ip_prefix FROM aa_auth_flows
      WHERE token_hash = decode(${await tokenHashHex(flowToken)}, 'hex') AND expires_at > now()`);
  if (!row) throw new AuthRejectError("flow");
  return { stage: row.stage, via: row.via, strict: row.ip_prefix !== null };
}

/** Resolve a user by uuid id or email (admin-user routes). */
async function resolveUser(db: Db, idOrEmail: string): Promise<{ id: string; role: string } | null> {
  return q1<{ id: string; role: string }>(db,
    sql`SELECT id::text AS id, role FROM aa_users
      WHERE id::text = ${idOrEmail} OR (email = ${idOrEmail} AND is_active)`);
}

export const authRoute = new Hono<AppEnv>();
export const adminRoute = new Hono<AppEnv>();

// Order: flag, then origin/content-type guard for unsafe methods, then headers.
authRoute.use("*", flagGate);
authRoute.use("*", originGuard);
authRoute.use("*", securityHeaders);
adminRoute.use("*", flagGate);
adminRoute.use("*", originGuard);
adminRoute.use("*", securityHeaders);

// GET /auth/device/available -> does THIS browser hold an active device for
// some admin? Used by the UI to show "Use this trusted device". Never leaks
// whether a specific email has a device: it only reads the caller's own cookie.
authRoute.get("/device/available", async (c) => {
  const s = authInit(c);
  if (!s.deviceToken) return c.json({ available: false });
  const h = await tokenHashHex(s.deviceToken);
  const row = await q1<{ ok: number }>(s.db,
    sql`SELECT 1 AS ok FROM aa_admin_devices d JOIN aa_users u ON u.id = d.user_id
      WHERE d.token_hash = decode(${h}, 'hex') AND d.status = 'active'
        AND d.expires_at > now() AND u.role = 'admin' AND u.is_active`);
  return c.json({ available: !!row });
});

// GET /auth/status -> where is this browser's in-progress flow? Lets the UI
// resume the current stage after a refresh (FLOW_STEP_RESUME_SECS window, 3 min). Never leaks
// the full email (masked only) or user_id; 404 = start at email.
authRoute.get("/status", async (c) => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) return c.json({ error: "Not found" }, 404);
  const row = await q1<{ stage: string; email: string; via: string; ip_prefix: string | null; left: number }>(s.db,
    sql`SELECT stage, email, via, ip_prefix,
             GREATEST(0, floor(extract(epoch FROM (last_step_at + (${FLOW_STEP_RESUME_SECS}::int * interval '1 second') - now()))))::int AS left
        FROM aa_auth_flows
      WHERE token_hash = decode(${await tokenHashHex(token)}, 'hex')
        AND expires_at > now()
        AND user_id IS NOT NULL
        AND last_step_at > now() - (${FLOW_STEP_RESUME_SECS}::int * interval '1 second')
        AND stage NOT IN ('done', 'dead')`);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({
    stage: row.stage,
    email_masked: maskEmail(row.email),
    strict: row.via === "device" && row.ip_prefix !== null,
    expires_in: row.left,   // seconds of resume window left; the UI shows it, the server enforces it
  });
});

// GET /auth/test/mailbox/:email -> last captured email for a recipient.
// EXISTS ONLY when ALLOW_TEST_IP=1 (a .dev.vars-only var). Returns 404 otherwise,
// so it is unreachable in any deployed config. Used by Playwright + attack tests
// to read the emailed code without a real Resend call.
authRoute.get("/test/mailbox/:email", (c) => {
  if ((c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP !== "1") {
    return c.json({ error: "Not found" }, 404);
  }
  const email = decodeURIComponent(c.req.param("email") ?? "").toLowerCase();
  const mail = testMailbox.get(email);
  if (!mail) return c.json({ error: "Not found" }, 404);
  // The test extracts the code from text; we return the raw body only here.
  return c.json({ to: email, subject: mail.subject, text: mail.text, at: mail.at });
});

// POST /auth/request {email} -> always 202 + flow cookie.
// For REAL users (sendCode set) we await the send so a genuine provider
// failure is surfaced to the caller instead of pretending the code left.
// For dummy/capped flows (sendCode null) we return 202 silently to avoid
// account enumeration.
authRoute.post("/request", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { email } = await json<{ email?: string }>(c);
  const secrets = secretsOf(c);
  const out = await requestCode(s.db, secrets, email, s.ctx, s.deviceToken, ensureVid(c, s));
  if (out.sendCode) {
    const { to, code } = out.sendCode;
    const provider = providerForEnv(secrets.resendApiKey, (c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP, fromForEnv(c.env));
    const ok = await sendLoginCode(provider, to, code, `login-code:${out.flowToken}:1`);
    if (!ok) {
      throw new AuthServerFaultError(new Error("email provider rejected delivery"), {
        code: "AUTH_EMAIL_DELIVERY_FAILED",
        stage: "email.delivery",
        category: "dependency",
      });
    }
  }
  if (out.sendDeniedAlert) {
    const provider = providerForEnv(secrets.resendApiKey, (c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP, fromForEnv(c.env));
    sendInBackground(c as never, provider, out.sendDeniedAlert.to,
      "Sign-in attempt on an unrecognized device",
      "Someone just tried to sign in to your admin account from a device we do not recognize. " +
        "No code was sent. If this wasn't you, no action is needed.",
      `denied:${out.sendDeniedAlert.to}`);
  }
  setFlowCookie(c as never, out.flowToken, FLOW_TTL_SECS);
  return c.json({ ok: true }, 202);
}));

// POST /auth/resend -> same 202, cooldown and caps (reuses the same code).
authRoute.post("/resend", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const f = await loadFlow(s.db, token);
  if (!f || f.user_id === null) throw new AuthRejectError("flow");
  const secrets = secretsOf(c);
  const out = await requestCode(s.db, secrets, f.email, s.ctx, s.deviceToken, ensureVid(c, s), true,
    f.vid_hash ? `v:${f.vid_hash}` : null);
  if (out.sendCode) {
    const { to, code } = out.sendCode;
    const provider = providerForEnv(secrets.resendApiKey, (c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP, fromForEnv(c.env));
    const ok = await sendLoginCode(provider, to, code, `login-code:${out.flowToken}:1`);
    if (!ok) {
      throw new AuthServerFaultError(new Error("email provider rejected delivery"), {
        code: "AUTH_EMAIL_DELIVERY_FAILED",
        stage: "email.delivery",
        category: "dependency",
      });
    }
  }
  setFlowCookie(c as never, out.flowToken, FLOW_TTL_SECS);
  return c.json({ ok: true }, 202);
}));

// POST /auth/code {code} -> next stage. (10-char emailed code ONLY; an
// authenticator code sent here is rejected by design.)
authRoute.post("/code", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { code } = await json<{ code?: string }>(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  if (typeof code !== "string" || code.length !== 10) throw new AuthRejectError("code");
  const out = await verifyCode(s.db, secretsOf(c), token, code, s.ctx.ip);
  return c.json({ next: out.next });
}));

// POST /auth/device/start {email} + __Host-did -> always 202 + flow cookie.
// Returns the flow's REAL stage as `next` so the UI never has to guess (the
// device path starts at the authenticator step, not the emailed-code step).
// flowStage ignores user_id, so real and dummy flows answer identically.
authRoute.post("/device/start", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { email } = await json<{ email?: string }>(c);
  const out = await deviceStart(s.db, secretsOf(c).throttleKey, email ?? "",
    s.deviceToken, s.ctx.ip, s.ctx.prefix, s.ctx.country, s.ctx.ua, ensureVid(c, s));
  setFlowCookie(c as never, out.flowToken, FLOW_TTL_SECS);
  const next = await flowStage(s.db, out.flowToken).then((f) => f.stage).catch(() => "totp");
  return c.json({ ok: true, tier: out.tier, next }, 202);
}));

// POST /auth/backup-codes/ack: codes were shown once at generation; this is
// required before a session exists (stage machine gates).
authRoute.post("/backup-codes/ack", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const out = await ackBackupCodes(s.db, token);
  return c.json({ next: out.next });
}));

// POST /auth/backup-codes/reissue: a reload on the backup-codes step lost the shown-once
// codes, so issue a fresh set bound to this flow (the unacknowledged set is revoked).
authRoute.post("/backup-codes/reissue", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const out = await reissueBackupCodes(s.db, token);
  return c.json({ backup_codes: out.codes });
}));

// POST /auth/lost-email {username} -> ALWAYS 202 {ok:true} (uniform for
// registered/unknown/malformed; §4.6 Option A). Registered handles enqueue an
// account request for admin review + at most one capped alert per cooldown.
authRoute.post("/lost-email", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { username } = await json<{ username?: string }>(c);
  const secrets = secretsOf(c);
  const out = await requestLostEmail(s.db, secrets.throttleKey, username, s.ctx.ip);
  if (out.alertTo) {
    const provider = providerForEnv(secrets.resendApiKey, (c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP, fromForEnv(c.env));
    sendInBackground(c as never, provider, out.alertTo,
      "Account recovery request",
      "Someone asked for help recovering access to your account. " +
        "If this was you, our team will contact you using the details we have on file. " +
        "If this wasn't you, no action is needed.",
      `lost:${out.alertTo}`);
  }
  return c.json({ ok: true }, 202);
}));

// POST /auth/totp/enroll/start -> {secret, otpauth_uri, expires_in}.
// May be called again while the flow is alive: the unconfirmed secret is
// replaced, so the previous QR/key stops working.
authRoute.post("/totp/enroll/start", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const email = await flowEmail(s.db, token);
  const out = await totpEnrollStart(s.db, secretsOf(c), token, email);
  return c.json({ secret: out.secret, otpauth_uri: out.otpauthUri, expires_in: out.expiresIn });
}));

authRoute.post("/totp", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { code, backup_code } = await json<{ code?: string; backup_code?: string }>(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const st = await flowStage(s.db, token);
  if (st.stage === "totp_enroll") {
    const out = await totpEnrollConfirm(s.db, secretsOf(c), token, code ?? "", s.ctx.ip);
    return c.json({ next: out.next, backup_codes: out.backupCodes });
  }
  // stage totp: backup codes are refused on the strict device path (spec §5.3 effect 2).
  const allowBackup = !(st.via === "device" && st.strict);
  const out = await verifyTotp(s.db, secretsOf(c), token,
    { code, backupCode: backup_code }, s.ctx.ip, allowBackup);
  return c.json({ next: out.next, remaining: out.remaining, used_backup: out.usedBackup });
}));

// POST /auth/session -> sets __Host-sid (+ __Host-did on first admin login).
// Passes any presented __Host-did so an EMAIL-path finish can hash-match its
// existing active device when the one-time claim window is already spent.
authRoute.post("/session", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const flow = await loadFlow(s.db, token);
  if (!flow || flow.stage !== "ready" || flow.user_id === null) throw new AuthRejectError("flow");
  const u = await q1<{ role: string; email: string }>(s.db, sql`SELECT role, email FROM aa_users WHERE id = ${flow.user_id}`);
  if (!u) throw new AuthRejectError("flow");
  const args = { flowToken: token, ...s.ctx, tier: "normal" as const, deviceToken: s.deviceToken };
  const fin = u.role === "admin"
    ? await finishAdminSession(s.db, args)
    : await finishStaffSession(s.db, args);
  setSidCookie(c as never, fin.sessionToken, SESSION_ABSOLUTE_SECS);
  if (fin.deviceToken) setDidCookie(c as never, fin.deviceToken, DEVICE_TTL_SECS);
  clearFlowCookie(c as never);
  await afterResponse(c, (async () => recordLoginSuccess(s.db, eventCtx(c),
    { id: flow.user_id!, email: u.email, role: u.role }))());
  return c.json({ ok: true });
}));

// Recovery: backup code resets TOTP inside the flow (spec §4.4). Gate:
// stage 'totp' + recovery_unlocked (3 TOTP fails). Same shape as /auth/totp
// on success ({next}), attempts-left on wrong codes, 403+blocked on the 3rd.
authRoute.post("/recovery/backup-code", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { code } = await json<{ code?: string }>(c);
  const token = getFlowToken(c as never);
  if (!token || typeof code !== "string") throw new AuthRejectError("flow");
  const out = await recoverWithBackup(s.db, secretsOf(c), token, code, s.ctx.ip);
  if ("next" in out && out.next) return c.json({ next: out.next });
  const g = out as { attemptsLeft?: number; blocked?: boolean };
  if (g.blocked) throw new AuthForbiddenError("No attempts left");
  return c.json({ ok: false, attempts_left: g.attemptsLeft ?? 0 }, 401);
}));

// POST /auth/stepup {code} or {backup_code} -> opens a fresh step-up window.
// Session-based (not flow-based): verifies the admin's TOTP or a backup code
// against the enrolled secret, then grants the window on THIS session.
authRoute.post("/stepup", async (c) => guarded(c, async () => {
  const sess = await requireAdmin(c);
  const s = authInit(c);
  const { code, backup_code } = await json<{ code?: string; backup_code?: string }>(c);
  const secrets = secretsOf(c);
  const tag = await emailTag(secrets.throttleKey, sess.email);
  const key = `totp:${tag}:${s.ctx.ip}`;
  const reservation = await reserve(s.db, key, "anon");
  try {
    const hashHex = await tokenHashHex(s.sessionToken!);
    if (backup_code !== undefined) {
      const bh = toHex(await sha256(normalizeBackupCode(String(backup_code))));
      const row = await q1<{ user_id: string }>(s.db,
        sql`UPDATE aa_backup_codes bc SET used_at = now()
          FROM aa_backup_code_sets s
          WHERE bc.set_id = s.id AND s.user_id = ${sess.userId}
            AND s.acked_at IS NOT NULL AND s.revoked_at IS NULL
            AND bc.code_hash = decode(${bh}, 'hex') AND bc.used_at IS NULL
          RETURNING s.user_id::text AS user_id`);
      if (!row) { await noteFuse(s.db, tag).catch(swallow("routes_best_effort_failed")); throw new AuthRejectError("backup"); }
    } else {
      const urow = await q1<{ enc: string | null; last: number | null; active: boolean }>(s.db,
        sql`SELECT totp_secret_enc AS enc, totp_last_step AS last,
            (totp_enabled_at IS NOT NULL) AS active FROM aa_users WHERE id = ${sess.userId}`);
      if (!urow?.enc || !urow.active) { await noteFuse(s.db, tag).catch(swallow("routes_best_effort_failed")); throw new AuthRejectError("totp"); }
      const secret = await decryptSecret(secrets.totpEncKey, urow.enc).catch(swallowNull("routes_lookup_failed"));
      if (!secret) throw new AuthServerFaultError("totp decrypt");
      const step = await totpMatch(secret, normalizeTotpCode(code ?? ""));
      if (step === null || (urow.last !== null && step <= urow.last)) {
        await noteFuse(s.db, tag).catch(swallow("routes_best_effort_failed")); throw new AuthRejectError("totp");
      }
      const consumed = await q1<{ id: string }>(s.db,
        sql`UPDATE aa_users SET totp_last_step = ${step}
          WHERE id = ${sess.userId} AND (totp_last_step IS NULL OR totp_last_step < ${step})
          RETURNING id::text AS id`);
      if (!consumed) { await noteFuse(s.db, tag).catch(swallow("routes_best_effort_failed")); throw new AuthRejectError("totp"); }
    }
    await grantStepup(s.db, hashHex, sess.tier);
    await clearKeys(s.db, [key]);
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(s.db, reservation).catch(swallow("routes_best_effort_failed"));
    throw new AuthServerFaultError(e);
  }
}));

// GET /auth/me -> session summary for the UI.
authRoute.get("/me", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireSession(c);
  void s;
  return c.json({
    email: sess.email, role: sess.role, perms: sess.perms,
    stepup_ok: sess.stepupOk, tier: sess.tier,
    device: { trusted: sess.deviceId !== null },
  });
}));

// POST /auth/logout -> deletes this session.
authRoute.post("/logout", async (c) => guarded(c, async () => {
  const s = authInit(c);
  if (s.sessionToken) {
    const hashHex = await tokenHashHex(s.sessionToken);
    await q1(s.db, sql`DELETE FROM aa_sessions WHERE id_hash = decode(${hashHex}, 'hex')`);
  }
  clearSidCookie(c as never);
  clearFlowCookie(c as never);
  return c.json({ ok: true });
}));

// GET /auth/sessions -> my sessions.
authRoute.get("/sessions", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireSession(c);
  const hashHex = await tokenHashHex(s.sessionToken!);
  return c.json({ user: { id: sess.userId, email: sess.email, role: sess.role }, sessions: await listSessions(s.db, sess.userId, hashHex) });
}));

// DELETE /auth/sessions/:sid -> end one of my sessions.
authRoute.delete("/sessions/:sid", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireSession(c);
  await revokeSession(s.db, c.req.param("sid") ?? "", sess.userId);
  return c.json({ ok: true });
}));

// POST /auth/sessions/revoke-others -> end every other session.
authRoute.post("/sessions/revoke-others", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireSession(c);
  const hashHex = await tokenHashHex(s.sessionToken!);
  const n = await revokeOtherSessions(s.db, sess.userId, hashHex);
  return c.json({ ok: true, revoked: n });
}));

authRoute.post("/backup-codes/regenerate", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const { codes, hashes } = await genBackupCodes();
  await regenerateBackupCodes(s.db, sess.userId, hashes);
  return c.json({ backup_codes: codes });
}));

// POST /auth/device/accept/:token -> registers a pending device (sets __Host-did).
authRoute.post("/device/accept/:token", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await inviteCap(s.db, `invite:accept:${await ipKeyOf(c)}`, INVITE_ACCEPT_PER_HOUR_IP);
  const out = await acceptDeviceInvite(s.db, c.req.param("token") ?? "", s.ctx.ua);
  setDidCookie(c as never, out.deviceToken, DEVICE_TTL_SECS);
  return c.json({ ok: true, device_id: out.deviceId });
}));

// POST /auth/device/accept {token} -> same, with the token in the BODY so it never reaches a URL log.
// The invite page reads the token from the link's #fragment and posts it here.
authRoute.post("/device/accept", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await inviteCap(s.db, `invite:accept:${await ipKeyOf(c)}`, INVITE_ACCEPT_PER_HOUR_IP);
  const body = await json<{ token: string }>(c);
  const out = await acceptDeviceInvite(s.db, typeof body.token === "string" ? body.token.slice(0, 200) : "", s.ctx.ua);
  setDidCookie(c as never, out.deviceToken, DEVICE_TTL_SECS);
  return c.json({ ok: true, device_id: out.deviceId });
}));

// ---- /admin (additive; the existing admin console is untouched) ----

// GET /admin/devices -> my devices.
adminRoute.get("/devices", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireAdmin(c);
  const qp = c.req.query();
  if (qp.scope === "all") {            // every administrator's devices, with owner, searched + paged on the server
    return c.json(await listDevicesAdmin(s.db, {
      q: qp.q, userId: qp.user_id,
      limit: qp.limit ? Number(qp.limit) : undefined, offset: qp.offset ? Number(qp.offset) : undefined,
    }));
  }
  return c.json({ user: { id: sess.userId, email: sess.email, role: sess.role }, devices: await listDevices(s.db, sess.userId) });
}));

// POST /admin/devices/invite -> single-use link for me (needs step-up).
adminRoute.post("/devices/invite", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  await inviteCap(s.db, `invite:create:${sess.userId}`, INVITE_CREATE_PER_HOUR);
  const token = await createDeviceInvite(s.db, sess.userId, sess.userId);
  return c.json({ ok: true, invite_url: inviteUrl(c, token) });
}));

// POST /admin/users/:id/device-invite -> invite for another admin (not self).
adminRoute.post("/users/:id/device-invite", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target || target.role !== "admin" || target.id === sess.userId) {
    throw new AuthRejectError("user");
  }
  await inviteCap(s.db, `invite:create:${sess.userId}`, INVITE_CREATE_PER_HOUR);
  const token = await createDeviceInvite(s.db, target.id, sess.userId);
  return c.json({ ok: true, invite_url: inviteUrl(c, token) });
}));

// DELETE /admin/devices/:id -> revoke (refuses my last active device).
adminRoute.delete("/devices/:id", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  await revokeDevice(s.db, c.req.param("id") ?? "", sess.userId, false);
  return c.json({ ok: true });
}));

// ---- administrator views of sessions / devices (all users, owner shown, server-side search + paging) ----
const pageOpts = (qp: Record<string, string>) => ({
  q: qp.q, userId: qp.user_id,
  limit: qp.limit ? Number(qp.limit) : undefined, offset: qp.offset ? Number(qp.offset) : undefined,
});

// GET /admin-v2/sessions?q=&user_id=&limit=&offset= -> live sessions of every user (admin only).
adminRoute.get("/sessions", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await requireAdmin(c);
  return c.json(await listSessionsAdmin(s.db, pageOpts(c.req.query()), await tokenHashHex(s.sessionToken!)));
}));

// GET /admin-v2/users/:id/sessions and /devices -> one user's, for the users page panels (admin only).
adminRoute.get("/users/:id/sessions", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await requireAdmin(c);
  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw new AuthRejectError("user");
  return c.json(await listSessionsAdmin(s.db, { ...pageOpts(c.req.query()), userId: id }, await tokenHashHex(s.sessionToken!)));
}));
adminRoute.get("/users/:id/devices", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await requireAdmin(c);
  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw new AuthRejectError("user");
  return c.json(await listDevicesAdmin(s.db, { ...pageOpts(c.req.query()), userId: id }));
}));

// DELETE /admin-v2/users/:id/sessions/:sid -> end one session of that user (step-up). Your own current
// session is refused here: signing yourself out is /auth/logout.
adminRoute.delete("/users/:id/sessions/:sid", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const sid = c.req.param("sid") ?? "";
  if (sid === sess.sid) throw new AuthForbiddenError("Use sign out for your own session");
  await revokeSessionOfUser(s.db, c.req.param("id") ?? "", sid);
  logWarn("admin_session_revoked", { by: sess.userId, user: c.req.param("id") ?? "" });
  return c.json({ ok: true });
}));

// POST /admin-v2/users/:id/sessions/revoke-all -> end every session of that user (step-up). For yourself it
// keeps the session you are using.
adminRoute.post("/users/:id/sessions/revoke-all", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw new AuthRejectError("user");
  const n = id === sess.userId
    ? await revokeOtherSessions(s.db, id, await tokenHashHex(s.sessionToken!))
    : await revokeAllSessions(s.db, id);
  logWarn("admin_sessions_revoked", { by: sess.userId, user: id, count: n });
  return c.json({ ok: true, revoked: n });
}));

// DELETE /admin-v2/users/:id/devices/:deviceId -> untrust one of that user's devices (step-up); its sessions end.
adminRoute.delete("/users/:id/devices/:deviceId", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const id = c.req.param("id") ?? "", deviceId = c.req.param("deviceId") ?? "";
  if (!(await deviceBelongsTo(s.db, id, deviceId))) throw new AuthRejectError("device");
  await revokeDevice(s.db, deviceId, id, id !== sess.userId);
  logWarn("admin_device_revoked", { by: sess.userId, user: id, device: deviceId });
  return c.json({ ok: true });
}));

// GET /admin-v2/users -> paginated user list (admin, users.view).
adminRoute.get("/users", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "users.view" })(c);
  const qp = c.req.query();
  return c.json(await listUsers(s.db, {
    role: qp.role, active: qp.active, q: qp.q,
    limit: qp.limit ? Number(qp.limit) : 50,
    offset: qp.offset ? Number(qp.offset) : 0,
  }));
}));

// GET /admin-v2/users/:id -> user detail + grants + access history.
adminRoute.get("/users/:id", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "users.view" })(c);
  const detail = await getUserDetail(s.db, c.req.param("id") ?? "");
  if (!detail) return c.json({ error: "Not found" }, 404);
  return c.json(detail);
}));

// GET /admin-v2/permissions/registry -> grouped registry for the access matrix.
adminRoute.get("/permissions/registry", async (c) => guarded(c, async () => {
  await guard({ perm: "users.view" })(c);
  return c.json(registryPayload());
}));

// GET /admin-v2/auth-log -> filterable auth timeline (admin, authlog.view).
adminRoute.get("/auth-log", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "authlog.view" })(c);
  const qp = c.req.query();
  return c.json(await listAuthLog(s.db, {
    event: qp.event, status: qp.status, q: qp.q,
    limit: qp.limit ? Number(qp.limit) : 50,
    offset: qp.offset ? Number(qp.offset) : 0,
  }));
}));

// GET /admin-v2/blocks -> device/IP blocks for the security console.
adminRoute.get("/blocks", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "blocks.manage" })(c);
  return c.json({ blocks: await listBlocksAdmin(s.db) });
}));

// DELETE /admin-v2/blocks/:id -> lift a block (step-up, logged by caller).
adminRoute.delete("/blocks/:id", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const ok = await liftBlock(s.db, c.req.param("id") ?? "", sess.userId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
}));

// GET /admin-v2/account-requests -> lost-email queue (?status=open|all).
adminRoute.get("/account-requests", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "account_requests.manage" })(c);
  return c.json({ requests: await listAccountRequests(s.db, c.req.query().status || "open") });
}));

// POST /admin-v2/account-requests/:id/resolve {action} -> resolve/dismiss.
adminRoute.post("/account-requests/:id/resolve", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const { action } = await json<{ action?: string }>(c);
  if (action !== "resolved" && action !== "dismissed") throw new AuthRejectError("action");
  const ok = await resolveAccountRequest(s.db, c.req.param("id") ?? "", action, sess.userId);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
}));

// GET /admin-v2/notifications -> open requests + dead letters + live blocks.
adminRoute.get("/notifications", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireSession(c);
  const queues = await listNotifications(s.db);
  const notifications = await notificationService.list(s.db, sess.userId);
  const unread = (await notificationService.unreadCount(s.db, sess.userId)) + queues.unread;
  return c.json({ ...queues, notifications, unread });
}));

// PATCH /admin-v2/notifications/:id/read -> marks one persisted notification.
adminRoute.patch("/notifications/:id/read", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireSession(c);
  const ok = await notificationService.markRead(s.db, sess.userId, c.req.param("id") ?? "");
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true, unread: await notificationService.unreadCount(s.db, sess.userId) });
}));

// POST /admin-v2/notifications/read-all -> marks only the caller's notifications.
adminRoute.post("/notifications/read-all", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireSession(c);
  await notificationService.markAllRead(s.db, sess.userId);
  const queues = await listNotifications(s.db);
  return c.json({ ok: true, unread: queues.unread });
}));

// PATCH /admin-v2/users/:id -> names, role, active/staff flags (step-up).
// Role/active/staff changes bump perms_version or session_version so the
// target's access changes on the next request without a logout.
adminRoute.patch("/users/:id", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "users.manage" })(c);
  const sess = await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target) throw new AuthRejectError("user");
  if (target.id === sess.userId) throw new AuthForbiddenError("Cannot change your own access");
  const body = await json<Record<string, unknown>>(c);
  const updates: string[] = [];
  if (typeof body.first_name === "string" && body.first_name.length <= 80) updates.push("first");
  if (typeof body.last_name === "string" && body.last_name.length <= 80) updates.push("last");
  if (typeof body.role === "string" && ["mono", "general", "admin"].includes(body.role)) updates.push("role");
  if (typeof body.is_active === "boolean") updates.push("active");
  if (typeof body.is_staff === "boolean") updates.push("staff");
  if (updates.length === 0) throw new AuthRejectError("update");
  await patchUser(s.db, target.id, {
    firstName: typeof body.first_name === "string" ? body.first_name : undefined,
    lastName: typeof body.last_name === "string" ? body.last_name : undefined,
    role: typeof body.role === "string" ? body.role : undefined,
    isActive: typeof body.is_active === "boolean" ? body.is_active : undefined,
    isStaff: typeof body.is_staff === "boolean" ? body.is_staff : undefined,
  });
  return c.json({ ok: true, updated: updates });
}));

// POST /admin/users -> create a user (users.manage + step-up for the admin role).
adminRoute.post("/users", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "users.manage" })(c);
  const sess = await requireStepUp(c);
  const { email, role } = await json<{ email?: string; role?: string }>(c);
  const id = await createUser(s.db, email, role ?? "staff", sess.userId);
  await afterResponse(c, (async () => recordUserCreated(s.db, eventCtx(c),
    { id, email: String(email).trim().toLowerCase(), role: role ?? "staff" },
    { id: sess.userId, email: sess.email }))());
  return c.json({ ok: true, id });
}));

adminRoute.put("/users/:id/permissions", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await guard({ perm: "access.manage" })(c);
  const sess = await requireStepUp(c);
  const body = await json<{ perm?: string; grant?: boolean; perms?: unknown }>(c);
  if (body.perms !== undefined) {
    const { perms } = body;
    if (!Array.isArray(perms) || !perms.every((key) => typeof key === "string")) {
      throw new AuthRejectError("perms");
    }
    const target = await resolveUser(s.db, c.req.param("id") ?? "");
    if (!target || target.id === sess.userId) throw new AuthForbiddenError("Cannot change your own access");
    const result = await replaceGrants(s.db, target.id, target.role, perms as string[]);
    return c.json({ ok: true, effective: result.effective, removed: result.removed });
  }
  const { perm, grant } = body;
  if (!perm || !isV2Perm(perm)) throw new AuthRejectError("perm");
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target) throw new AuthRejectError("user");
  if (grant) await grantPerm(s.db, target.id, perm!, sess.userId);
  else await revokePerm(s.db, target.id, perm!);
  return c.json({ ok: true });
}));

// POST /admin/users/:id/deactivate -> deactivate (last-admin safe in SQL).
adminRoute.post("/users/:id/deactivate", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target) throw new AuthRejectError("user");
  await deactivateUser(s.db, target.id);
  return c.json({ ok: true });
}));

// POST /admin/users/:id/totp-reset -> clear another admin's authenticator + codes.
adminRoute.post("/users/:id/totp-reset", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target || target.role !== "admin" || target.id === sess.userId) {
    throw new AuthRejectError("user");
  }
  await adminResetTotp(s.db, target.id, sess.userId);
  return c.json({ ok: true });
}));

// POST /admin/users/:id/force-logout -> end every session of a user.
adminRoute.post("/users/:id/force-logout", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target) throw new AuthRejectError("user");
  await forceLogout(s.db, target.id);
  return c.json({ ok: true });
}));

// POST /admin/users/:id/primary -> make this admin THE main account: it alone receives
// notifications and is the auto-assignee for new orders (step-up required).
adminRoute.post("/users/:id/primary", async (c) => guarded(c, async () => {
  const s = authInit(c);
  await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target) throw new AuthRejectError("user");
  await setPrimaryUser(s.db, target.id);
  return c.json({ ok: true });
}));

// The v2 orders surface (spec §5.4). Mounted here so it inherits this router's
// flagGate + originGuard + securityHeaders, and authenticates by session cookie
// through guard() — the same model as every route above, never the Access
// header the legacy /admin/* router uses.
adminRoute.route("/orders", orderV2Routes);

// --- Cleanup janitor (spec §5.10). Batched, safe (never an active lock or
// session). Exposed as a cron-secret-guarded route so the SAME external
// scheduler that drives reconcile can call it — no Cron Trigger assumed.
// (The retired "resets" task was removed: its SQL was a syntax error that
// aborted the whole janitor before "devices" and "invites" could run.)
const CLEAN_TASKS: Array<[string, string]> = [
  ["flows", `delete from aa_auth_flows where id in (
     select id from aa_auth_flows where expires_at < now() - interval '1 day'
     order by expires_at limit $1) returning 1`],
  ["sessions", `delete from aa_sessions where id_hash in (
     select id_hash from aa_sessions where absolute_expires_at < now()
     order by absolute_expires_at limit $1) returning 1`],
  ["challenges", `delete from aa_login_challenges where user_id in (
     select user_id from aa_login_challenges where expires_at < now() - interval '1 day'
     limit $1) returning 1`],
  ["throttle", `delete from aa_auth_throttle where key in (
     select key from aa_auth_throttle
      where last_fail_at < now() - interval '48 hours'
        and (locked_until is null or locked_until < now())
      limit $1) returning 1`],
  ["devices", `delete from aa_admin_devices where id in (
     select id from aa_admin_devices
      where (status = 'revoked' and revoked_at < now() - interval '30 days')
         or (status = 'pending' and pending_until < now() - interval '1 day')
      limit $1) returning 1`],
  ["invites", `delete from aa_device_invites where token_hash in (
     select token_hash from aa_device_invites where expires_at < now() - interval '7 days'
     limit $1) returning 1`],
];

/** Run every clean task in bounded batches until drained. Returns per-label counts. */
export async function runCleanup(db: Db, batch = 500): Promise<Record<string, number>> {
  const limit = Math.max(1, Math.min(5000, Math.floor(batch))); // server-controlled int
  const out: Record<string, number> = {};
  for (const [label, stmt] of CLEAN_TASKS) {
    let total = 0;
    for (;;) {
      // The only variable is the batch size, an int we just clamped — safe to
      // inline. Everything else in the statement is fixed.
      const rows = await q<Record<string, unknown>>(db, sql.raw(stmt.replace("$1", String(limit))));
      total += rows.length;
      if (rows.length < limit) break;
    }
    out[label] = total;
  }
  return out;
}

// POST /admin-v2/internal/cleanup -> batched janitor, guarded by the shared
// cron secret (same mechanism as reconcile; no Cron Trigger assumed).
adminRoute.post("/internal/cleanup", async (c) => guarded(c, async () => {
  const secret = c.req.header("x-cron-secret");
  const expected = (c.env as unknown as { RECONCILE_CRON_SECRET?: string }).RECONCILE_CRON_SECRET;
  if (!expected || secret !== expected) return c.json({ error: "Not found" }, 404);
  const s = authInit(c);
  const counts = await runCleanup(s.db, 500);
  return c.json({ ok: true, counts });
}));