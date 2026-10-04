import { describeTransportError, interpretResponse, type Adapter, type FetchFn, type NeutralEvent, type SendResult } from "./types";
import type { PlatformConfig } from "../config";

/**
 * Meta Conversions API. Covers Facebook and Instagram from one pixel/dataset.
 *
 * Docs used at implementation time (not from memory):
 *  - Endpoint + parameters: https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters
 *  - Deduplication (pixel eventID must equal server event_id, same event_name,
 *    within a 48-hour window):
 *    https://developers.facebook.com/documentation/ads-commerce/conversions-api/deduplicate-pixel-and-server-events
 *
 * Two Meta-specific details worth stating, because both are easy to get wrong:
 *
 *  - `fbc` is DERIVED, not received. It is a `fb.<fbclid>.<fbp>` string built
 *    from the click id and the browser cookie. Sending a raw `fbc` from the
 *    client would be sending a value Meta did not define.
 *  - Customer data goes in `user_data` as an ARRAY of {em, ph, ...} objects, not
 *    as a flat object, and `action_source: "website"` is what tells Meta this is
 *    a web event rather than an app or offline one.
 */
export const metaAdapter: Adapter & { buildFbc(event: NeutralEvent): string | null } = {
  key: "meta",

  eventNameMap: {
    page_view: "PageView",
    view_content: "ViewContent",
    initiate_checkout: "InitiateCheckout",
    // Verified against Meta's own standard events: for a web conversion the
    // purchase-completed event is named "Purchase". It is only "Purchase" plus a
    // different action_source for app/other sources.
    purchase: "Purchase",
  },

  buildPayload(event: NeutralEvent, config: PlatformConfig) {
    const userData: Record<string, string> = {};
    if (event.user.phoneHash) userData.ph = event.user.phoneHash;
    if (event.user.emailHash) userData.em = event.user.emailHash;
    if (event.user.city) userData.ct = event.user.city;
    if (event.user.country) userData.country = event.user.country;
    // Browser identifiers, passed through as Meta defines them.
    if (event.cookies.fbp) userData.fbp = event.cookies.fbp;
    if (event.cookies.fbc) userData.fbc = event.cookies.fbc;
    // A click id without a matching fbp cookie still yields a usable fbc.
    const derivedFbc = metaAdapter.buildFbc(event);
    if (!userData.fbc && derivedFbc) userData.fbc = derivedFbc;

    const body: Record<string, unknown> = {
      data: {
        event_name: metaAdapter.eventNameMap[event.name] ?? "Purchase",
        // The dedup key. Must equal the pixel's eventID for the same action.
        event_id: event.eventId,
        // When the conversion HAPPENED, not when we got round to sending it. For
        // pay-on-delivery this can be days after the click.
        event_time: Math.floor(new Date(event.eventTime).getTime() / 1000),
        action_source: "website",
        event_source_url: event.pageUrl ?? undefined,
        user_data: [userData],
        custom_data: {
          currency: event.currency,
          // Minor units, matching the order table's kobo integers. Meta sums
          // these, so sending naira instead would under-report by 100x.
          value: event.value,
          content_type: "product",
          content_ids: event.content.map((item) => item.id),
          contents: event.content.map((item) => ({
            id: item.id,
            quantity: item.quantity,
          })),
          num_items: event.content.reduce((sum, item) => sum + item.quantity, 0),
        },
      },
    };

    // Unhashed, exactly as Meta specifies: these are not customer identifiers we
    // hash, they are request metadata Meta uses for its own matching.
    if (event.clientIp) body.client_ip_address = event.clientIp;
    if (event.userAgent) body.client_user_agent = event.userAgent;

    if (config.testEventCode) {
      body.test_event_code = config.testEventCode;
    }
    return body;
  },

  /**
   * `fb.<fbclid>.<fbp>`, omitting the parts that do not exist.
   *
   * Meta's documented shape: fbc is only meaningful when it can be tied to both
   * the click and the browser, so a click id with no cookie yields null rather
   * than a half-built string that would match nobody.
   */
  buildFbc(event: NeutralEvent): string | null {
    const fbclid = event.clickIds.fbclid;
    const fbp = event.cookies.fbp;
    if (!fbclid) return null;
    return fbp ? `fb.${fbclid}.${fbp}` : `fb.${fbclid}`;
  },

  async send(payload: unknown, config: PlatformConfig, fetchFn: FetchFn): Promise<SendResult> {
    const url = `https://graph.facebook.com/${config.apiVersion}/${config.pixelId}/events`;
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Query-string access token, which is how the Conversions API takes it.
          // It is never logged and never leaves this call.
          authorization: `Bearer ${config.accessToken}`,
        },
        body: JSON.stringify(payload),
      });
      return interpretResponse(response);
    } catch (error) {
      // A thrown fetch is a transport failure: the platform may well have
      // received it, but we cannot know, so it counts as retryable.
      return { ok: false, retryable: true, error: describeTransportError(error) };
    }
  },
};