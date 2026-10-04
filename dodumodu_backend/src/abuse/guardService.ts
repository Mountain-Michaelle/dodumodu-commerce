import type { Db } from "../db";
import type { Env } from "../env";
import { abuseConfigFrom, type AbuseConfig } from "./config";
import { restrictionDecision, windowStartFor, isLegitimateProgression, type RestrictionVerdict } from "./counters";
import { normalizePhone } from "../shared/normalizePhone";
import * as activityRepo from "./activityRepo";

// The abuse guard: observe, decide, and NEVER take an order away from a customer
// while in shadow mode.
//
// THREE PROPERTIES THIS MODULE EXISTS TO HOLD, in order of importance:
//
//  1. IT CANNOT REJECT AN ORDER. `evaluate` returns a verdict as DATA. Nothing in
//     this file writes a 429 or a 403 to a response. In shadow mode that is by
//     configuration; in enforce mode it will be the caller's explicit, deliberate
//     action. A protection layer that can silently refuse a customer is a layer
//     that eventually refuses the wrong one.
//
//  2. IT FAILS OPEN. Every database call below is wrapped. If Neon is unreachable,
//     the counters are unavailable, or anything at all throws, the guard logs and
//     returns "allow". Abuse protection must never be the reason a real customer
//     cannot buy. It does NOT extend that courtesy to anything else: validation,
//     Turnstile, pricing and payment keep failing closed exactly as before,
//     because those are what protect the business.
//
//  3. THE DECISION USES ONLY PRE-EXISTING EVIDENCE. readEstablished() happens
//     BEFORE recordPost(), and the verdict is computed from the former. This is the
//     "the request that crosses a threshold is still allowed" rule, and it holds by
//     construction here rather than by care.

export type AbuseVerdict = {
  /** True only if enforcement were on AND the conjunction is met. */
  wouldRestrict: boolean;
  reason: string | null;
  /** The canonical identity, or null when the number could not be resolved. */
  phoneNorm: string | null;
  /** False when normalization failed; identity checks are then skipped entirely. */
  phoneKnown: boolean;
  /** The verified address, or null when the request carried none. */
  ip: string | null;
};

/** Resolve the abuse config from env. Exposed so tests need not build an Env. */
export function configFor(env: Env): AbuseConfig {
  return abuseConfigFrom(env as unknown as Record<string, string | undefined>);
}

/**
 * Observe one request and report what enforcement would have done.
 *
 * `replay` is passed in rather than detected here: the caller has already done the
 * idempotency lookup, because that lookup is the FIRST order-safety decision and
 * must not be reordered behind abuse bookkeeping. A replay is returned immediately
 * as "not counted, not evaluated, not extended".
 */
export async function evaluate(
  db: Db,
  env: Env,
  input: { ip: string | null; rawPhone: string | null; replay: boolean; now?: Date },
): Promise<AbuseVerdict> {
  const ip = input.ip;
  const config = configFor(env);

  if (input.replay) {
    // A replay is not activity. It does not increment a counter, does not add a
    // phone, and cannot extend anything. It simply returns.
    return { wouldRestrict: false, reason: "idempotent_replay", phoneNorm: null, phoneKnown: false, ip };
  }

  if (config.mode === "off") {
    return { wouldRestrict: false, reason: "mode_off", phoneNorm: null, phoneKnown: false, ip };
  }

  // A request with no verified address is NOT observed.
  //
  // This is the only place the null rule is enforced, and it is enforced by
  // returning before any write. A null ip cannot be grouped with anything, cannot
  // be counted, cannot be compared to a threshold, and cannot be blocked - so the
  // failure direction is structural. Returning here also costs zero queries.
  if (input.ip === null) {
    return {
      wouldRestrict: false,
      reason: "no_verified_ip",
      phoneNorm: null,
      phoneKnown: false,
      ip: null,
    };
  }

  // An allowlisted IP (the owner's office, a test address) skips the observation
  // work entirely. It is not just exempt from restriction: it costs no queries at
  // all, so allowlisting is also the cheapest way to exempt a legitimate source.
  if (config.ipAllowlist.includes(input.ip)) {
    return {
      wouldRestrict: false,
      reason: `IP ${input.ip} is allowlisted`,
      phoneNorm: null,
      phoneKnown: false,
      ip: input.ip,
    };
  }
  // Narrowed once, here, by control flow rather than by an assertion. Everything
  // below this point is address-scoped and expects a real subject, and this is the
  // branch that guarantees it. Using `ip` directly would type-check only because the
  // guard above returns on null - binding it to a named local makes that dependency
  // explicit at the point where the rest of the function relies on it.
  if (ip === null) {
    return { wouldRestrict: false, reason: "no_verified_ip", phoneNorm: null, phoneKnown: false, ip: null };
  }
  const subject: string = ip;
  const now = input.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const windowStart = windowStartFor(nowSeconds, config.windowSeconds);

  // Uncertainty is not evidence. An unresolvable number yields phoneKnown=false,
  // and every identity-keyed check is then skipped: we do not invent an identity
  // for it, and we certainly do not refuse a customer over formatting.
  const phoneNorm = normalizePhone(input.rawPhone);
  const phoneKnown = phoneNorm !== null;

  let verdict: RestrictionVerdict;
  try {
    // ---- READ FIRST. This snapshot predates anything this request writes. ----
    const established = await activityRepo.readEstablished(db, subject, windowStart);
    verdict = restrictionDecision(established, config, { nowSeconds, ip: subject });

    // ---- THEN RECORD. The current request is evidence for the NEXT request. ----
    await activityRepo.recordPost(db, subject, windowStart);
    await activityRepo.notePhone(db, subject, windowStart, phoneNorm);
  } catch (error) {
    // Fail open, loudly. The label is deliberately distinct from every other log
    // event in this codebase so an operator can grep for abuse-layer failures
    // specifically and know they are the reason something was allowed through.
    console.error(JSON.stringify({
      event: "abuse_system_error",
      stage: "evaluate",
      ip,
      detail: error instanceof Error ? error.message : String(error),
    }));
    return {
      wouldRestrict: false,
      reason: "abuse_system_error_fail_open",
      phoneNorm,
      phoneKnown,
      ip,
    };
  }

  // In shadow mode this is recorded, never acted on. The log line is the entire
  // deliverable of the shadow phase: it says exactly what enforcement would have
  // done, per request, so thresholds can be chosen from evidence.
  if (verdict.restrict && config.mode === "shadow") {
    console.warn(JSON.stringify({
      event: "abuse_shadow_would_restrict",
      ip,
      phoneKnown,
      reason: verdict.reason.code,
      detail: verdict.reason.detail,
    }));
  }

  return {
    // NOTE: shadow reports what WOULD happen, and deliberately does not mask it
    // as false - otherwise the shadow log could never measure anything.
    wouldRestrict: verdict.restrict,
    reason: verdict.reason.detail,
    phoneNorm,
    phoneKnown,
    ip,
  };
}

/**
 * Record what actually happened, after the order flow has run.
 *
 * Separate from evaluate because these are DIFFERENT facts: evaluate records that
 * a request arrived; this records whether it turned into an order, and whether that
 * order reached a legitimate progression status. Failures and awaiting_payment are
 * deliberately NOT progression - a failed payment is a normal thing that happens
 * to honest people.
 */
export async function recordOutcome(
  db: Db,
  env: Env,
  input: {
    ip: string | null;
    outcome: "created" | "validation_failed" | "turnstile_failed";
    orderStatus?: string | null;
    orderId?: number | null;
    now?: Date;
  },
) {
  const config = configFor(env);
  if (config.mode === "off") return;
  // No verified address: nothing to attribute the outcome to, so nothing is recorded.
  // Same rule as evaluate(): fail open by not observing.
  if (input.ip === null) return;
  if (config.ipAllowlist.includes(input.ip)) return;

  const now = input.now ?? new Date();
  const windowStart = windowStartFor(Math.floor(now.getTime() / 1000), config.windowSeconds);

  try {
    if (input.outcome === "validation_failed") {
      await activityRepo.recordValidationFailure(db, input.ip, windowStart);
    } else if (input.outcome === "turnstile_failed") {
      await activityRepo.recordTurnstileFailure(db, input.ip, windowStart);
    }
    // A created order counts as successful progression only if its status is one a
    // real customer ends up in. This is the negative evidence that disarms the
    // block for a shared carrier address.
    if (input.outcome === "created" && isLegitimateProgression(input.orderStatus)) {
      await activityRepo.recordSuccessfulProgression(db, input.ip, windowStart);
    }
  } catch (error) {
    // Outcome evidence is a bonus. Losing it degrades future judgement but must
    // never affect the order that was already created.
    console.error(JSON.stringify({
      event: "abuse_system_error",
      stage: "record_outcome",
      ip: input.ip,
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
}
