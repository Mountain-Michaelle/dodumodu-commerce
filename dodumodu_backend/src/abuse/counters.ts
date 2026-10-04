// Deciding whether activity is abusive — as a PURE function.
//
// This file contains the entire restriction policy, and it takes a snapshot of
// evidence plus context and returns a verdict. It performs no I/O, so every rule
// below is provable without a database, which matters because these are the rules
// that can cost a customer an order.
//
// THE CENTRAL RULE, encoded rather than documented:
//
//   A restriction decision is made from evidence that EXISTED BEFORE the current
//   request was recorded.
//
// That is why `restrictionDecision` takes `established` (read before the write) and
// never reads any post-write counter. It is a data-flow property, not a rule
// someone has to remember: the function is not even given the numbers it would
// need to judge this request itself.
//
// Concretely, with a threshold of 5 posts:
//
//   request 5  -> crosses the threshold -> ALLOWED, evidence recorded
//   request 6  -> reads 5 already established -> may be restricted
//
// A customer whose burst crosses a line is always allowed through the request that
// crosses it. Only a LATER request can be refused, on evidence already there.

import type { AbuseConfig } from "./config";

/**
 * What the system knows about one key (an IP) as of the moment just BEFORE the
 * current request is recorded.
 */
export type EstablishedEvidence = {
  windowStart: number;
  posts: number;
  /** Distinct normalized phones seen in this window. */
  distinctPhones: number;
  validationFailures: number;
  turnstileFailures: number;
  /** Orders from this IP that reached a legitimate progression status. */
  successfulProgressions: number;
};

export type RestrictionReason = {
  /** Stable machine-readable label, logged and shown in the admin view. */
  code:
    | "correlated_activity"
    | "allowlisted"
    | "mode_off"
    | "insufficient_evidence";
  /** Human sentence for an operator reading the shadow report. */
  detail: string;
};

export type RestrictionVerdict = {
  /** True only when EVERY signal of the conjunction is present. */
  restrict: boolean;
  reason: RestrictionReason;
};

/** The fixed-window bucket a timestamp belongs to. */
export function windowStartFor(nowSeconds: number, windowSeconds: number): number {
  return Math.floor(nowSeconds / windowSeconds) * windowSeconds;
}

/** Does this evidence belong to the window currently being counted? */
export function isCurrentWindow(
  evidence: EstablishedEvidence,
  nowSeconds: number,
  windowSeconds: number,
): boolean {
  return evidence.windowStart === windowStartFor(nowSeconds, windowSeconds);
}

/**
 * Whether ESTABLISHED evidence justifies a temporary restriction.
 *
 * Four signals, ALL required. Each is necessary on its own:
 *
 *  1. posts above threshold           — something is happening at volume.
 *  2. distinct phones above threshold — and it is MANY different people, not one
 *     person retrying on a flaky connection. This separates a shared NAT from a
 *     flood.
 *  3. failures above threshold        — and most of it is not succeeding. A retry
 *     storm from one genuine customer fails nothing and succeeds nothing.
 *  4. successful progressions BELOW the success floor — and this is the interlock.
 *     If even a few real orders came out of this IP, it is serving customers and
 *     is not restricted, however ugly the other three numbers look.
 *
 * Signal 4 is what makes this safe for shared mobile networks, and it is why there
 * is deliberately no "IP above N -> block" rule anywhere in this codebase. An IP
 * aggregates customers; it is not a customer.
 */
export function restrictionDecision(
  evidence: EstablishedEvidence,
  config: AbuseConfig,
  options: { nowSeconds: number; ip: string },
): RestrictionVerdict {
  if (config.mode === "off") {
    return { restrict: false, reason: { code: "mode_off", detail: "Abuse layer is off" } };
  }
  if (config.ipAllowlist.includes(options.ip)) {
    return { restrict: false, reason: { code: "allowlisted", detail: `IP ${options.ip} is allowlisted` } };
  }
  // A stale window is a reset, not a continuation. Counting it would let an old
  // busy hour keep justifying a restriction hours later.
  if (!isCurrentWindow(evidence, options.nowSeconds, config.windowSeconds)) {
    return {
      restrict: false,
      reason: { code: "insufficient_evidence", detail: "Previous window has expired" },
    };
  }

  const failures = evidence.validationFailures + evidence.turnstileFailures;

  const postsHigh = evidence.posts >= config.ipPosts;
  const phonesHigh = evidence.distinctPhones >= config.distinctPhones;
  const failuresHigh = failures >= config.failures;
  const noSuccess = evidence.successfulProgressions < config.successFloor;

  if (postsHigh && phonesHigh && failuresHigh && noSuccess) {
    return {
      restrict: true,
      reason: {
        code: "correlated_activity",
        detail:
          `Correlated activity in window starting ${evidence.windowStart}: `
          + `${evidence.posts} posts (>=${config.ipPosts}), `
          + `${evidence.distinctPhones} distinct phones (>=${config.distinctPhones}), `
          + `${failures} failures (>=${config.failures}), `
          + `only ${evidence.successfulProgressions} successful progressions (<${config.successFloor})`,
      },
    };
  }

  // Naming WHICH signal was missing is what makes shadow mode useful: it shows how
  // close real traffic came to each bar, which is the only honest way to choose
  // thresholds.
  const missing = [
    !postsHigh && `posts ${evidence.posts}/${config.ipPosts}`,
    !phonesHigh && `distinct phones ${evidence.distinctPhones}/${config.distinctPhones}`,
    !failuresHigh && `failures ${failures}/${config.failures}`,
    !noSuccess && `successes ${evidence.successfulProgressions} disarm the block`,
  ].filter(Boolean);

  return {
    restrict: false,
    reason: {
      code: "insufficient_evidence",
      detail: `Not restricted; below: ${missing.join(", ")}`,
    },
  };
}

/**
 * Statuses that count as legitimate progression.
 *
 * `confirmed_cod` is deliberately included and deliberately NOT treated as
 * suspicious: under a cash-on-delivery business model it is the ORDINARY state of
 * every good order in transit, and reading it as evidence of fraud would penalise
 * the entire way the business is paid.
 *
 * `awaiting_payment` and `failed` are deliberately absent. Neither is evidence of
 * fraud: a prepaid order awaiting payment is a normal order, and a failed payment
 * is a normal thing that happens to honest people on bad networks.
 */
const PROGRESSED_STATUSES = new Set(["paid", "confirmed_cod", "delivered"]);

export function isLegitimateProgression(status: string | null | undefined): boolean {
  return typeof status === "string" && PROGRESSED_STATUSES.has(status);
}