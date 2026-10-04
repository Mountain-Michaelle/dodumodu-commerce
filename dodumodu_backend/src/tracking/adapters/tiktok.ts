import { describeTransportError, interpretResponse, type Adapter, type FetchFn, type NeutralEvent, type SendResult } from "./types";
import type { PlatformConfig } from "../config";

/**
 * TikTok Events API.
 *
 * Docs used at implementation time (not from memory):
 *  - Standard web events, event codes and recommended parameters:
 *    https://ads.tiktok.com/help/article/standard-events-parameters
 *  - Event dedup (browser and server events sharing one event_id are counted
 *    once): https://ads.tiktok.com/help/article/event-deduplication
 *
 * The event name was checked rather than assumed, because it is commonly gotten
 * wrong: on TikTok's WEB events the completed-purchase event is named
 * "Purchase". "CompletePayment" is the APP/Shop event name, not the web one —
 * sending it here would produce events the Ads Manager does not recognise as
 * standard conversions, and the campaign would optimise against nothing.
 *
 * TikTok's parameter shape differs from Meta's in two ways that matter: the
 * event fields are top-level (not nested under `data`), and the user identifier
 * is a list of objects under `user` with `phone_number`/`email` keys rather than
 * Meta's `user_data` array with `ph`/`em`.
 */
export const tiktokAdapter: Adapter = {
  key: "tiktok",

  eventNameMap: {
    page_view: "PageView",
    view_content: "ViewContent",
    initiate_checkout: "InitiateCheckout",
    purchase: "Purchase",
  },

  buildPayload(event: NeutralEvent, config: PlatformConfig) {
    const user: Record<string, string> = {};
    if (event.user.phoneHash) user.phone_number = event.user.phoneHash;
    if (event.user.emailHash) user.email = event.user.emailHash;
    // TikTok matches on its own browser cookies; ttclid is the click id.
    if (event.cookies.ttp) user.ttp = event.cookies.ttp;
    if (event.cookies.ttclid) user.ttclid = event.cookies.ttclid;
    if (event.clickIds.ttclid && !user.ttclid) user.ttclid = event.clickIds.ttclid;

    const body: Record<string, unknown> = {
      event_source: "web",
      // TikTok wants an ISO-8601 timestamp in its OWN event time, unlike Meta's
      // unix seconds. Both are the confirmation time, not the send time.
      event_time: new Date(event.eventTime).toISOString(),
      event: tiktokAdapter.eventNameMap[event.name] ?? "Purchase",
      // The dedup key, identical to the browser pixel's for the same action.
      event_id: event.eventId,
      timestamp: Math.floor(new Date(event.eventTime).getTime() / 1000),
      page_url: event.pageUrl ?? undefined,
      user,
      // content_ids are strings in TikTok's schema.
      content_ids: event.content.map((item) => String(item.id)),
      content_type: "product",
      contents: event.content.map((item) => ({
        content_id: String(item.id),
        quantity: item.quantity,
      })),
      currency: event.currency,
      value: event.value,
      query: "",
    };

    // Unhashed, per TikTok's documented IP/user-agent parameters.
    if (event.clientIp) body.ip = event.clientIp;
    if (event.userAgent) body.user_agent = event.userAgent;

    if (config.testEventCode) {
      body.test_event_code = config.testEventCode;
    }
    return body;
  },

  async send(payload: unknown, config: PlatformConfig, fetchFn: FetchFn): Promise<SendResult> {
    // TikTok takes credentials as query parameters rather than a bearer header.
    const url = `https://api.tiktokapis.com/v2.0/events/track/`
      + `?access_token=${encodeURIComponent(config.accessToken)}`
      + `&event_source=web`;
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return interpretResponse(response);
    } catch (error) {
      return { ok: false, retryable: true, error: describeTransportError(error) };
    }
  },
};

// Re-exported from here rather than imported from the sibling Meta adapter, so a
// reader of this file finds everything it uses in one import.
export { describeTransportError } from "./types";