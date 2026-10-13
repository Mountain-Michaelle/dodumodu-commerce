import type { Db } from "../db";

// A test database driver, so admin HTTP routes can be exercised end to end
// without a real PostgreSQL for every test run.
//
// What this does and does not fake is the important part:
//
//   - The HTTP layer is REAL. The app, the middleware, the authorization seam,
//     the validation schemas, the route handlers and the error envelope all run
//     exactly as they do in production. That is the part under test - a 401
//     because the seam refused, a 409 because a service threw ConflictError.
//   - The DATABASE LAYER is a small in-memory store that understands the handful
//     of shapes the repositories actually issue. Business logic is NOT faked: the
//     services above it are the real ones, so the delivery-transition rules, the
//     category deletion guard and the payment-override restrictions are genuinely
//     exercised rather than asserted about.
//
// The alternative - a live database for every test - makes the suite depend on a
// service that must be running, which is the dependency that makes people skip
// running tests. This keeps `npm test` self-contained; the SQL itself is
// verified separately against the local database (see the EXPLAIN step).
//
// Registered through the same registerDbDriver seam the real drivers use, so
// nothing in the app knows the difference.

export type Row = Record<string, unknown>;

/** Per-table storage, with a monotonically increasing id like a real serial. */
export class FakeDatabase {
  private tables = new Map<string, Row[]>();
  private sequences = new Map<string, number>();

  /**
   * Seeding is explicit: passing `seed` (re)places the table contents and
   * restarts the id sequence, so each test starts deterministic. Calling with
   * no `seed` is a READ — it must never reset the store, otherwise every
   * SELECT issued by a repository would wipe the rows the test just seeded.
   */
  table(name: string, seed?: Row[]): Row[] {
    if (seed !== undefined) {
      this.tables.set(name, structuredClone(seed));
      this.sequences.set(name, 0);
    } else if (!this.tables.has(name)) {
      this.tables.set(name, []);
      this.sequences.set(name, 0);
    }
    return this.tables.get(name)!;
  }

  rows(name: string): Row[] {
    return this.tables.get(name) ?? [];
  }

  nextId(name: string): number {
    const next = (this.sequences.get(name) ?? 0) + 1;
    this.sequences.set(name, next);
    return next;
  }
}

/** A fluent stand-in that records the plan and returns the stored rows. */
class FakeQuery {
  private limitCount?: number;
  private offsetCount?: number;

  constructor(
    private readonly db: FakeDatabase,
    private readonly tableName: string,
    private readonly operation: "select" | "insert" | "update" | "delete",
    private payload: unknown = undefined,
  ) {}

  values(payload: unknown): this { this.payload = payload; return this; }
  set(payload: unknown): this { this.payload = payload; return this; }
  limit(count: number): this { this.limitCount = count; return this; }
  offset(count: number): this { this.offsetCount = count; return this; }

  async returning(): Promise<Row[]> {
    const store = this.db.table(this.tableName);
    if (this.operation === "insert") {
      const row: Row = { id: this.db.nextId(this.tableName), ...(this.payload as Row) };
      const primary = this.tableName === "visitor_days"
        ? ["visitDate", "hashVersion", "ipHash"]
        : this.tableName === "visitor_analytics_meta" ? ["id"] : [];
      if (primary.length > 0 && store.some((existing) =>
        primary.every((key) => existing[key] === row[key]))) {
        return [];
      }
      store.push(row);
      return [row];
    }
    if (this.operation === "update") {
      return store.map((row) => Object.assign(row, this.payload as Row));
    }
    let result = [...store];
    if (this.offsetCount !== undefined) result = result.slice(this.offsetCount);
    if (this.limitCount !== undefined) result = result.slice(0, this.limitCount);
    return result;
  }

  // A query builder is thenable, because the repositories await it directly.
  then<T = Row[]>(onOk?: (rows: Row[]) => T | PromiseLike<T>): Promise<T | Row[]> {
    return this.returning().then(onOk as (rows: Row[]) => PromiseLike<T>);
  }
}

/** The drizzle table object carries its SQL name; that is how a call is routed.
 *  drizzle 0.36 keeps it under Symbol.for("drizzle:Name"), not a plain `.name`
 *  property - and on a table that has a `name` column the plain property is the
 *  COLUMN, not the table, so both have to be checked in order. */
const DRIZZLE_NAME = Symbol.for("drizzle:Name");
function tableNameOf(table: unknown): string {
  if (typeof table === "string") return table;
  const plain = (table as { name?: unknown } | null)?.name;
  if (typeof plain === "string") return plain;
  const named = (table as Record<symbol, unknown> | null)?.[DRIZZLE_NAME];
  return typeof named === "string" ? named : "";
}

/**
 * The driver handed to registerDbDriver.
 *
 * Predicates are RECORDED, not evaluated - a real SQL engine is not what these
 * tests are for. That is a real limitation, and it is why the tests here pin
 * BEHAVIOUR (which status came back, what the row ended up as) rather than
 * asserting on generated SQL. The SQL is verified against a real database in the
 * migration and EXPLAIN step instead.
 */
export function fakeDriver(db: FakeDatabase): (url: string) => Db {
  const select = () => {
    let query: FakeQuery | null = null;
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        query = new FakeQuery(db, tableNameOf(table), "select");
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      groupBy: () => chain,
      leftJoin: () => chain,
      innerJoin: () => chain,
      limit: (n: number) => { query?.limit(n); return chain; },
      offset: (n: number) => { query?.offset(n); return chain; },
      returning: () => (query ?? new FakeQuery(db, "", "select")).returning(),
    };
    // Awaiting the chain runs the query, which is what `await db.select()...`
    // does in every repository.
    return Object.assign(chain, {
      then: (onOk?: (rows: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
        (query ?? new FakeQuery(db, "", "select")).returning().then(onOk, onErr),
    });
  };

  const insert = (table: unknown) => {
    const query = new FakeQuery(db, tableNameOf(table), "insert");
    const chain: Record<string, unknown> = {
      values: (v: unknown) => { query.values(v); return chain; },
      onConflictDoNothing: () => chain,
      onConflictDoUpdate: () => chain,
      returning: () => query.returning(),
      then: (onOk?: (rows: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
        query.returning().then(onOk, onErr),
    };
    return chain;
  };

  const update = (table: unknown) => {
    const query = new FakeQuery(db, tableNameOf(table), "update");
    const chain: Record<string, unknown> = {
      set: (v: unknown) => { query.set(v); return chain; },
      where: () => chain,
      returning: () => query.returning(),
      then: (onOk?: (rows: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
        query.returning().then(onOk, onErr),
    };
    return chain;
  };

  const remove = (table: unknown) => {
    const query = new FakeQuery(db, tableNameOf(table), "delete");
    const chain: Record<string, unknown> = {
      where: () => chain,
      returning: () => query.returning(),
      then: (onOk?: (rows: Row[]) => unknown, onErr?: (reason: unknown) => unknown) =>
        query.returning().then(onOk, onErr),
    };
    return chain;
  };

  return () => ({ select, insert, update, delete: remove }) as unknown as Db;
}
