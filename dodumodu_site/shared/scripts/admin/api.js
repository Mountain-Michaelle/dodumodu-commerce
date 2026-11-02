import { track } from "./dm.js";

// The only module that talks to the API.
//
// Every admin endpoint answers a failure with the same envelope:
//   { "error": { "code": "...", "message": "..." }, "fields"?, "action"?, "current"? }
// `code` is for this code to branch on and `message` is for the operator to read.
// Branching on the message would break the first time the wording is improved, so
// nothing here matches on English text.

const API_BASE = (typeof window !== "undefined" && window.API_BASE) || "";
const ADMIN_BASE = (typeof window !== "undefined" && window.ADMIN_BASE_PATH) || "/admin";

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    // Field notes keyed by form field, so a form can put each reason beside the
    // box it belongs to instead of in one paragraph at the top.
    this.fields = extra.fields || null;
    this.action = extra.action || null;
    this.current = extra.current;
  }

  /** True when the row moved under the operator and the only fix is to reload it. */
  get isConflict() { return this.status === 409 && this.code === "RECORD_CONFLICT"; }
  get isValidation() { return this.status === 400; }
  get isNotFound() { return this.status === 404; }
  get isForbidden() { return this.status === 403; }
  get isUnauthorized() { return this.status === 401; }
}

/** Builds a query string, dropping empty values so ?status= never reaches SQL. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function request(path, { method = "GET", body, formData, signal } = {}) {
  const init = { method, headers: {}, signal };
  if (formData) {
    // Deliberately NOT setting Content-Type: the browser has to add the multipart
    // boundary itself, and setting it by hand produces a body the server cannot
    // parse.
    init.body = formData;
  } else if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  // Every admin request moves the top-bar logo while it is pending (§4d).
  const fetchNow = () => fetch(`${API_BASE}${ADMIN_BASE}${path}`, init);

  let res;
  try {
    res = await track(fetchNow());
  } catch (err) {
    // An abort is a REQUEST WE CANCELLED, not a failure to reach the server, and the
    // two must not look alike. A cancelled search is the normal case when someone
    // keeps typing - the previous term's request is superseded before it lands.
    // Reporting it as a network error would show "Could not reach the server" under
    // a search box that is working perfectly, and the panel would have to be
    // taught to recognise its own cancellations by their wording.
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "Could not reach the server. Check your connection and try again.");
  }

  if (res.status === 204) return null;

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }

  if (!res.ok) {
    const error = (payload && payload.error) || {};
    // `error` is sometimes a string rather than the envelope - a hand-written
    // 400 in a route, or a non-JSON body. Both are handled rather than crashing
    // the panel on `error.message` of a string.
    const message = typeof error === "string"
      ? error
      : (error.message || `Request failed (${res.status})`);
    const code = typeof error === "string" ? "ERROR" : (error.code || "ERROR");
    throw new ApiError(res.status, code, message, payload || {});
  }

  return payload;
}

export const api = {
  get: (path, signal) => request(path, { signal }),
  post: (path, body) => request(path, { method: "POST", body }),
  put: (path, body) => request(path, { method: "PUT", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
  del: (path, body) => request(path, { method: "DELETE", body }),
  upload: (path, formData) => request(path, { method: "POST", formData }),
};

/**
 * The v2 auth API. Same session-cookie model as the auth pages, but rooted
 * at /admin-v2 (ADMIN_BASE) instead of /auth. Every route is admin-guarded
 * server-side; a non-admin gets 401/403 and the caller renders accordingly.
 */
async function v2request(path, { method = "GET", body } = {}) {
  const init = { method, headers: { "Content-Type": "application/json" }, credentials: "same-origin" };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(`${API_BASE}${ADMIN_BASE}/admin-v2${path}`, init);
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the server. Check your connection and try again.");
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const message = typeof error === "string" ? error : (error.message || `Request failed (${res.status})`);
    const code = typeof error === "string" ? "ERROR" : (error.code || "ERROR");
    throw new ApiError(res.status, code, message, payload || {});
  }
  return payload;
}

export const v2api = {
  get: (path) => v2request(path),
  post: (path, body) => v2request(path, { method: "POST", body }),
  patch: (path, body) => v2request(path, { method: "PATCH", body }),
  put: (path, body) => v2request(path, { method: "PUT", body }),
  del: (path) => v2request(path, { method: "DELETE" }),
};

/** The signed-in operator and what they may do. Drives which buttons exist. */
export async function loadIdentity() {
  return api.get("/me");
}

/**
 * The v2 session identity (role, perms, stepup state, perms version).
 * Lives on /auth/me and is mounted at AUTH_BASE outside the /admin prefix,
 * so it goes through fetch() directly. Absent/unreachable (flag off, no
 * session) resolves to null — the caller falls back to the v1 shape.
 */
export async function loadV2Identity() {
  try {
    const res = await fetch(`${API_BASE}${ADMIN_BASE}/auth/me`, { credentials: "same-origin" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
