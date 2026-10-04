// The contract every adapter implements.
//
// This is the whole plug-in surface. The dispatcher knows only what is written
// here, which is what makes "add a platform" a bounded task: copy _template.ts,
// add one line to registry.ts, add config keys. The dispatcher, the order flow,
// the database schema and every other platform's tests stay untouched.
//
// Nothing in this file may import from services/, routes/ or data/. An adapter
// turns a neutral event into a request body and reports a result; it has no
// business knowing what an order is.

import type { EventName, PlatformConfig } from "../config";

// Re-exported so adapters and the event builder can name the neutral event
// vocabulary through ONE module, and so adding a neutral event is a single edit
// in config.ts that every consumer picks up.
export type { EventName };

/** What we know about a confirmed buyer, in platform-neutral terms. */
export type NeutralEvent = {
  /** Neutral name. The adapter maps it to its platform's vocabulary. */
  name: EventName;
  /**
   * Stable identifier, shared with the browser pixel when the same real-world
   * action is sent twice. Both platforms deduplicate on this pair.
   */
  eventId: string;
  /** Confirmation time as an ISO-8601 UTC string — NOT the send time. */
  eventTime: string;
  /** Minor units (kobo). Platforms expect minor units, not naira. */
  value: number;
  currency: string;
  /** Where the customer actually was when the order was placed. */
  pageUrl: string | null;
  user: {
    /** Already normalized and hashed. Never raw. */
    phoneHash: string | null;
    emailHash: string | null;
    city: string | null;
    country: string | null;
  };
  /** Platform cookies read at landing time; passed through un-hashed. */
  clickIds: Record<string, string>;
  cookies: Record<string, string>;
  clientIp: string | null;
  userAgent: string | null;
  /** For a pay-on-delivery purchase, the items actually handed over. */
  content: { id: string; quantity: number }[];
};

export type SendResult = {
  ok: boolean;
  /**
   * Whether trying again could plausibly succeed. A 4xx (bad token, malformed
   * payload) is NOT retryable — retrying it just burns the attempt budget and
   * hides a configuration error behind an exhausted row.
   */
  retryable: boolean;
  error: string | null;
};

/** Injected so adapters are testable with no network and no real credentials. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type Adapter = {
  /** Matches the key used in TRACKING_PLATFORMS and in registry.ts. */
  key: string;
  /** Neutral name -> this platform's name for the same thing. */
  eventNameMap: Partial<Record<EventName, string>>;
  buildPayload(event: NeutralEvent, config: PlatformConfig): unknown;
  send(
    payload: unknown,
    config: PlatformConfig,
    fetchFn: FetchFn,
  ): Promise<SendResult>;
};

/**
 * Name a transport failure for the log.
 *
 * Lives here rather than in an adapter because it is not platform-specific: a
 * thrown fetch is either our own timeout or a connection that never completed,
 * and neither has an HTTP status to report.
 */
export function describeTransportError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "timeout" : error.message.slice(0, 300);
  }
  return "transport_error";
}

/**
 * Turn a platform's response into a SendResult.
 *
 * Shared by every adapter because the retryability rule is universal and easy to
 * get subtly wrong per-platform: 429 and 5xx are transient, everything else in
 * the 4xx range is a request we will never get right by asking again. A timeout
 * is a thrown error rather than a response, which is why it is handled first.
 */
export async function interpretResponse(response: Response, timeout = false): Promise<SendResult> {
  if (timeout) {
    return { ok: false, retryable: true, error: "timeout" };
  }
  if (response.ok) {
    return { ok: true, retryable: false, error: null };
  }
  const retryable = response.status === 429 || response.status >= 500;
  // The body is read for the log only. It can contain our own payload echoed
  // back, so callers must treat `error` as operator-facing text and never
  // return it from a public route.
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    detail = "";
  }
  return {
    ok: false,
    retryable,
    error: `http_${response.status}${detail ? `: ${detail}` : ""}`,
  };
}