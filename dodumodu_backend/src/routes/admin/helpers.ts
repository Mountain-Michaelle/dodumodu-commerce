import type { Context } from "hono";
import { z } from "zod";
import { requirePermission, type Permission, type Principal } from "../../auth/adminAuth";
import { ValidationError } from "../../shared/httpError";

// The small amount of ceremony every admin resource route repeats. It is here,
// rather than in each route module, so that "how does a route check permission
// and parse a body" is answered identically everywhere - and so that changing the
// answer is one edit rather than one edit per resource.

export type AdminContext = Context<{ Bindings: import("../../env").Env; Variables: { principal: Principal } }>;

/** Authorise, in one line, before any work happens. */
export function requirePermissionOf(c: AdminContext, permission: Permission): void {
  requirePermission(c.get("principal"), permission);
}

/** The operator's email, for the audit trail every write records. */
export function actorOf(c: AdminContext): string {
  return c.get("principal").email;
}

/**
 * Reads and validates a JSON body in one step, turning a schema failure into the
 * same ValidationError every other failure uses - so a malformed body produces a
 * 400 with per-field messages, identically, rather than each resource inventing
 * its own error shape.
 */
export async function readBody<T extends z.ZodTypeAny>(
  c: AdminContext,
  schema: T,
  what = "request",
): Promise<z.infer<T>> {
  const body = await c.req.json().catch(() => null);
  if (body === null) {
    throw new ValidationError(`That ${what} was not valid JSON`, { body: ["Send a JSON object"] });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // Field notes, keyed by form field, so the panel can put each reason beside
    // the box it belongs to instead of in a paragraph nobody reads. Zod reports a
    // field with no messages as absent, so the empty entries are dropped rather
    // than being sent on as a field with an empty list of problems.
    const fields = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
    const populated: Record<string, string[]> = {};
    for (const [field, messages] of Object.entries(fields)) {
      if (messages && messages.length > 0) populated[field] = messages;
    }
    throw new ValidationError("Check the highlighted fields", populated);
  }
  return parsed.data;
}

// The version the operator's form was rendered from. Absent means "no version
// supplied", which skips the guard - the parameter exists so a migration script
// or a fix-up tool is not forced to invent a timestamp to satisfy the form, while
// every panel edit sends one and is therefore protected.
const concurrencySchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullish(),
});

/** Reads expectedUpdatedAt out of an already-parsed body, or null when absent. */
export function expectedVersion(body: unknown): Date | null {
  const parsed = concurrencySchema.safeParse(body ?? {});
  if (!parsed.success || !parsed.data.expectedUpdatedAt) return null;
  return new Date(parsed.data.expectedUpdatedAt);
}
