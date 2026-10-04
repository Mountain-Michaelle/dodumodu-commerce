import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { parseListQuery, pageMeta, normalizeSearch, likePattern } from "./listQuery";

/* Every admin table is paged, searched, filtered and sorted server-side, and these
   four things are the only reason that is true. They are worth pinning because
   each one is a way for a URL to reach the database, and a mistake in any of them
   is either a data leak (returning every order) or a denial of service. */

const filters = z.object({ status: z.enum(["paid", "failed"]).optional() });
const SORTABLE = ["createdAt", "amount"] as const;

test("defaults are applied when the query string says nothing", () => {
  const query = parseListQuery({}, { filters, sortable: SORTABLE, defaultSort: "createdAt" });
  assert.ok(query);
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 20);
  assert.equal(query.limit, 20);
  assert.equal(query.offset, 0);
  assert.equal(query.search, "");
  assert.equal(query.sort.field, "createdAt");
  assert.equal(query.sort.direction, "desc");
});

test("page size is bounded, so a URL cannot ask for the whole table", () => {
  // This is the control that keeps "server-side" honest. Without a ceiling, ?pageSize
  // =100000 is a request to download every customer's name, phone and address.
  const tooBig = parseListQuery({ pageSize: "100000" }, { filters, sortable: SORTABLE, defaultSort: "amount" });
  assert.equal(tooBig, null, "an out-of-range page size is a caller error, not a clamp");

  const atMax = parseListQuery({ pageSize: "100" }, { filters, sortable: SORTABLE, defaultSort: "amount" });
  assert.equal(atMax?.pageSize, 100);
});

test("offset is derived from the page, so page 3 starts at the right row", () => {
  const query = parseListQuery({ page: "3", pageSize: "50" }, { filters, sortable: SORTABLE, defaultSort: "amount" });
  assert.equal(query?.offset, 100);
  assert.equal(query?.limit, 50);
});

test("an unrecognised sort field is ignored rather than rejected", () => {
  // A stale bookmark to ?sort=old_column should list rows, not fail. The caller
  // picks an ordering; it never names a column.
  const query = parseListQuery({ sort: "not_a_column" }, {
    filters, sortable: SORTABLE, defaultSort: "amount", defaultOrder: "asc",
  });
  assert.equal(query?.sort.field, "amount");
  assert.equal(query?.sort.direction, "asc");
});

test("a malformed filter is rejected, because a nonsense filter is a caller error", () => {
  const query = parseListQuery({ status: "not_a_status" }, { filters, sortable: SORTABLE, defaultSort: "amount" });
  assert.equal(query, null);
});

test("filters are parsed and unknown query keys are ignored", () => {
  const query = parseListQuery({ status: "paid", somethingElse: "x" }, {
    filters, sortable: SORTABLE, defaultSort: "amount",
  });
  assert.equal(query?.filters.status, "paid");
});

test("a hostile sort field never reaches the column chooser", () => {
  const query = parseListQuery({ sort: "createdAt); drop table orders; --" }, {
    filters, sortable: SORTABLE, defaultSort: "amount",
  });
  // Falls back to the default, and the text is never used.
  assert.equal(query?.sort.field, "amount");
});

test("pageMeta is derived from the count the query ran, not the page length", () => {
  const meta = pageMeta({ page: 2, pageSize: 20 }, 95);
  assert.equal(meta.totalPages, 5);
  assert.equal(meta.hasNext, true);
  assert.equal(meta.hasPrev, true);
  // The last page is usually short; a UI that infers "is there more" from a short
  // page shows a dead-end next button, which is why this comes from the total.
  const last = pageMeta({ page: 5, pageSize: 20 }, 95);
  assert.equal(last.hasNext, false);
});

test("an empty result still reports one page, not zero", () => {
  const meta = pageMeta({ page: 1, pageSize: 20 }, 0);
  assert.equal(meta.totalPages, 1);
  assert.equal(meta.hasNext, false);
  assert.equal(meta.hasPrev, false);
});

test("a one-character search term is dropped rather than run", () => {
  // "a" across three text columns returns nearly every row and reads as a search
  // that is broken.
  assert.equal(normalizeSearch("a"), null);
  assert.equal(normalizeSearch("  "), null);
  assert.equal(normalizeSearch("ab"), "ab");
  assert.equal(normalizeSearch("  Enugu "), "enugu");
});

test("LIKE wildcards in a search term are escaped, not obeyed", () => {
  // Without escaping, searching "100%" matches every row, because % is a wildcard.
  assert.equal(likePattern("100%"), "%100\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
  assert.equal(likePattern("plain"), "%plain%");
});
