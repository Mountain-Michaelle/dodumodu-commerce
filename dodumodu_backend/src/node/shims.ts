// Local stand-ins for the two Cloudflare bindings the app needs. This whole
// directory is LOCAL ONLY: it is reachable from src/node.ts and from nothing
// else, so none of it is in the Worker bundle (src/isolation.test.ts proves it).
//
// Each shim implements only what the app actually calls — the point is to run
// the real code offline, not to re-create Cloudflare. When the real binding is
// missing locally, the symptom should be a clear error, never a silent
// difference in behaviour between the two environments.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveWithinRoot } from "./mediaPath";

/**
 * The tripwire. These shims exist for local development; a production
 * configuration running them would silently write to a local directory and
 * count rate limits in memory while believing it is talking to R2 and KV. So
 * refuse to start, and say why. Production runs on the Worker.
 */
function assertLocalOnly(what: string): void {
  if (process.env.ENVIRONMENT === "production") {
    throw new Error(
      `${what} is a local development stand-in and refuses to run with ENVIRONMENT=production. ` +
      "Production runs on the Cloudflare Worker (wrangler deploy), where the real R2 and KV bindings are provided.",
    );
  }
}

type MemoryEntry = { value: string; expiresAt: number };

/**
 * Rate limiting for local runs. The real thing is a Workers KV namespace with
 * a TTL; this keeps the same three calls (get / put with expirationTtl /
 * delete) in a Map, and expires entries the same way, so rateLimit.ts is the
 * identical code in both environments.
 */
export function memoryKV(): KVNamespace {
  assertLocalOnly("The in-memory KV shim");

  const store = new Map<string, MemoryEntry>();

  const shim = {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      const ttl = options?.expirationTtl;
      store.set(key, {
        value,
        expiresAt: ttl ? Date.now() + ttl * 1000 : Number.POSITIVE_INFINITY,
      });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };

  // KVNamespace declares far more than these three methods. The cast is
  // deliberate and scoped to this one function — the app calls nothing else.
  return shim as unknown as KVNamespace;
}

async function toBytes(body: ReadableStream | ArrayBuffer | Uint8Array | string): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Object storage as a directory, for local runs. R2 has no directory
 * hierarchy — a key is just a name — so the shim creates the directories the
 * key implies, and every key still has to resolve inside the root, on the way
 * in as well as on the way out. r2Client hands us keys built partly from a
 * client-supplied filename, which is exactly the input that must not be
 * trusted to stay inside the root.
 */
export function localBucket(root: string): R2Bucket {
  assertLocalOnly("The filesystem R2 shim");

  const base = resolve(root);
  mkdirSync(base, { recursive: true });

  const targetFor = (key: string): string => {
    const target = resolveWithinRoot(base, key);
    if (!target) throw new Error(`Refusing to use storage key outside the media root: ${key}`);
    return target;
  };

  const shim = {
    async put(key: string, body: ReadableStream | ArrayBuffer, _options?: unknown): Promise<unknown> {
      const target = targetFor(key);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, await toBytes(body as ReadableStream | ArrayBuffer));
      return { key };
    },
    async delete(key: string): Promise<void> {
      rmSync(targetFor(key), { force: true });
    },
  };

  // R2Bucket is a large interface; only put/delete are called (r2Client.ts).
  return shim as unknown as R2Bucket;
}