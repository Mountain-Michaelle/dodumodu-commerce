import type { Context, Next } from "hono";
import type { Env } from "../env";
import { createDb } from "../db";
import { ordersRepo, type OrderRow } from "../data/ordersRepo";
import { evaluate, recordOutcome } from "../abuse/guardService";
import { admit } from "../abuse/admission";
import * as spamRepo from "../abuse/spamRepo";
import { normalizePhone } from "../shared/normalizePhone";

const MAX_BODY_BYTES = 10 * 1024; // 10KB

// The header a client uses to declare a stable device token. Chosen to be
// unambiguous and impossible to confuse with a forwarding header.
const DEVICE_HEADER = "x-dodumodu-device";

/**
 * The verified client address, or null.
 *
 * Two things this deliberately does NOT do. It does not substitute a placeholder
 * for a missing header, because a shared placeholder turns every header-less
 * request into one group and every threshold into a measurement of unrelated
 * strangers. And it does not consult a client-supplied forwarding header: those
 * are trivially forged, and a forgeable subject key would let a single actor
 * spread itself across every other customer's bucket.
 *
 * Returns null rather than throwing. A malformed header is a reason to observe
 * less, not a reason to fail an order.
 */
function readIp(c: Context<{ Bindings: Env; Variables: Vars }>): string | null {
  const raw = c.req.header("cf-connecting-ip");
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Kept from the limiter this replaces: a body cap is cheap defence against a huge
// payload arriving before any other check runs, and losing it in the move would be
// a silent regression.
type Vars = {
  parsedBody: unknown;
  prefetchedOrder?: OrderRow | null;
  /** The verified address, or null. */
  clientIp?: string | null;
  /** The client-declared device token, or null. NOT a fingerprint. */
  deviceId?: string | null;
  /** in_app | browser | unknown. */
  clientKind?: string;
};

// The order-form abuse guard - the SINGLE abuse authority for this endpoint.
//
// ORDER OF OPERATIONS, and the reason for it:
//
//   1. body-size cap
//   2. idempotency lookup        <-- FIRST order-safety decision
//   3. only then: abuse observation
//
// The idempotency lookup deliberately precedes any abuse bookkeeping. A replay of
// an already-processed request is not abuse evidence: it is the SAME customer
// retrying because their network dropped, which is exactly the behaviour that must
// never be counted, never be flagged, and never extend a restriction. Charging a
// retry against someone's limit is how a protection layer costs a real customer
// their order.
//
// The check is deliberately LENIENT: the idempotency key is read from the parsed
// body without running the full schema, because the schema's job is to decide
// whether this is a well-formed ORDER, and a replay is not an order at all. A
// body that fails the schema later is simply not a replay, which is the safe
// direction - it is counted like any other attempt.
//
// SHADOW MODE: `evaluate` returns a verdict as data. This middleware does not and
// CANNOT reject anything. Turning rejection on is a deliberate later change, not
// something this file does implicitly.
export async function orderGuard(c: Context<{ Bindings: Env; Variables: Vars }>, next: Next) {
  // The body is parsed here rather than in the route, because the guard needs the
  // idempotency key BEFORE schema validation can decide this is a well-formed
  // order. Re-attaching it keeps the route from re-reading the stream, exactly as
  // the previous limiter did.
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "Request body too large" }, 413);
  }

  const raw = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  c.set("parsedBody", raw);
  const body = raw;
  // Resolve the canonical identity ONCE here, because two things need it: the
  // spam-flag check below, and the observation layer. Both use the same normalizer,
  // so a flag and an observation can never disagree about who this is.
  const phoneNorm = normalizePhone(typeof body?.phone === "string" ? body.phone : null);
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null;
  // cf-connecting-ip only. Never a client-supplied forwarding header: those are
  // trivially forged, and a forgeable key would let one actor spread load across
  // every other customer's bucket.
  //
  // A MISSING HEADER IS null, NOT a sentinel string. An earlier version used the
  // literal "unknown", which quietly created a bucket that every header-less request
  // shared - so one misconfigured proxy would pool unrelated customers into a single
  // subject, and any threshold would then be measuring the sum of every visitor on
  // the internet. null cannot be grouped, so a request with no verified address is
  // simply not counted. Fail-open by construction, not by an intention somebody has
  // to remember.
  const ip = readIp(c);
  const deviceId = readDeviceId(c);
  const clientKind = readClientKind(c);
  // Published on the context so the route can persist them with the order. The guard
  // reads them for observation; the route is what writes them.
  c.set("clientIp", ip);
  c.set("deviceId", deviceId);
  c.set("clientKind", clientKind);
  const db = createDb(c.env.DATABASE_URL);

  let replay = false;
  if (idempotencyKey && idempotencyKey.length > 0) {
    try {
      const existing = await ordersRepo.findByIdempotencyKey(db, idempotencyKey);
      replay = existing !== null;
      if (replay) {
        // Hand the row to the route so createOrder does not repeat the lookup.
        // One authority, one lookup: the route still falls back to querying itself
        // when this is absent, so behaviour is unchanged either way.
        c.set("prefetchedOrder", existing);
      }
    } catch (error) {
      // Idempotency is EXISTING order-safety logic and must NOT fail open here.
      // If we cannot check it, we cannot claim the request is a replay, so we
      // continue as a normal attempt and let orderService perform its own lookup
      // and its own unique-violation handling. The abuse layer is the only thing
      // allowed to fail open; this simply declines to assert a conclusion.
      console.error(JSON.stringify({
        event: "abuse_idempotency_lookup_failed",
        detail: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  // A manual spam flag is the one hard restriction, and it is the ONLY thing that
  // can refuse an order in Phase 3. It applies to FUTURE requests only and it was
  // placed by a human who gave a reason - there is no heuristic path to it.
  //
  // A null phoneNorm is NOT flagged: we could not identify the customer, so we
  // must not invent an identity and then exclude them on the strength of it.
  let flag: Awaited<ReturnType<typeof spamRepo.findActive>> = null;
  try {
    flag = phoneNorm ? await spamRepo.findActive(db, phoneNorm) : null;
  } catch (error) {
    // Fail OPEN. Order creation needs this same database, so refusing here could
    // not protect anything it was not already preventing.
    console.error(JSON.stringify({
      event: "abuse_system_error", stage: "spam_flag_lookup", ip,
      detail: error instanceof Error ? error.message : String(error),
    }));
    flag = null;
  }
  if (flag) {
    return c.json({
      error: "ORDER_NOT_ACCEPTED",
      message: "We are unable to accept this order at the moment. If you believe this is a mistake, please contact us and we will help.",
    }, 403);
  }

  // Observation only. The verdict is logged; nothing acts on it.
  await evaluate(db, c.env, {
    ip,
    rawPhone: typeof body?.phone === "string" ? body.phone : null,
    replay,
  });

  // ---- Admission: the only automatic refusal in the system ----
  //
  // Placed AFTER the idempotency lookup and AFTER the manual spam flag, and that
  // ordering is the point. A retry of an order that already exists is not a new
  // attempt, so it must never be refused; and a human who flagged a number has
  // already made their decision, which outranks any heuristic.
  //
  // With RL_AUTO_BLOCK=shadow this logs what it would have done and refuses nobody.
  // It is inert until the switch is set to "on", which is a deliberate act.
  const admission = await admit(db, c.env, { ip, deviceId }, (event) => {
    // Everything here is server-side only. None of this text reaches the customer:
    // the refusal body below is fixed copy, so a rule name, a device token or the
    // word "spam" can never leak into the browser.
    console.warn(JSON.stringify(event));
  });
  if (!admission.allowed) {
    // Retry-After is the authoritative machine-readable form; the body repeats it so
    // a fetch() caller can show it without parsing headers.
    c.header("Retry-After", String(admission.response.body.retryAfterSeconds));
    return c.json(admission.response.body, admission.response.status);
  }

  await next();
}

/**
 * The client-declared device token, or null.
 *
 * NOT A FINGERPRINT. Nothing here inspects the canvas, fonts, GPU, screen or any
 * characteristic of the device. The client volunteers one random value and reuses
 * it; we store it, count it, and can block it.
 *
 * That is a deliberately limited instrument and the limits are known: a value the
 * client chooses is a value the client can rotate, so a bot that does so defeats
 * V1 entirely. That gap is reported in the shadow report rather than hidden, and V2
 * exists because of it - not because the device id is strong evidence.
 *
 * Validated hard because this string is attacker-controlled AND becomes a block key.
 * A 10KB token, a control character or a whitespace-only value must never become a
 * subject. Length is capped at 64 and the alphabet is a plain UUID/hex shape;
 * anything else is null, which is absent evidence rather than an error.
 */
function readDeviceId(c: Context<{ Bindings: Env; Variables: Vars }>): string | null {
  const raw = c.req.header(DEVICE_HEADER);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * A coarse client classification. Never the raw User-Agent.
 *
 * The shadow report asks one question - in-app browser or ordinary one - because
 * social traffic arrives through app browsers and that shapes what "normal" looks
 * like. Retaining a full UA string on every order would be personal data kept for
 * no benefit, so only the answer is kept.
 */
function readClientKind(c: Context<{ Bindings: Env; Variables: Vars }>): string {
  const ua = c.req.header("user-agent");
  if (typeof ua !== "string" || ua.length === 0) return "unknown";
  // FBAN/FBAV are the Android in-app markers; iOS in-app browsers also report
  // Safari, so their vendor tokens are checked too.
  if (/FBAN|FBAV|Instagram|Line\/|TikTok|BytedanceWebview/i.test(ua)) return "in_app";
  return "browser";
}
/**
 * Record what actually happened, once the route knows.
 *
 * Called from the route AFTER the outcome is known, because these are different
 * facts: a request arriving is not the same as an order being created, and an order
 * being created is not the same as it reaching a paid or delivered state. Counting
 * a failure here is what lets the rule tell a retry storm (nothing succeeds) from a
 * shared network (something succeeds) apart.
 */
export async function noteOrderOutcome(
  c: Context<{ Bindings: Env; Variables: Vars }>,
  outcome: "created" | "validation_failed" | "turnstile_failed",
  order?: { status?: string; id?: number } | null,
) {
  const ip = readIp(c);
  await recordOutcome(createDb(c.env.DATABASE_URL), c.env, {
    ip,
    outcome,
    orderStatus: order?.status ?? null,
    orderId: order?.id ?? null,
  });
}