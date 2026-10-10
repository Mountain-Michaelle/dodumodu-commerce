// Attack suite — spec §11. You are the attacker. Each test runs against a LIVE
// Worker (wrangler dev with ADMIN_AUTH_V2=1, ALLOW_TEST_IP=1) and records the
// result. Set BASE_URL to point at it; when unset the whole file skips, so CI
// without a Worker stays green.
//
//   BASE_URL=http://127.0.0.1:8787 node --test tests/auth/attack/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL;
const maybe = BASE ? test : test.skip;

// A cookie jar we thread through requests (flow / session / device cookies).
function jar() {
  const map = new Map();
  return {
    absorb(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() {
      return [...map].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    clear: () => map.clear(),
  };
}

async function call(path, { method = "POST", body, cookies, headers = {}, ip } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (ip) h["X-Test-IP"] = ip; // honored only when ALLOW_TEST_IP=1
  const cookieHeader = typeof cookies === "string" ? cookies : cookies?.header();
  if (cookieHeader) h["Cookie"] = cookieHeader;
  // Same-origin: the Worker's originGuard requires Origin === Host.
  h["Origin"] = BASE;
  const res = await fetch(BASE + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data, res };
}

// Read the emailed code from the test mailbox (ALLOW_TEST_IP=1 only).
async function readCode(email) {
  const res = await fetch(`${BASE}/auth/test/mailbox/${encodeURIComponent(email)}`);
  if (res.status !== 200) return null;
  const { text } = await res.json();
  const m = /Your code is ([0-9A-F!#$%&*+?]{10})/.exec(text ?? "");
  return m ? m[1] : null;
}

export { BASE, maybe, jar, call, readCode };
