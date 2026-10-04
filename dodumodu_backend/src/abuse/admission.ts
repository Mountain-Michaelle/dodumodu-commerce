import type { Env } from "../env";
import type { Db } from "../db";
import { abuseConfigFrom, type AbuseConfig } from "./config";
import { evaluateBurst, type BurstDecision } from "./velocity";
import * as blockRepo from "./blockRepo";

// The admission decision: what happens to this order request right now.
//
// THIS IS THE ONLY CODE IN THE APPLICATION THAT CAN REFUSE AN ORDER AUTOMATICALLY,
// and it refuses in exactly one circumstance - RL_AUTO_BLOCK=on AND a burst rule
// matched. Everything else about it is arranged to fail open.
//
// THE ORDER OF OPERATIONS, and it matters:
//
//   1. Is this subject ALREADY blocked?      -> refuse (429). No burst query needed.
//   2. Would a burst rule match right now?   -> refuse (429) or log, per the switch.
//   3. Otherwise                              -> let the order through.
//
// Step 1 before step 2 deliberately: an already-blocked subject does not need its
// burst counted again, so the common refused request costs one indexed lookup rather
// than a window scan.
//
// WHY IT FAILS OPEN. Every database call here is wrapped, and every failure returns
// "allow". Refusing orders because the abuse layer is unwell would lose real sales
// to protect against nothing - the spam flag check in orderGuard is a SEPARATE,
// pre-existing protection and is not affected by anything here.

export type Admission = {
  allowed: true;
} | {
  allowed: false;
  /** What to tell the customer. Never names the rule, the device, or "spam". */
  response: {
    status: 429;
    body: {
      error: string;
      message: string;
      retryAfterSeconds: number;
      /** Present only when SUPPORT_WHATSAPP_URL is configured and valid. */
      contactUrl: string | null;
    };
  };
  /** For the server log. Never shown to the customer. */
  detail: string;
};

/** The customer-facing text. Neutral, and the same whatever triggered it. */
const REFUSAL_MESSAGE =
  "We are not able to accept another order from you right now. "
  + "Please try again in a few minutes.";

/**
 * Decide whether this request may proceed.
 *
 * Returns a decision, never throws. Callers get `allowed: true` on every internal
 * failure, which is the entire fail-open contract.
 */
export async function decideAdmission(
  db: Db,
  config: AbuseConfig,
  subjects: { ip: string | null; deviceId: string | null },
  log: (event: Record<string, unknown>) => void,
): Promise<Admission> {
  // ---- 1. already blocked? ----
  try {
    const existing = await blockRepo.findActiveFor(db, subjects);
    if (existing) {
      log({
        event: "moderation_block_hit",
        scope: existing.scope,
        source: existing.source,
        remainingSeconds: existing.remainingSeconds,
      });
      return {
        allowed: false,
        response: {
          status: 429,
          body: {
            error: "ORDER_NOT_ACCEPTED",
            message: REFUSAL_MESSAGE,
            retryAfterSeconds: existing.remainingSeconds,
            contactUrl: config.supportWhatsappUrl,
          },
        },
        detail: `blocked ${existing.scope} for another ${existing.remainingSeconds}s`,
      };
    }
  } catch (error) {
    // Fail open. An index lookup that cannot run must not cost a customer an order.
    log({
      event: "abuse_system_error",
      stage: "block_lookup",
      detail: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }

  // ---- 2. would a burst rule match? ----
  // In shadow mode this is where the evidence is produced and nothing is enforced;
  // with the switch off it is not consulted at all.
  if (config.autoBlock === "off") return { allowed: true };

  let decision: BurstDecision;
  try {
    decision = await evaluateBurst(db, config, subjects);
  } catch (error) {
    log({
      event: "abuse_system_error",
      stage: "burst_evaluation",
      detail: error instanceof Error ? error.message : String(error),
    });
    return { allowed: true };
  }

  if (!decision.matched) {
    // Rotating-id bots are recorded rather than matched. This is the accepted gap,
    // and logging it is what stops it being forgotten.
    if (decision.rotatingIds) {
      log({
        event: "abuse_known_gap",
        gap: "rotating_device_ids",
        ip: subjects.ip,
        note: "burst volume but identities spread across many devices - not blocked",
        arithmetic: decision.arithmetic,
      });
    }
    return { allowed: true };
  }

  // A match. What happens now depends entirely on the kill switch.
  const evidence = {
    rule: decision.rule,
    scope: decision.scope,
    arithmetic: decision.arithmetic,
    windowSeconds: config.velocityWindowSeconds,
    at: new Date().toISOString(),
  };

  if (config.autoBlock === "shadow") {
    log({
      event: "abuse_would_block",
      mode: "shadow",
      rule: decision.rule,
      scope: decision.scope,
      arithmetic: decision.arithmetic,
      note: "nothing was refused",
    });
    return { allowed: true };
  }

  // ---- enforce ----
  try {
    const row = await blockRepo.createBlock(db, {
      scope: decision.scope as "ip" | "device",
      value: decision.subject as string,
      reason: `Automatic ${decision.rule} burst block`,
      source: decision.rule === "v1_device" ? "auto_v1" : "auto_v2",
      blockedBy: "system:burst",
      seconds: config.velocityBlockSeconds,
      evidence,
    });
    log({
      event: row ? "abuse_block_created" : "abuse_block_race_lost",
      mode: "enforce",
      rule: decision.rule,
      scope: decision.scope,
      seconds: config.velocityBlockSeconds,
      arithmetic: decision.arithmetic,
    });
    return {
      allowed: false,
      response: {
        status: 429,
        body: {
          error: "ORDER_NOT_ACCEPTED",
          message: REFUSAL_MESSAGE,
          retryAfterSeconds: config.velocityBlockSeconds,
          contactUrl: config.supportWhatsappUrl,
        },
      },
      detail: decision.arithmetic,
    };
  } catch (error) {
    // The block could not be written. We still have a matched rule in hand, so the
    // decision stands - but the failure is logged loudly, because a burst rule that
    // keeps failing to persist is a rule that is not actually protecting anything.
    log({
      event: "abuse_system_error",
      stage: "block_create",
      detail: error instanceof Error ? error.message : String(error),
    });
    return {
      allowed: false,
      response: {
        status: 429,
        body: {
          error: "ORDER_NOT_ACCEPTED",
          message: REFUSAL_MESSAGE,
          retryAfterSeconds: config.velocityBlockSeconds,
          contactUrl: config.supportWhatsappUrl,
        },
      },
      detail: decision.arithmetic,
    };
  }
}

/** Resolve config and run the admission decision in one call. */
export async function admit(
  db: Db,
  env: Env,
  subjects: { ip: string | null; deviceId: string | null },
  log: (event: Record<string, unknown>) => void,
): Promise<Admission> {
  return decideAdmission(db, abuseConfigFrom(env as unknown as Record<string, string | undefined>), subjects, log);
}

/** The 429 body, shaped for the customer. Exported for the storefront's test. */
export function blockedBody(
  retryAfterSeconds: number,
  supportWhatsappUrl: string | null,
) {
  return {
    error: "ORDER_NOT_ACCEPTED",
    message: REFUSAL_MESSAGE,
    retryAfterSeconds,
    contactUrl: supportWhatsappUrl,
  };
}
