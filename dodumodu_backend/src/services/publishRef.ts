// The public identity of one publish, and the fingerprint of what it contains.
//
// publishRef  "pub_" + 20 random hex chars (80 bits). Random rather than sequential on purpose: it is the
//             marker the storefront page carries, so it must be unguessable, never collide across
//             databases or environments, and mean nothing beyond "this exact snapshot".
// contentHash sha256 of the snapshot WITHOUT its timestamp. Two publishes of identical content have the
//             same hash, which is what lets publishing twice be a no-op instead of a second publish.

export function newPublishRef(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return "pub_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const PUBLISH_REF_PATTERN = /^pub_[0-9a-f]{20}$/;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export async function contentHashOf(payload: Record<string, unknown>): Promise<string> {
  const { publishedAt: _ignored, ...content } = payload;
  void _ignored;
  const data = new TextEncoder().encode(JSON.stringify(stable(content)));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
