import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { createDb } from "../db";
import {
  analyticsHashVersion,
  hashVisitorIp,
  visitorAnalyticsService,
  visitorGeo,
} from "../services/visitorAnalyticsService";

const MAX_EVENT_BODY_BYTES = 128;
const SERVER_THROTTLE_SECONDS = 60;
const eventSchema = z.object({
  kind: z.enum(["visit", "intent"]),
}).strict();

export const visitorAnalyticsRoute = new Hono<{ Bindings: Env }>();

async function eventBody(request: Request): Promise<
  { ok: true; value: unknown } | { ok: false; status: 400 | 413 }
> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isInteger(length) || length < 0) return { ok: false, status: 400 };
    if (length > MAX_EVENT_BODY_BYTES) return { ok: false, status: 413 };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, status: 400 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVENT_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, status: 400 };
  }
}

visitorAnalyticsRoute.post("/analytics/visit", async (c) => {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    return c.json({ error: { code: "INVALID_ANALYTICS_EVENT" } }, 400);
  }
  const body = await eventBody(c.req.raw);
  if (!body.ok) {
    return c.json({ error: { code: "INVALID_ANALYTICS_EVENT" } }, body.status);
  }
  const parsed = eventSchema.safeParse(body.value);
  if (!parsed.success) {
    return c.json({ error: { code: "INVALID_ANALYTICS_EVENT" } }, 400);
  }

  const kind = parsed.data.kind;
  if (kind === "intent" && c.env.ANALYTICS_WARMUP_ENABLED !== "true") {
    return c.body(null, 204);
  }

  const ip = c.req.header("cf-connecting-ip");
  if (!ip) return c.body(null, 204);

  try {
    const version = analyticsHashVersion(c.env.ANALYTICS_IP_HMAC_VERSION);
    const key = await hashVisitorIp(ip, c.env.ANALYTICS_IP_HMAC_SECRET);
    const throttleKey = `analytics:${kind}:${version}:${key}`;
    if (await c.env.RATE_LIMIT_KV.get(throttleKey)) return c.body(null, 204);
    await c.env.RATE_LIMIT_KV.put(throttleKey, "1", {
      expirationTtl: SERVER_THROTTLE_SECONDS,
    });

    if (kind === "visit") {
      const cf = c.req.raw.cf;
      await visitorAnalyticsService.recordHashedVisit(
        createDb(c.env.DATABASE_URL),
        { hash: key, version },
        visitorGeo(
          typeof cf?.country === "string" ? cf.country : undefined,
          typeof cf?.region === "string" ? cf.region : undefined,
        ),
      );
    } else {
      await visitorAnalyticsService.warmDatabase(createDb(c.env.DATABASE_URL));
    }
    return c.body(null, 204);
  } catch (error) {
    console.error(JSON.stringify({
      event: "visitor_analytics_failed",
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    }));
    return c.json({
      error: { code: "ANALYTICS_UNAVAILABLE", message: "Visitor analytics is temporarily unavailable." },
    }, 503);
  }
});
