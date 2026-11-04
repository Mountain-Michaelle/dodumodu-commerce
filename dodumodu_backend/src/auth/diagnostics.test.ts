import { test } from "node:test";
import assert from "node:assert/strict";
import { authCorrelationId, authFailureDiagnostic } from "./diagnostics";
test("auth diagnostics redact sensitive cause text and create a correlation ID", () => {
  const diagnostic = authFailureDiagnostic(
    {} as never,
    {
      code: "AUTH_DATABASE_REQUEST_FAILED",
      stage: "authentication.request",
      category: "dependency",
      cause: new Error("postgres://user:password@db.example.com/db?api_key=secret admin@example.com"),
    },
    authCorrelationId(),
  );

  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, /password/);
  assert.doesNotMatch(serialized, /db\.example\.com\/db/);
  assert.doesNotMatch(serialized, /admin@/);
  assert.match(diagnostic.correlationId, /^[a-z0-9]{24}$/i);
});
