// Auth v2 HTTP surface — spec §5.7. Mounted at AUTH_BASE (/auth) and
// ADMIN_BASE (/admin). Every route is behind flagGate (404 when off) and
// originGuard for unsafe methods. Errors map to neutral 401 / 429 {retry_after}
// / 503 {retry:true} / 403 so real, unknown and denied look identical.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Db } from "../db";
import { AuthRejectError, AuthLockedError, AuthServerFaultError,
  AuthUnauthorizedError, AuthForbiddenError } from "./errors";
import type { AuthEnv } from "./middleware";
import { flagGate, originGuard, authInit,
  requireSession, requireAdmin, requireStepUp, securityHeaders } from "./middleware";
import { loadAuthSecrets } from "./secrets";
import { FLOW_TTL_SECS, DEVICE_TTL_SECS, SESSION_ABSOLUTE_SECS, isV2Perm } from "./config";
import { requestCode } from "./entry";
import { verifyCode } from "./factors";
import { enrollPhrase, verifyPhrase } from "./phrase";
import { totpEnrollStart, totpEnrollConfirm, genBackupCodes } from "./totp";
import { verifyTotp } from "./totp-verify";
import { finishStaffSession } from "./sessions";
import { finishAdminSession } from "./sessions-admin";
import { deviceStart } from "./devices";
import { createDeviceInvite, acceptDeviceInvite, revokeDevice, listDevices } from "./device-invites";
import { createPhraseReset, consumePhraseReset, grantStepup, listSessions,
  revokeSession, revokeOtherSessions, createUser, grantPerm, revokePerm,
  deactivateUser, adminResetTotp, forceLogout, regenerateBackupCodes } from "./admin-ops";
import { tokenHashHex, emailTag } from "./keys";
import { q, q1, sql } from "./sql";
import { reserve, noteFuse, refund, clearKeys } from "./throttle";
import { sha256, toHex, decryptSecret, totpMatch } from "./crypto";
import { providerForEnv, sendLoginCode, sendInBackground, testMailbox } from "./email";
import { setFlowCookie, setSidCookie, setDidCookie, clearSidCookie, clearFlowCookie,
  getFlowToken } from "./ctx";
import { loadFlow } from "./flows";

type AppEnv = { Bindings: AuthEnv };

const NEUTRAL_401 = { error: "Invalid or expired code" };

/** Map a thrown auth error to the neutral wire response. */
function mapError(c: Context<AppEnv>, e: unknown): Response {
  if (e instanceof AuthLockedError) {
    return c.json({ error: "Too many attempts", retry_after: e.retryAfterSecs }, 429);
  }
  if (e instanceof AuthServerFaultError) {
    return c.json({ error: "Something went wrong", retry: true }, 503);
  }
  if (e instanceof AuthForbiddenError) return c.json({ error: e.message }, 403);
  if (e instanceof AuthUnauthorizedError) return c.json({ error: e.message }, 401);
  if (e instanceof AuthRejectError) return c.json(NEUTRAL_401, 401);
  throw e; // unknown -> 500 (fail closed; never allow)
}

async function guarded(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    return mapError(c, e);
  }
}

const secretsOf = (c: Context<AppEnv>) => loadAuthSecrets(c.env);
const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin;
const json = async <T>(c: Context<AppEnv>): Promise<Partial<T>> =>
  (await c.req.json().catch(() => ({}))) as Partial<T>;

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
authRoute.post("/request", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { email } = await json<{ email?: string }>(c);
  const secrets = secretsOf(c);
  const out = await requestCode(s.db, secrets, email, s.ctx, s.deviceToken);
  if (out.sendCode) {
    const provider = providerForEnv(secrets.resendApiKey, (c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP);
    c.executionCtx?.waitUntil?.(
      sendLoginCode(provider, out.sendCode.to, out.sendCode.code).catch(() => {}));
  }
  if (out.sendDeniedAlert) {
    const provider = providerForEnv(secrets.resendApiKey, (c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP);
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
  const out = await requestCode(s.db, secrets, f.email, s.ctx, s.deviceToken);
  if (out.sendCode) {
    const provider = providerForEnv(secrets.resendApiKey, (c.env as { ALLOW_TEST_IP?: string }).ALLOW_TEST_IP);
    c.executionCtx?.waitUntil?.(
      sendLoginCode(provider, out.sendCode.to, out.sendCode.code).catch(() => {}));
  }
  setFlowCookie(c as never, out.flowToken, FLOW_TTL_SECS);
  return c.json({ ok: true }, 202);
}));

// POST /auth/code {code} -> next stage.
authRoute.post("/code", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { code } = await json<{ code?: string }>(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const out = await verifyCode(s.db, secretsOf(c), token, code ?? "", s.ctx.ip);
  return c.json({ next: out.next });
}));

// POST /auth/device/start {email} + __Host-did -> always 202 + flow cookie.
authRoute.post("/device/start", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { email } = await json<{ email?: string }>(c);
  const out = await deviceStart(s.db, secretsOf(c).throttleKey, email ?? "",
    s.deviceToken, s.ctx.ip, s.ctx.prefix, s.ctx.country, s.ctx.ua);
  setFlowCookie(c as never, out.flowToken, FLOW_TTL_SECS);
  return c.json({ ok: true }, 202);
}));

// POST /auth/phrase/enroll {phrase, confirm} -> next stage (first login).
authRoute.post("/phrase/enroll", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { phrase, confirm } = await json<{ phrase?: string; confirm?: string }>(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const out = await enrollPhrase(s.db, secretsOf(c), token, phrase ?? "", confirm ?? "", s.ctx.ip);
  return c.json({ next: out.next });
}));

// POST /auth/phrase {phrase} -> next stage.
authRoute.post("/phrase", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { phrase } = await json<{ phrase?: string }>(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const out = await verifyPhrase(s.db, secretsOf(c), token, phrase ?? "", s.ctx.ip);
  return c.json({ next: out.next });
}));


// POST /auth/totp/enroll/start -> {secret, otpauth_uri} once.
authRoute.post("/totp/enroll/start", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const email = await flowEmail(s.db, token);
  const out = await totpEnrollStart(s.db, secretsOf(c), token, email);
  return c.json({ secret: out.secret, otpauth_uri: out.otpauthUri });
}));

// POST /auth/totp {code} or {backup_code} at totp / totp_enroll -> next.
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
authRoute.post("/session", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const token = getFlowToken(c as never);
  if (!token) throw new AuthRejectError("flow");
  const flow = await loadFlow(s.db, token);
  if (!flow || flow.stage !== "ready" || flow.user_id === null) throw new AuthRejectError("flow");
  const u = await q1<{ role: string }>(s.db, sql`SELECT role FROM aa_users WHERE id = ${flow.user_id}`);
  if (!u) throw new AuthRejectError("flow");
  const args = { flowToken: token, ...s.ctx, tier: "normal" as const };
  const fin = u.role === "admin"
    ? await finishAdminSession(s.db, args)
    : await finishStaffSession(s.db, args);
  setSidCookie(c as never, fin.sessionToken, SESSION_ABSOLUTE_SECS);
  if (fin.deviceToken) setDidCookie(c as never, fin.deviceToken, DEVICE_TTL_SECS);
  clearFlowCookie(c as never);
  return c.json({ ok: true });
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
      const bh = toHex(await sha256(backup_code.replace("-", "")));
      const row = await q1<{ user_id: string }>(s.db,
        sql`UPDATE aa_recovery_codes SET used_at = now()
          WHERE user_id = ${sess.userId} AND code_hash = decode(${bh}, 'hex') AND used_at IS NULL
          RETURNING user_id`);
      if (!row) { await noteFuse(s.db, tag).catch(() => {}); throw new AuthRejectError("backup"); }
    } else {
      const urow = await q1<{ enc: string | null; last: number | null; active: boolean }>(s.db,
        sql`SELECT totp_secret_enc AS enc, totp_last_step AS last,
            (totp_enabled_at IS NOT NULL) AS active FROM aa_users WHERE id = ${sess.userId}`);
      if (!urow?.enc || !urow.active) { await noteFuse(s.db, tag).catch(() => {}); throw new AuthRejectError("totp"); }
      const secret = await decryptSecret(secrets.totpEncKey, urow.enc).catch(() => null);
      if (!secret) throw new AuthServerFaultError("totp decrypt");
      const step = await totpMatch(secret, code ?? "");
      if (step === null || (urow.last !== null && step <= urow.last)) {
        await noteFuse(s.db, tag).catch(() => {}); throw new AuthRejectError("totp");
      }
      const consumed = await q1<{ id: string }>(s.db,
        sql`UPDATE aa_users SET totp_last_step = ${step}
          WHERE id = ${sess.userId} AND (totp_last_step IS NULL OR totp_last_step < ${step})
          RETURNING id::text AS id`);
      if (!consumed) { await noteFuse(s.db, tag).catch(() => {}); throw new AuthRejectError("totp"); }
    }
    await grantStepup(s.db, hashHex, sess.tier);
    await clearKeys(s.db, [key]);
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthRejectError || e instanceof AuthLockedError) throw e;
    await refund(s.db, reservation).catch(() => {});
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
  return c.json({ sessions: await listSessions(s.db, sess.userId, hashHex) });
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


// POST /auth/phrase-reset/:token {phrase} -> sets phrase, ends all sessions.
authRoute.post("/phrase-reset/:token", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const { phrase } = await json<{ phrase?: string }>(c);
  await consumePhraseReset(s.db, c.req.param("token") ?? "", phrase ?? "");
  return c.json({ ok: true });
}));

// POST /auth/backup-codes/regenerate -> new set shown once (admin + step-up).
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
  const out = await acceptDeviceInvite(s.db, c.req.param("token") ?? "", s.ctx.ua);
  setDidCookie(c as never, out.deviceToken, DEVICE_TTL_SECS);
  return c.json({ ok: true, device_id: out.deviceId });
}));

// ---- /admin (additive; the existing admin console is untouched) ----

// GET /admin/devices -> my devices.
adminRoute.get("/devices", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireAdmin(c);
  return c.json({ devices: await listDevices(s.db, sess.userId) });
}));

// POST /admin/devices/invite -> single-use link for me (needs step-up).
adminRoute.post("/devices/invite", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const token = await createDeviceInvite(s.db, sess.userId, sess.userId);
  return c.json({ ok: true, invite_url: `${origin(c)}/auth/device/accept/${token}` });
}));

// POST /admin/users/:id/device-invite -> invite for another admin (not self).
adminRoute.post("/users/:id/device-invite", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target || target.role !== "admin" || target.id === sess.userId) {
    throw new AuthRejectError("user");
  }
  const token = await createDeviceInvite(s.db, target.id, sess.userId);
  return c.json({ ok: true, invite_url: `${origin(c)}/auth/device/accept/${token}` });
}));

// DELETE /admin/devices/:id -> revoke (refuses my last active device).
adminRoute.delete("/devices/:id", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  await revokeDevice(s.db, c.req.param("id") ?? "", sess.userId, false);
  return c.json({ ok: true });
}));


// POST /admin/users -> create a user (users.manage + step-up for the admin role).
adminRoute.post("/users", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const { email, role } = await json<{ email?: string; role?: string }>(c);
  const id = await createUser(s.db, email, role ?? "staff", sess.userId);
  return c.json({ ok: true, id });
}));

// POST /admin/users/:id/phrase-reset -> email a single-use reset link.
adminRoute.post("/users/:id/phrase-reset", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const target = await resolveUser(s.db, c.req.param("id") ?? "");
  if (!target) throw new AuthRejectError("user");
  const token = await createPhraseReset(s.db, target.id, sess.userId);
  return c.json({ ok: true, reset_url: `${origin(c)}/auth/phrase-reset/${token}` });
}));

// PUT /admin/users/:id/permissions -> grant or revoke (needs step-up).
adminRoute.put("/users/:id/permissions", async (c) => guarded(c, async () => {
  const s = authInit(c);
  const sess = await requireStepUp(c);
  const { perm, grant } = await json<{ perm?: string; grant?: boolean }>(c);
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

// --- Cleanup janitor (spec §5.10). Batched, safe (never an active lock or
// session). Exposed as a cron-secret-guarded route so the SAME external
// scheduler that drives reconcile can call it — no Cron Trigger assumed.
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
  ["resets", `delete from aa_phrase_resets where token_hash in (
     select token_hash from aa_phrase_resets where expires_at < now() - interval '7 days'
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


