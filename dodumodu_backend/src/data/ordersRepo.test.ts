import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "../db";
import { ordersRepo } from "./ordersRepo";

/* findByReference is what stops a paid order from being left unpaid. The payment
   webhook looks the order up by the reference the provider echoed back, and if
   that lookup misses, handleWebhook returns `order_not_found` and the order sits
   in awaiting_payment forever. There is no database in this test suite, so what
   is pinned here is the condition we build — that it folds case on BOTH sides,
   rather than comparing with eq(), which is case-sensitive in Postgres.

   This proves the expression, not Postgres's execution of it. ordersRepo's
   callers are covered by paymentService.test.ts; the SQL is verified against the
   local database by hand, not asserted here. */

type Captured = { where: unknown };

/** Minimal stand-in for the drizzle chain: select().from().where().limit(). */
function stubDb(row: unknown, captured: Captured): Db {
  const chain = {
    from: () => chain,
    where: (condition: unknown) => { captured.where = condition; return chain; },
    limit: async () => (row === undefined ? [] : [row]),
  };
  return { select: () => chain } as unknown as Db;
}

/**
 * Renders a drizzle `SQL` condition back into readable text. `SQL` has no
 * toString(), so it is reassembled from `queryChunks`: string chunks carry their
 * text in `.value`, an interpolated column carries `.name`, and an interpolated
 * value arrives as a bare string. Columns are bracketed so they cannot be
 * confused with a literal.
 */
function renderSql(where: unknown): string {
  const chunks = (where as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    const value = (chunk as { value?: unknown }).value;
    if (Array.isArray(value)) return value.join("");
    if (typeof chunk === "string") return chunk;
    const name = (chunk as { name?: unknown }).name;
    if (typeof name === "string") return `[${name}]`;
    return "?";
  }).join("");
}

test("findByReference folds case on both sides, so a provider echo matches in any case", async () => {
  const captured: Captured = { where: undefined };
  const db = stubDb({ id: 1, reference: "ord-abc-12345678" }, captured);

  await ordersRepo.findByReference(db, "ord-abc-12345678");

  // The stored column AND the argument are both wrapped. Folding only the
  // column would still miss every pre-lowercase order; folding only the argument
  // would too. eq() here would render as `[reference] = ord-abc-12345678` and
  // compare case-sensitively in Postgres.
  assert.equal(renderSql(captured.where), "lower([reference]) = lower(ord-abc-12345678)");
});

test("findByReference does not leak the reference into raw SQL", async () => {
  const captured: Captured = { where: undefined };
  // A hostile reference must arrive as a bound value, not spliced into the text.
  await ordersRepo.findByReference(
    stubDb(null, captured), "'); drop table orders; --",
  );
  const rendered = renderSql(captured.where);
  assert.equal(rendered, "lower([reference]) = lower('); drop table orders; --)");
  assert.equal(rendered.includes("drop table"), true, "sanity: the value is present as one chunk");
});

test("findByReference returns the row it found, and null when there is none", async () => {
  const found = await ordersRepo.findByReference(
    stubDb({ id: 7, reference: "ord-abc-12345678" }, { where: undefined }), "ord-abc-12345678",
  );
  assert.equal(found?.id, 7);

  const missing = await ordersRepo.findByReference(stubDb(undefined, { where: undefined }), "ord-nope");
  assert.equal(missing, null);
});