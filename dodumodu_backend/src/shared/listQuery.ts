import { z } from "zod";

// Every admin list is the same four things - a search, a filter, a sort and a
// page - and every one of them is a way for a URL to reach the database. Doing
// them once, here, is what keeps "server-side" true: a page size accepted from a
// query string is a page size that can be raised to 100,000 by anyone who types
// it.
//
// Sort fields are an allowlist per resource rather than a column name from the
// client. A caller chooses which ordering it wants; it never names a column.

const page = z.coerce.number().int().min(1).max(10_000).default(1);
// The ceiling is the whole point of parsing this here rather than per route:
// ?pageSize=100000 on the orders table is a request to download every customer's
// name, phone number and address. 1000 is the largest size the panel offers, and
// a caller asking for more is refused rather than clamped - a silently reduced
// page looks like missing rows.
const pageSize = z.coerce.number().int().min(1).max(1000).default(20);
const rawSearch = z.string().trim().max(120).optional();
const rawSort = z.string().trim().max(40).optional();
const rawOrder = z.enum(["asc", "desc"]).optional();

export type SortSpec = { field: string; direction: "asc" | "desc" };

export type ParsedListQuery<TFilters> = {
  search: string;
  filters: TFilters;
  sort: SortSpec;
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
};

/**
 * The filters schema owns its own keys and ignores the rest of the query string,
 * so adding a filter is a schema edit and nothing else. It returns null when the
 * filters are malformed, which is the route's cue for a 400: a nonsense filter is
 * a caller error, not a server fault.
 */
export function parseListQuery<TFilters extends object>(
  raw: Record<string, string | undefined>,
  opts: {
    filters: z.ZodType<TFilters>;
    sortable: readonly string[];
    defaultSort: string;
    defaultOrder?: "asc" | "desc";
  },
): ParsedListQuery<TFilters> | null {
  const filters = opts.filters.safeParse(raw);
  if (!filters.success) return null;

  const parsed = z
    .object({ q: rawSearch, sort: rawSort, order: rawOrder, page, pageSize })
    .safeParse({ q: raw.q, sort: raw.sort, order: raw.order, page: raw.page, pageSize: raw.pageSize });
  // safeParse, not parse: an out-of-range page or page size is a caller error, and
  // a thrown ZodError here escapes as a 500 rather than the 400 the contract
  // promises. Returning null is what lets the route answer 400.
  if (!parsed.success) return null;
  const { q, sort: requestedSort, order: requestedOrder, page: pageNo, pageSize: size } = parsed.data;

  // An unrecognised sort is ignored rather than rejected: a stale bookmark to
  // ?sort=old_column should list rows, not fail.
  const field = requestedSort && opts.sortable.includes(requestedSort) ? requestedSort : opts.defaultSort;
  const direction = requestedOrder ?? opts.defaultOrder ?? "desc";

  return {
    search: q ?? "",
    filters: filters.data,
    sort: { field, direction },
    page: pageNo,
    pageSize: size,
    limit: size,
    offset: (pageNo - 1) * size,
  };
}

export type PageMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

/**
 * Derived from the count the query actually ran, never from the length of the
 * page: an empty last page still has to report the pages before it, and a UI that
 * infers "is there more" from a short page shows a dead-end next page.
 */
export function pageMeta(query: { page: number; pageSize: number }, total: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    totalPages,
    hasNext: query.page < totalPages,
    hasPrev: query.page > 1,
  };
}

/**
 * Trims the term and reports whether it is usable. An empty string is a plain
 * listing, not a match on everything; a term shorter than the floor is dropped
 * rather than run, because two characters across three text columns returns
 * almost every row and reads as a search that is broken.
 */
export function normalizeSearch(value: string, min = 2): string | null {
  const term = value.trim().toLowerCase();
  if (term.length < min) return null;
  return term;
}

/**
 * Escapes what LIKE treats as wildcards, so a search for "100%" matches those
 * characters instead of every row. Pair it with lower() on both sides, which is
 * also what a phone prefix match needs.
 */
export function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (matched) => `\\${matched}`);
  return `%${escaped}%`;
}
