# Admin auth v2 — attack report (spec §11)

Status: **suite written, pending a live run.** Every case below is implemented in
`tests/auth/attack/*.test.mjs` and skips cleanly when `BASE_URL` is unset, so CI
without a Worker stays green. To run for real:

```bash
# terminal 1 — the Worker under attack
cd dodumodu_backend
ADMIN_AUTH_V2=1 ALLOW_TEST_IP=1 DATABASE_URL=<neon-dev-branch> \
  wrangler dev            # or: npm run dev  (local Node entry also works)

# terminal 2 — the attacker
BASE_URL=http://127.0.0.1:8787 node --test tests/auth/attack/*.test.mjs
```

A second instance with `ADMIN_AUTH_V2=0` (point `BASE_URL_FLAG_OFF` at it) proves
the flag-off 404 contract. Record real counts in the table when run.

## How to run everything (spec §12)

```bash
cd dodumodu_backend
npm run typecheck
npm test                 # service + unit + integration (local PG)
npm run test:ui          # UI structural checks (no browser)
BASE_URL=... node --test tests/auth/attack/*.test.mjs   # attack suite (live Worker)
```

## Coverage (implemented; each records result/evidence/fix/re-test when run)

| # | Category | Case | File |
|---|---|---|---|
| 1 | Brute force | 60 parallel wrong OTP guesses → exactly allowed attempts, then 429 lock | bruteforce |
| 2 | Lockout abuse | Stranger on 30 IPs cannot lock the real user (R-NOLOCK 1) | bruteforce |
| 3 | Resilience | Fault shape: reject is 401/429, never 500; 503 `{retry:true}` refunded | bruteforce |
| 4 | Flow | One email's flow cookie cannot verify another's code | bruteforce |
| 5 | Stage | `/auth/session` from a non-`ready` flow → 401 | bruteforce |
| 6 | Device | Forged/random `__Host-did` alone grants no session | bruteforce |
| 7 | Authorization | Admin routes with no session → 401/403 | bruteforce |
| 8 | IP trust | `X-Forwarded-For`/`X-Real-IP` ignored; only CF-Connecting-IP / X-Test-IP | bruteforce |
| 9 | Web | Cross-origin JSON POST → 403 | web |
| 10 | Web | Missing Origin on unsafe method → 403 | web |
| 11 | Web | Wrong content-type → 415 | web |
| 12 | Web | `null` Origin → 403 | web |
| 13 | Enumeration | Unknown vs staff vs admin `/auth/request` → identical 202 body | web |
| 14 | Leaks | Test mailbox 404 for an unknown recipient | web |
| 15 | Web | SQL-injection strings in email → still 202, no 500 | web |
| 16 | Web | Oversized + malformed JSON → not 500 | web |
| 17 | Config | Security headers present (nosniff, frame-deny, CSP) | web |
| 18 | Config | Flag off → every new route 404, existing suite unchanged | web |

## Findings

_Fill in after a live run: found / fixed / re-tested, with evidence (status,
timing, response bodies) per case. The unit + integration suites already prove
the SQL-level invariants (replay guards, single-use backup codes, last-admin
guard, refund-never-below-zero, device single-claim) against local Postgres; the
attack suite proves the HTTP surface on top._

## Deferred (need operator resources)

- Neon **dev branch** `DATABASE_URL` + `.dev.vars` secrets for the live run.
- Argon2id CPU measurement on `wrangler dev` / a deployed preview Worker (§9).
- Playwright §10 browser flows (install `@playwright/test`, then run against the
  same Worker; the in-memory mailbox + `ALLOW_TEST_IP` read endpoint are ready).
- Real smoke sends to `delivered@resend.dev` / `bounced@resend.dev`.
