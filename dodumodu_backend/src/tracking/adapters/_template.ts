// TEMPLATE — copy this file to add a platform. This stub is deliberately never
// registered, and never imported by the registry.
//
// Adding a platform is exactly three steps and zero edits elsewhere:
//
//   1. Copy this file to `./<yourplatform>.ts` and rename the export.
//   2. Add ONE line to src/tracking/registry.ts mapping the key to your adapter.
//   3. Add `<YOURPLATFORM>_PIXEL_ID` and `<YOURPLATFORM>_ACCESS_TOKEN` as env
//      (the token as a Wrangler SECRET), and the key to TRACKING_PLATFORMS.
//
// The dispatcher, the order flow, the database schema and every other platform's
// tests are untouched, and must stay that way — that is what the registry is for.
//
// Before you finish, CHECK the docs rather than trusting the shape below:
//   - the API endpoint and version (versions change; put yours in config as
//     <PLATFORM>_API_VERSION rather than hardcoding it),
//   - the standard event name for a completed purchase on THIS platform's web
//     events, which is not always "Purchase",
//   - the exact key names for user data, click ids and cookies,
//   - how the platform deduplicates browser against server events, and make sure
//     your eventId field carries the same id the browser pixel sends,
//   - how long the platform will accept an event, and put it in
//     <PLATFORM>_MAX_EVENT_AGE_SECONDS.
//
// What is written below is a plausible SKELETON. Treat the endpoint, the field
// names and the auth style as unverified placeholders — copying them unverified
// is how an adapter ships that silently posts to nothing.

import { describeTransportError, interpretResponse, type Adapter, type FetchFn, type NeutralEvent, type SendResult } from "./types";
import type { PlatformConfig } from "../config";

export const yourPlatformAdapter: Adapter = {
  key: "yourplatform",

  // Neutral -> this platform's name for the same real-world moment. Verify the
  // purchase one against the docs; it is the field that matters most.
  eventNameMap: {
    page_view: "PageView",
    view_content: "ViewContent",
    initiate_checkout: "InitiateCheckout",
    purchase: "Purchase",
  },

  // `config` is unused in this skeleton payload; the leading underscore keeps it
  // named for whoever copies this and starts building a real request body.
  buildPayload(event: NeutralEvent, _config: PlatformConfig) {
    // Build whatever shape the docs specify from the NEUTRAL event. Do not import
    // from services/, data/ or routes/ — an adapter sees a NeutralEvent and
    // nothing else, which is what keeps it testable in isolation.
    //
    // Rules that hold for every platform:
    //  - event.user.* fields are ALREADY normalized and hashed. Hash again and
    //    the platform can never match them.
    //  - event.value is MINOR UNITS (kobo), matching the orders table.
    //  - event.eventTime is when the conversion HAPPENED, which for a
    //    pay-on-delivery order can be days ago. Never substitute Date.now().
    //  - event.eventId must be the same id the browser pixel sends, or the same
    //    real purchase gets counted twice.
    return {
      event_id: event.eventId,
      event: this.eventNameMap[event.name],
      timestamp: event.eventTime,
      value: event.value,
      currency: event.currency,
      // ... this platform's own field names go here.
    };
  },

  async send(payload: unknown, config: PlatformConfig, fetchFn: FetchFn): Promise<SendResult> {
    // VERIFY: endpoint URL, path, and how the credential is passed (header vs
    // query string differs per platform and is not interchangeable).
    const url = `https://api.example.com/v1/events`;
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(payload),
      });
      // interpretResponse already encodes the retryability rule (429/5xx yes,
      // other 4xx no). Use it unless this platform documents otherwise.
      return interpretResponse(response);
    } catch (error) {
      return { ok: false, retryable: true, error: describeTransportError(error) };
    }
  },
};