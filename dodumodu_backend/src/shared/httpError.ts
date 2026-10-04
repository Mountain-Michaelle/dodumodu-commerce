// The one place an error becomes an HTTP status.
//
// A repository or service that returns a bare string cannot say which status the
// caller owes, and a route that guesses produces the two failures this exists to
// prevent: a validation problem answered as a 500, so the operator never sees
// what to fix, and a conflict answered as a 400, so the panel never learns that
// somebody else reached the row first.
//
// Anything thrown that is not one of these keeps travelling, which is what
// app.ts's onError is for: an unexpected fault stays a 500 with no internals in
// the body, and stays visible in the logs.
export class NotFoundError extends Error {
  constructor(
    readonly resource: string,
    readonly id: string | number,
  ) {
    super(`${resource} ${id} does not exist`);
    this.name = "NotFoundError";
  }
}

// The input is well-formed JSON and wrong. Deliberately not called "invalid": a
// conflict is a rejection too, and the two need different statuses. This one is
// fixed by editing the form; the other one by reloading the row.
export class ValidationError extends Error {
  constructor(
    message: string,
    // Field notes keyed by form field, so a panel can put the reason beside the
    // box it belongs to instead of in a paragraph nobody reads.
    // A field can carry more than one problem ("must be a URL" AND "too long"), and
    // zod already reports them as a list, so this is a list here too rather than a
    // string that quietly drops every message after the first.
    readonly fields?: Record<string, string | string[]>,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

// The row is not what the caller believed it to be: not the state a transition
// requires, or not the version an optimistic edit expected. 409 plus a fresh copy
// is the only honest answer. "We saved your change over theirs" is never
// acceptable, and a retry that resends the same expected value can never succeed.
export class ConflictError extends Error {
  constructor(
    message: string,
    // What the caller can do next. "reload" means the actions to offer are decided
    // by the freshly-read row, not by the one that was just rejected.
    readonly action: "reload" | "refresh-list" | "none" = "reload",
    readonly current?: unknown,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * The error envelope every admin route returns.
 *
 * `code` is for the panel to branch on and `message` is for the operator to read.
 * They are separate because a panel that has to string-match an English sentence
 * to decide whether to show a reload button breaks the moment the wording changes,
 * and because the two have different audiences: the code is API surface, the
 * message is copy.
 */
export type ErrorEnvelope = {
  error: { code: string; message: string };
  fields?: Record<string, string | string[]>;
  action?: string;
  current?: unknown;
};

export type ErrorShape = { status: 400 | 404 | 409; body: ErrorEnvelope };

/**
 * The single mapping every admin route funnels through, so one fault always
 * produces one status and one body shape. Returns null for anything that is not
 * ours, which the caller must rethrow rather than translate.
 */
export function errorShape(err: unknown): ErrorShape | null {
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: { code: "NOT_FOUND", message: err.message } } };
  }
  if (err instanceof ValidationError) {
    return {
      status: 400,
      body: {
        error: { code: "VALIDATION_ERROR", message: err.message },
        ...(err.fields ? { fields: err.fields } : {}),
      },
    };
  }
  if (err instanceof ConflictError) {
    return {
      status: 409,
      body: {
        // RECORD_CONFLICT rather than a generic 409, because the panel's response
        // to a lost update is different from its response to "a product is still in
        // this category": one offers a reload, the other offers a reason.
        error: { code: err.action === "none" ? "CONFLICT" : "RECORD_CONFLICT", message: err.message },
        ...(err.action === "none" ? {} : { action: err.action }),
        ...(err.current === undefined ? {} : { current: err.current }),
      },
    };
  }
  return null;
}