import type { Context } from "hono";

export interface AuthDiagnostic {
  event: "auth_failure";
  code: string;
  stage: string;
  category: "configuration" | "dependency" | "cryptography" | "internal";
  correlationId: string;
  causeCategory: string;
  safeCause: string;
}

function causeCategory(cause: unknown): string {
  if (cause instanceof TypeError) return "TypeError";
  if (cause instanceof SyntaxError) return "SyntaxError";
  if (cause instanceof Error) return cause.name || "Error";
  return typeof cause;
}

function safeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return typeof cause === "string" ? cause.slice(0, 200) : "";
  const firstLine = cause.message.split(/\r?\n/, 1)[0].trim();
  return firstLine
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^@\s]+@[^/\s]+/gi, "[redacted-url]")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[redacted-email]")
    .replace(/(?:api[_-]?key|token|secret|password|otp|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 200);
}

export function authCorrelationId(): string {
  const entropy = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return entropy.replace(/[^a-z0-9]/gi, "").slice(-24).padStart(24, "0");
}

export function authFailureDiagnostic(
  _c: Context,
  error: {
    code?: string;
    stage?: string;
    category?: AuthDiagnostic["category"];
    cause?: unknown;
  },
  correlationId: string,
): AuthDiagnostic {
  return {
    event: "auth_failure",
    code: error.code ?? "AUTH_INTERNAL_FAULT",
    stage: error.stage ?? "unknown",
    category: error.category ?? "internal",
    correlationId,
    causeCategory: causeCategory(error.cause),
    safeCause: safeCause(error.cause),
  };
}

export function logAuthFailure(diagnostic: AuthDiagnostic): void {
  console.error("[auth]", JSON.stringify(diagnostic));
}
