import { z } from "zod";

// NOTE: deliberately no `subtotal`/`discountPercent`/`discountAmount`/`amount`
// fields — the backend computes all pricing from productId + packageId +
// quantity. §8.1: the client's numbers are never trusted, even if sent.

/**
 * Text that PostgreSQL can actually store.
 *
 * A NUL byte (\u0000) is legal in a JSON string and legal in JavaScript, but
 * PostgreSQL text columns reject it with error 22021 ("invalid byte sequence for
 * encoding UTF8"). Without this check the request passed the whole schema, reached
 * the INSERT, and came back as an unhandled 500 - a server error where the correct
 * answer was a 400, thrown by the database rather than by validation.
 *
 * Found by the edge-case sweep, not by review: nothing in the schema looks like it
 * should care, and no unit test sent a control character.
 *
 * C0 control characters are stripped rather than rejected. A pasted name carrying
 * an invisible control code is still a real customer with a real order to place, and
 * failing them at the door is a lost sale to fix something they cannot see. The NUL
 * is dropped and the order proceeds - the alternative is a 500.
 */
const printable = (max: number) => z.string()
  .transform((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""))
  .pipe(z.string().trim().min(1).max(max));

export const orderSchema = z.object({
  idempotencyKey: z.string().uuid(),
  // Deliberately allowed to be empty, and deliberately NOT a `.min(1)`. Whether a
  // token is required is a deployment question, not a shape question, and
  // verifyTurnstile in routes/orders.ts is the only thing that can answer it:
  // with no secret outside production it skips, and in production a missing token
  // is verified against Cloudflare and fails closed. A `.min(1)` here ran first
  // and rejected the local-dev build — where an empty TURNSTILE_SITE_KEY
  // disables the widget, so turnstile.js resolves without one — with a 400 the
  // customer could do nothing about, and never reached the check that matters.
  // The cap stays: it is a real token, not a free-text field.
  turnstileToken: z.string().trim().max(2048).default(""),
  productId: z.number().int().positive(),
  packageId: z.string().min(1).optional(),
  quantity: z.number().int(), // upper bound (MAX_ORDER_QUANTITY) is checked in orderService — it's env-driven, not a static schema constant
  customerName: printable(120).pipe(z.string().trim().min(2)),
  phone: z.string().trim().regex(/^\+?[0-9]{10,14}$/, "Enter a valid phone number"),
  whatsapp: z.string().trim().regex(/^\+?[0-9]{10,14}$/, "Enter a valid WhatsApp number"),
  address: printable(500).pipe(z.string().trim().min(5)),
  state: printable(60).pipe(z.string().trim().min(2)),
  deliveryDate: z.enum(["today", "tomorrow", "next_tomorrow"]),
  paymentMethod: z.enum(["pay_now", "cod"]),
  questionNotes: printable(500).optional(),
});

export type OrderInput = z.infer<typeof orderSchema>;
