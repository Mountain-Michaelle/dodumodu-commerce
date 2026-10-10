// Only file allowed to call fetch(). orchestrate.js is the only caller of this file.
// API_BASE is injected into the page at build time (build/bundle.mjs). Empty
// means "same origin" — the local dev server serves the site and the API
// together, and so does a Worker route on your own domain. It is never a
// hardcoded host: the same file runs locally and in production.
const API_BASE = window.API_BASE || "";

export async function getPageData(slug) {
  const res = await fetch(`${API_BASE}/page-data/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`page-data failed: ${res.status}`);
  return res.json();
}

export async function createOrder(payload, idempotencyKey) {
  const res = await fetch(`${API_BASE}/create-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, idempotencyKey }),
  });

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }

  if (!res.ok) {
    const err = new Error(data?.error || `create-order failed: ${res.status}`);
    err.status = res.status;
    err.fields = data?.fields;
    throw err;
  }
  return data;
}
