/**
 * Postgres error details, whether or not the driver error is wrapped.
 *
 * drizzle-orm >= 0.44 wraps driver failures in `DrizzleQueryError` ("Failed query: ...") and keeps
 * the real Postgres error (SQLSTATE `code`, constraint text) on `.cause`. Code that decides what to
 * do from a SQLSTATE or constraint name must therefore look through the whole cause chain.
 */
export type DbErrorInfo = { code?: string; message: string };

export function dbErrorInfo(error: unknown): DbErrorInfo {
  let code: string | undefined;
  const messages: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (!code && typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) code = e.code;
    if (typeof e.message === "string") messages.push(e.message);
    cur = e.cause;
  }
  return { code, message: messages.join(" | ") };
}
