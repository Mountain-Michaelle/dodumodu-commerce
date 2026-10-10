// Auth v2 middleware — spec §2/§5. Everything new is behind ADMIN_AUTH_V2.
// With the flag off, the whole auth router 404s and no existing behavior
// changes. The exported guards (requireSession/requireAdmin/requirePerm/
// requireStepUp) are NOT applied to any existing route; cutover is separate.
import type { Context, Next } from "hono";
import { createDb, type Db } from "../db";
import { adminAuthEnabled } from "./config";
import { lookupSession, touchSession, touchDevice, type Session } from "./session-lookup";
import { buildCtx, getSidToken, getDidToken, type ReqCtx } from "./ctx";
import { AuthUnauthorizedError, AuthForbiddenError } from "./errors";

export type AuthEnv = Record<string, string | undefined> & { DATABASE_URL: string };

/** Per-request auth state attached to the Hono context. */
export interface AuthState {
  db: Db;
  ctx: ReqCtx;
  session: Session | null;
  sessionToken: string | null;
  deviceToken: string | null;
}

declare module "hono" {
  interface ContextVariableMap {
    aa: AuthState;
    requestId: string;
  }
}

/** db + ctx for the auth path. Not the session — that needs the token. */
export function authInit(c: Context<{ Bindings: AuthEnv }>): AuthState {
  const existing = c.get("aa") as AuthState | undefined;
  if (existing) return existing;
  const db = createDb(c.env.DATABASE_URL);
  const state: AuthState = {
    db, ctx: buildCtx(c), session: null,
    sessionToken: getSidToken(c as never), deviceToken: getDidToken(c as never),
  };
  c.set("aa", state);
  return state;
}

/** 404 when the flag is off. The router wraps every handler with this. */
export async function flagGate(c: Context<{ Bindings: AuthEnv }>, next: Next) {
  if (!adminAuthEnabled(c.env)) return c.json({ error: "Not found" }, 404);
  await next();
}

/** Custom Origin + content-type guard for unsafe methods (spec §5.2 decision 11). */
export async function originGuard(c: Context<{ Bindings: AuthEnv }>, next: Next) {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const origin = c.req.header("Origin");
  const host = c.req.header("Host");
  if (!origin) return c.json({ error: "Bad origin" }, 403);
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return c.json({ error: "Bad origin" }, 403);
  }
  if (originHost !== host) return c.json({ error: "Bad origin" }, 403);
  const ct = c.req.header("Content-Type") ?? "";
  if (!ct.includes("application/json")) return c.json({ error: "Bad content type" }, 415);
  await next();
}

/** Resolve + cache the session (one SESSION_LOOKUP per request, spec §6). */
export async function loadSession(c: Context<{ Bindings: AuthEnv }>): Promise<Session | null> {
  const s = authInit(c);
  if (s.session !== null) return s.session;
  if (!s.sessionToken) return null;
  const sess = await lookupSession(s.db, s.sessionToken);
  if (!sess) return null;
  // Drift check: request prefix differs from the session's -> turn strict.
  if (sess.prefix && sess.prefix !== s.ctx.prefix) {
    const { driftSession } = await import("./devices");
    const r = await driftSession(s.db, s.sessionToken, s.ctx.prefix, s.ctx.country);
    if (r.revoked) return null;
    sess.tier = "strict";
  }
  s.session = sess;
  if (sess.needsTouch) {
    // Touch in waitUntil so the response never waits (spec §6).
    const token = s.sessionToken;
    c.executionCtx?.waitUntil?.(touchSession(s.db, token).then(() => {
      if (sess.deviceId) return touchDevice(s.db, sess.deviceId!);
    }));
  }
  return sess;
}

// --- Guards (spec §5.7). Exported so existing routes CAN adopt them later.
// NOT applied to any existing route. Cutover is a separate task.

/** requireSession: a valid session. 401 otherwise. Sets c.get("aa").session. */
export function requireSession(c: Context<{ Bindings: AuthEnv }>) {
  return loadSession(c).then((s) => {
    if (!s) throw new AuthUnauthorizedError();
    return s;
  });
}

/** requireAdmin: an admin session. 401 if none, 403 if not admin. */
export async function requireAdmin(c: Context<{ Bindings: AuthEnv }>) {
  const s = await requireSession(c);
  if (s.role !== "admin") throw new AuthForbiddenError();
  return s;
}

/** requirePerm(perm): default deny. Admins implicitly hold all (spec §5.2.9). */
export function requirePerm(perm: string) {
  return async (c: Context<{ Bindings: AuthEnv }>) => {
    const s = await requireSession(c);
    if (s.role === "admin") return s;
    if (!s.perms.includes(perm)) throw new AuthForbiddenError();
    return s;
  };
}

/** requireStepUp: an admin with a fresh step-up window. 403 otherwise. */
export async function requireStepUp(c: Context<{ Bindings: AuthEnv }>) {
  const s = await requireAdmin(c);
  if (!s.stepupOk) throw new AuthForbiddenError("Step-up required");
  return s;
}
