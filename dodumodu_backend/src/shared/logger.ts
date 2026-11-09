// One place for server-side fault logging.
//
// On Cloudflare, console.error output lands in Workers Logs (see [observability] in
// wrangler.toml) and `wrangler tail`; it is never part of an HTTP response. Every
// best-effort path that used to end in an empty catch callback goes through here instead, so
// a failing email provider, a refused DB write or an undecryptable secret leaves a
// line in the logs while the caller still gets its uniform, non-leaking response.
//
// Rules this module enforces:
//   * never throws (logging must not turn a handled fault into an outage),
//   * secrets and personal data are scrubbed before they are written
//     (DB URLs, bearer tokens, Resend keys, email addresses, long hex/base64 tokens),
//   * only flat primitive fields are accepted, so a request body can't be logged by accident.

type Primitive = string | number | boolean | null | undefined;
export type LogFields = Record<string, Primitive>;

const REDACTIONS: Array<[RegExp, string]> = [
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\bre_[A-Za-z0-9_]{8,}/g, "[redacted-key]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "[hex]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[token]"],
];

/** Remove secrets/PII from free text and cap its length. */
export function scrub(text: string, max = 400): string {
  let out = String(text);
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function describe(err: unknown): { name: string; message: string; stack?: string } | null {
  if (err === undefined || err === null) return null;
  if (err instanceof Error) {
    const stack = err.stack?.split("\n").slice(1, 5).map((l) => l.trim()).join(" | ");
    return { name: err.name, message: scrub(err.message), ...(stack ? { stack: scrub(stack, 600) } : {}) };
  }
  return { name: typeof err, message: scrub(typeof err === "string" ? err : JSON.stringify(err) ?? String(err)) };
}

/** Log one fault as a single JSON line. Safe to call anywhere; never throws. */
export function logError(event: string, err?: unknown, fields: LogFields = {}): void {
  try {
    const flat: Record<string, Primitive> = {};
    for (const [k, v] of Object.entries(fields)) {
      flat[k] = typeof v === "string" ? scrub(v, 200) : v;
    }
    const error = describe(err);
    console.error(JSON.stringify({ level: "error", event, ...(error ? { error } : {}), ...flat }));
  } catch {
    /* logging must never break the request */
  }
}

/** Expected-but-worth-seeing events (e.g. a 401 and WHY). Same scrubbing, level "warn". */
export function logWarn(event: string, fields: LogFields = {}): void {
  try {
    const flat: Record<string, Primitive> = {};
    for (const [k, v] of Object.entries(fields)) flat[k] = typeof v === "string" ? scrub(v, 200) : v;
    console.warn(JSON.stringify({ level: "warn", event, ...flat }));
  } catch {
    /* logging must never break the request */
  }
}

/** `.catch(swallow("event"))`: best-effort work that must not fail the caller, but must not be silent. */
export function swallow(event: string, fields: LogFields = {}): (err: unknown) => void {
  return (err) => logError(event, err, fields);
}

/** Like swallow, for `.catch(() => null)` call sites that need a value back. */
export function swallowNull(event: string, fields: LogFields = {}): (err: unknown) => null {
  return (err) => {
    logError(event, err, fields);
    return null;
  };
}