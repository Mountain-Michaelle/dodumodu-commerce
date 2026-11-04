// Auth-path errors. The shared src/shared/httpError.ts models only the admin
// CRUD surface (400/404/409). The auth path needs 401/429/503, which it maps to
// HTTP statuses in src/auth/routes.ts. Kept here so the shared file is untouched
// (spec §2.5: smallest footprint in shared files).

// A factor was wrong, an email is unknown, a code expired/used, a device was
// denied or a flow is at the wrong stage. All of these MUST produce the same
// neutral body (spec §5.7 "the same 401 body"), so this carries no
// client-visible message — only a short audit reason that never reaches the wire.
export class AuthRejectError extends Error {
  constructor(readonly reason: string) {
    super("Invalid or expired code");
    this.name = "AuthRejectError";
  }
}

// The pair / device / strict lock is active. 429 with a server-driven countdown.
export class AuthLockedError extends Error {
  constructor(readonly retryAfterSecs: number) {
    super("locked");
    this.name = "AuthLockedError";
  }
}

// A server fault of ours AFTER a reservation was made (DB error, timeout,
// exception). The caller MUST call auth_refund and answer 503 {retry:true}
// (R-NOLOCK 3: never 401 for a fault; a Worker killed mid-request cannot refund).
export class AuthServerFaultError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly category: "configuration" | "dependency" | "cryptography" | "internal";

  constructor(
    cause?: unknown,
    options: {
      code?: string;
      stage?: string;
      category?: "configuration" | "dependency" | "cryptography" | "internal";
    } = {},
  ) {
    super("server fault in auth path");
    this.name = "AuthServerFaultError";
    if (cause !== undefined) this.cause = cause;
    this.code = options.code ?? "AUTH_INTERNAL_FAULT";
    this.stage = options.stage ?? "unknown";
    this.category = options.category ?? "internal";
  }
}

// Authorization failures on protected routes. 401 = no/expired session;
// 403 = authenticated but lacking the permission or a fresh step-up.
export class AuthUnauthorizedError extends Error {
  constructor(message = "Not authenticated") {
    super(message);
    this.name = "AuthUnauthorizedError";
  }
}

export class AuthForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "AuthForbiddenError";
  }
}

// A TOTP/phrase/backup factor was wrong AND the flow has crossed the threshold
// that unlocks recovery (spec §4.3: 3 TOTP fails). Maps to 401 with a uniform
// body that ALSO carries recovery_available:true — the ONLY extra field, and it
// reveals nothing about the account (it is a property of THIS flow's own
// counter, which the caller already owns). The UI shows the recovery link only
// when this is true; the server still enforces it regardless.
export class AuthRecoverableError extends Error {
  constructor(readonly reason: string) {
    super("Invalid code");
    this.name = "AuthRecoverableError";
  }
}
