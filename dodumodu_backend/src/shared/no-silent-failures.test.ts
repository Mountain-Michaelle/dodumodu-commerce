// Guards the "no silent failures" rule so it cannot quietly regress:
//   * no runtime source file may swallow an error with an empty `.catch(() => {})`
//     (use swallow()/swallowNull() from shared/logger so the fault reaches Cloudflare Workers Logs),
//   * wrangler.toml keeps Workers Logs (observability) switched on,
//   * the app's last-resort error handler logs the fault but returns a bland 500 to the client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "generated") walk(p, out); }
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("mfa-test-kit.ts")) out.push(p);
  }
  return out;
}

test("no runtime source file swallows errors with an empty catch callback", () => {
  const offenders: string[] = [];
  for (const f of walk(SRC)) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/\.catch\(\(\) => \{\}\)/.test(line)) offenders.push(`${f.replace(SRC, "src")}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "use swallow('event') from src/shared/logger.ts");
});

test("wrangler.toml keeps Workers Logs enabled", () => {
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");
  assert.match(toml, /\[observability\]\s*\nenabled\s*=\s*true/);
});

test("an unhandled fault is logged server-side and the client gets a bland 500 with no internals", async () => {
  const { app } = await import("../app");
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  let res: Response;
  try {
    // No DATABASE_URL in this env: the catalog route throws inside its handler.
    res = await app.request("/page-data/home?secret=1", { headers: { "cf-ray": "abc123-LOS" } }, { ENVIRONMENT: "sandbox" } as never);
  } finally { console.error = orig; }
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.equal(body, "Internal Server Error");
  const log = lines.find((l) => l.includes("unhandled_error"));
  assert.ok(log, "the fault is in the server log");
  assert.match(log!, /abc123-LOS/);
  assert.doesNotMatch(log!, /secret=1/, "query strings are never logged");
});
