// The one place that turns a URL path (or a storage key) into a file on disk,
// for the local-only file server. Production never touches this: media is
// delivered from R2 through its public domain, and the site is served by
// Cloudflare Pages. Locally there is no such thing, so uploaded files live in a
// directory and have to be read from one — which is a filesystem, and a
// filesystem is where path traversal is possible. Hence this file.
//
// The rule everywhere below is the same: resolve first, then prove the result
// is still inside the root before touching it. Never check for ".." in the
// input and then trust the join — every encoding, separator and symlink is a
// way to make that check pass and still end up outside.
import { realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

/** Extension -> content type. An allowlist, not a guess from the bytes. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** True when `candidate` is `root` itself or lives under it. */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolves a key to an absolute path inside `root`, or null when the key is
 * unusable or points outside. Lexical only — it does not require the file to
 * exist, which is what makes it usable for a write path (see localBucket).
 */
export function resolveWithinRoot(root: string, requestedKey: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedKey);
  } catch {
    return null; // malformed percent-encoding
  }
  if (!decoded || decoded.includes("\0")) return null;
  // A URL path is always slash-separated. A backslash is a separator in disguise
  // on Windows, a drive letter is an absolute path, and a leading slash ignores
  // the root entirely — none of them can appear in a legitimate R2 key.
  if (decoded.includes("\\") || decoded.startsWith("/") || /^[a-zA-Z]:/.test(decoded)) return null;

  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...decoded.split("/"));
  if (!isInside(resolvedRoot, target)) return null; // "..", "a/../../b", ...
  return target;
}

/**
 * The read path: the resolved file, or null for "not found". Malformed
 * encodings, escapes and anything that is not a regular file all return null,
 * so callers answer 404 uniformly and a probe cannot tell "you tried to escape"
 * apart from "that file does not exist".
 */
export function resolveMediaPath(root: string, requestedKey: string): string | null {
  const target = resolveWithinRoot(root, requestedKey);
  if (!target) return null;

  try {
    if (!statSync(target).isFile()) return null; // no directory listings
  } catch {
    return null; // missing
  }

  // A file inside the root can still be a symlink pointing out of it. Compare
  // the fully resolved paths, not the ones we constructed.
  try {
    const realRoot = realpathSync(resolve(root));
    const realTarget = realpathSync(target);
    if (!isInside(realRoot, realTarget)) return null;
    return realTarget;
  } catch {
    return null;
  }
}