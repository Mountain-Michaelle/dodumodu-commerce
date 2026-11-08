export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Digits only, max 6: handles "123 456", pasted dashes, autofill noise. */
export function normalizeTotpInput(raw) {
  return String(raw ?? "").replace(/\D/g, "").slice(0, 6);
}

/** Retries only on network failure / 502 / 503 / 504, never on 4xx. */
export async function api(path, body, opts = {}) {
  const { retries = 0, timeoutMs = 8000, fetchImpl = globalThis.fetch, sleepImpl = sleep } = opts;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      let data = {};
      try { data = await res.json(); } catch { /* empty body */ }
      if ([502, 503, 504].includes(res.status) && attempt < retries) {
        await sleepImpl(400 * 3 ** attempt);
        continue;
      }
      return { status: res.status, data };
    } catch {
      clearTimeout(timer);
      if (attempt < retries) { await sleepImpl(400 * 3 ** attempt); continue; }
      return { status: 0, data: { error: "Unable to reach the server. Check your connection and try again." } };
    }
  }
}