/**
 * "The database is behind the code."
 *
 * A migration that has not been run makes every query touching its new column or table fail inside Postgres
 * (SQLSTATE 42703 undefined_column, 42P01 undefined_table). Left alone that surfaces as an anonymous 500 on every
 * admin page that reads the table - indistinguishable from a bug. This recognises that one cause so the operator is
 * told what to do, and so the log names it.
 *
 * Drizzle wraps the driver error ("Failed query: ...") and keeps the original on `.cause`, so the whole chain is
 * walked. Only the SQLSTATE and the message are read; nothing from the query or its parameters is returned.
 */
const SCHEMA_CODES = new Set(["42703", "42P01"]);
const SCHEMA_MESSAGE = /(column|relation) "?[\w.]+"? .*does not exist|does not exist.*(column|relation)/i;

export function isSchemaBehind(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth += 1) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === "string" && SCHEMA_CODES.has(e.code)) return true;
    if (typeof e.message === "string" && SCHEMA_MESSAGE.test(e.message) && !/^Failed query/i.test(e.message)) return true;
    cur = e.cause;
  }
  return false;
}

export const SCHEMA_BEHIND_MESSAGE =
  "The database has not been updated for this version yet. Run `npm run db:migrate` against it, then reload.";
