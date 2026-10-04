// Proves the local/production boundary instead of trusting it.
//
// The Worker bundle is built from src/index.ts and nothing else, so anything
// that file can reach is what ships. This walks the real import graph and
// fails if a Node-only module, a Node-only package or the `pg` driver became
// reachable from production. It is the check that lets the rest of the local
// runtime exist in the same repository without any risk of leaking.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = dirname(fileURLToPath(import.meta.url));

/** Every module specifier a file names: `import ... from "x"`, `export ... from "x"`, `import "x"`. */
function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/(?:\bfrom|\bimport)\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolves a relative specifier the way the bundler would. */
function resolveRelative(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

type Graph = { files: string[]; packages: Set<string> };

/** Breadth-first walk of the import graph, collecting local files and package names. */
function importGraphFrom(entry: string): Graph {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(file)) {
      const local = resolveRelative(file, specifier);
      if (local) {
        queue.push(local);
      } else if (!specifier.startsWith(".")) {
        packages.add(specifier);
      }
    }
  }
  return { files: [...seen].map((file) => relative(srcRoot, file).replace(/\\/g, "/")), packages };
}

const workerEntry = resolve(srcRoot, "index.ts");
const nodeEntry = resolve(srcRoot, "node.ts");

test("the production entry point is src/index.ts, as wrangler.toml declares", () => {
  assert.ok(isFile(workerEntry), "src/index.ts must exist — it is `main` in wrangler.toml");
});

test("nothing local is reachable from the Worker entry point", () => {
  const graph = importGraphFrom(workerEntry);
  const localModules = graph.files.filter((file) => file.startsWith("node/") || file === "node.ts");
  assert.deepEqual(localModules, [], "local-only modules reachable from the Worker entry");
  // The local runtime is genuinely present, just not on this side of the line.
  assert.ok(isFile(nodeEntry), "src/node.ts should exist — this is what makes the exclusion meaningful");
});

test("no Node-only package is reachable from the Worker entry point", () => {
  const graph = importGraphFrom(workerEntry);
  const offenders = [...graph.packages].filter((name) =>
    name === "pg" || name.startsWith("pg/") ||
    name === "@hono/node-server" || name.startsWith("@hono/node-server/") ||
    name.startsWith("node:")
  );
  assert.deepEqual(offenders, [], "Node-only packages would be bundled into the Worker");
});

test("the Worker entry point uses the Neon driver and the shared app", () => {
  const graph = importGraphFrom(workerEntry);
  assert.ok(graph.files.includes("dbDrivers/neon.ts"), "Neon driver must be registered by the Worker entry");
  assert.ok(graph.files.includes("app.ts"), "the Worker serves the same app as the local runtime");
  assert.ok(graph.files.includes("db.ts"), "createDb comes from the shared adapter");
  assert.ok(!graph.packages.has("pg"), "pg must not be in the production graph");
});

test("the local entry point wires the pg driver, the shims and the file server", () => {
  const graph = importGraphFrom(nodeEntry);
  for (const expected of [
    "app.ts",            // the same app
    "db.ts",             // the same adapter
    "dbDrivers/pg.ts",   // TCP driver instead of Neon's HTTP one
    "node/shims.ts",     // R2 and KV stand-ins
    "node/static.ts",    // the local file server
    "node/mediaPath.ts", // its traversal guard
    "node/envFile.ts",   // root .env
  ]) {
    assert.ok(graph.files.includes(expected), `expected the local entry to reach ${expected}`);
  }
});