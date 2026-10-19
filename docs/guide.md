# DODUMODU — Local Auth & UI Test Guide (docs/guide.md)

**Audience:** you, testing locally as a real user against the local backend.
**Scope:** the `ADMIN_AUTH_V2` auth flow (email code → phrase/TOTP → session → admin console), how to build + run everything locally, the live-email reality, first-admin setup, and an end-to-end walkthrough.

**Setup in one sentence:** everything still runs **locally** (`localhost:8787`), but **email is live through Resend** (a real code lands in the real inbox) and **TOTP needs a real authenticator app** (Google Authenticator, 1Password, Authy, …) — no mocks.

---

## 0. Before you touch a browser — local setup

Everything below assumes this local setup:

1. **Build the frontend** (from `dodumodu_site/` — this regenerates `dist/` that the backend serves):

   ```bash
   cd dodumodu_site
   npm install   # first time only
   npm run build
   ```

2. **Run the backend** (from `dodumodu_backend/` — one origin on `http://localhost:8787`, API + storefront + admin on the same port, so no CORS and `API_BASE` stays empty):

   ```bash
   cd dodumodu_backend
   npm install   # first time only
   npm run db:start    # local Postgres (Docker) — first time: npm run db:init
   npm run db:migrate  # apply migrations incl. 0019_admin_auth_v2.sql
   npm run dev         # tsx watch src/node.ts → http://localhost:8787
   ```

   Leave `npm run dev` running in its own terminal. Re-run `npm run build` in `dodumodu_site/` whenever you change the storefront.

3. **Admin auth is ON:** root `.env` has `ADMIN_AUTH_V2=1`. With the flag off, every new `/auth/*` + `/admin-v2/*` route returns `404`.
4. **Email is LIVE via Resend (required — still fully local):** everything still runs locally
   (`localhost:8787` + local Postgres), but the login code is a **real email** — root `.env` must have
   a real `RESEND_API_KEY`. The provider does a real `POST https://api.resend.com/emails` to the
   **real inbox** — check your email for the login code. Sends are fire-and-forget
   (`afterResponse`/`waitUntil`): the API already answered `202` before Resend succeeds or fails,
   and a failed send never changes the HTTP response. Keep `ALLOW_TEST_IP` **empty** for UI testing —
   `ALLOW_TEST_IP=1` switches to the in-memory dev mailbox (`GET /auth/test/mailbox/<email>`) with no
   real send, and is for automated tests only, not for clicking through the UI.
5. **TOTP needs a real authenticator app:** Google Authenticator (or 1Password / Authy / any
   TOTP-compatible app) on your phone. Scan the QR shown during TOTP enrolment, then type the
   6-digit code from the app. There is no local mock.
6. **Database is local:** `DATABASE_URL` in root `.env` points at your local Postgres
   (e.g. `postgresql://postgres@localhost:55432/dodumodu`). Migration `0019_admin_auth_v2.sql`
   must be applied (`npm run db:migrate`).
7. **Turnstile:** only on the two entry endpoints. Leave the keys empty locally and the challenge
   is skipped; production uses the real Cloudflare keys.

> The admin UI is served from the built `dodumodu_site/dist/`. It already renders the KPI widgets, the Live vs. Snapshot toggle, and the daily/monthly/yearly trend chart with pagination.

---

## 1. What a real user actually sees (auth UX)

**Local UI test setup (what you run to click through everything):**

```powershell
# 1. Build the storefront (from dodumodu_site/) — emits dist/ served by the backend
cd dodumodu_site
npm run build

# 2. Run the backend + storefront on one origin (from dodumodu_backend/)
cd ../dodumodu_backend
npm run dev
# → site   http://localhost:8787/
# → health http://localhost:8787/health → {"ok":true}/localhost:8787/
# → admin http://localhost:8787/admin/  (guarded; redirects to /admin/sign-in/ when logged out)
# → api   http://localhost:8787/health
```

No second server, no CORS, no `API_BASE` — the Node entry (`src/node.ts`)
serves `dodumodu_site/dist/` from the same port. Rebuild after editing the
site; the backend picks up `dist/` from disk without a restart (restart only
needed when you change `.env` — env is read once at boot).

---

## 1.5. First-ever admin setup — how the very first administrator gets their account

This is the one-time, "fresh-box" sequence that has to happen before any real user can log in. It is split into an **owner/manager step** (DB + bootstrap) and the **first-ever user login** (the user's first request completes the 72h window and becomes their first active device).

### A. Owner / manager prerequisites (before the user ever does anything)

1. **Secrets** are in the repo-root `.env` (never committed): `ADMIN_AUTH_V2=1`, three distinct
   32-byte base64 keys (`OTP_KEY`, `THROTTLE_KEY`, `TOTP_ENC_KEY`), and a real `RESEND_API_KEY`
   so login codes go to the real inbox. No Cloudflare Access or Worker secrets needed locally.
2. **Database** is local Postgres and migrated (`npm run db:migrate` from `dodumodu_backend/` —
   the `aa_` schema from `0019_admin_auth_v2.sql` must be present).
3. **No admin may exist yet.** The bootstrap script refuses if any row with `is_superuser` is
   already in `aa_users`.

### B. The bootstrap (run once, locally)

From `dodumodu_backend/`, with the local DB running:

```bash
cd dodumodu_backend
npm run createsuperuser -- you@example.com
# optional display name: npm run createsuperuser -- you@example.com --username=you
```

Expected output:

```text
created admin: michaelnabeau@gmail.com
first-device window open for 72h. The admin's first full login on any browser claims it and registers that device.
```

What the script actually does:

- **Refuses** if `SELECT count(*) FROM aa_users WHERE role='admin'` returns > 0 — this is a hard guarantee that there is exactly one first admin.
- **Creates** the admin row with `role='admin'` and `device_window_until = now() + 72h`. The `72h` is the **first-device window** (`FIRST_DEVICE_WINDOW_HOURS=72`). The admin's first *full* login (code → phrase → TOTP, on any browser) claims the window and registers that browser as the first active device in the same statement as the session (`FINISH_SESSION_ADMIN`); exactly one claim wins under parallel logins, the losers get no session.
- If the email already exists as a **staff** user, it **promotes** it to admin and renews the window (so you can't accidentally lock an existing staff member out).
- Writes an `admin_bootstrapped` audit event (append-only; never stores codes, phrases or tokens).

> **Never run against production unless you are deliberately provisioning the first admin.** After the first admin exists, no further bootstrap is needed — new admins are created by another admin with `USER_CREATE` + step-up, or by a manager with `PHRASE_RESET/CREATE`.

---

## 2. Quick test links (all live, all editable per environment)

The backend broadcasts its own origin at `/auth/me`-adjacent config; for **local** rehearsal use `http://localhost:8787`. For **production** replace with your worker origin (the `SITE_URL` you configured).

| # | Test | URL / payload | Expected |
|---|---|---|---|
| 1 | **Request a code** (admin) | `POST /auth/request`<br>`{ "email": "michaelnabeau@gmail.com" }` | `202 { ok: true }` — `flow` cookie set; code emailed to you. |
| 2 | **Resend a code** (same flow) | `POST /auth/resend`<br>`{ "email": "michaelnabeau@gmail.com" }`<br>header `Cookie: flow=<value-from-step-1>` | `202 { ok: true }`. Cooldown + hourly caps apply; retry with `retry_after`. |
| 3 | **Verify the code** | `POST /auth/code`<br>`{ "email": "michaelnabeau@gmail.com", "code": "<the-6-digit>" }` | `200` → moves to phrase/device stage. Wrong code → `401 { error: "Invalid code" }`. |
| 4 | **Request + deny alert** (unrecognized device) | `POST /auth/request` on an IP that has no device cookie | `202 { ok: true }`; background email `"Sign-in attempt on an unrecognized device"`. |
| 5 | **Device availability** (UI helper) | `GET /auth/device/available`<br>cookie `did=<your-device-token>` | `{ available: true }` if a device exists; `{ available: false }` otherwise. |
| 6 | **Test mailbox read** (no real email) | `GET /auth/test/mailbox/michaelnabeau@gmail.com` <br>header `ALLOW_TEST_IP=1` | `{ to, subject, text, at }` of the **last** email for that address. `404` otherwise. |
| 7 | **Admin panel** (console) | `GET /admin-v2/` / `GET /admin-v2/orders`<br>header `cf-access-authenticated-user-email: michaelnabeau@gmail.com` | HTML or JSON list; the console mounts under `/admin-v2` when `ADMIN_AUTH_V2=1`. |
| 8 | **Report widgets** | `GET /admin-v2/reports/visitors` | Renders the 7-lifecycle KPI summary, Live vs. Snapshot toggle, and daily/monthly/yearly trend chart with pagination. |

**Notes on the quick links:**
- Steps 1–3 are the **real email path** (Resend will try to deliver). For a deterministic test, use #6 instead.
- `#4` is the important negative case: it proves the denied-alert email is queued but does **not** change the `202` response.
- All of the above 404 (not 200/403) unless `ADMIN_AUTH_V2=1`, because `flagGate` is the first gate on every new route.
- The admin-only resource routes (status actions, notes, bulk actions, audit, users, auth-log, notifications, blocks, account-requests, report, analytics) all live under `/admin-v2` and follow the same `cf-access-authenticated-user-email` guard + `x-cron-secret` guard where noted.

---

## 3. Resend / email — the honest truth for a live tester

- **What the backend does with your key:** it reads `RESEND_API_KEY` from env, and every `sendLoginCode` / `sendDeniedAlert` call hits:

  ```text
  POST https://api.resend.com/emails
  Authorization: Bearer $RESEND_API_KEY
  from: "auth@example.com"          <-- fixed, not your account
  to:   <the admin email>
  subject: <one of the email templates>

---

## 4. Real user end-to-end (live backend)

Walk a new admin through this from the storefront admin entry point:

1. **Open the console.** `GET http://localhost:8787/admin/` (or your deployed `/admin-v2` origin). Cloudflare Access prompts, then the login page loads.
2. **Request the code.** Type the admin email → click **Send code**. You receive the 6-digit email (live via Resend — check the real inbox).
3. **Verify.** Paste the code → click **Verify**. *Novice*: you are now at the **phrase** stage. *Power*: if you already have a device token on a trusted browser, you are straight to the dashboard.
4. **Enroll the phrase.** The manager sets the phrase; the admin enters it. This is a **manager-only** step — the phrase is the thing the manager's app (`enroll_phrase`) stores, not the end user's memory.
5. **Optional TOTP.** If the admin wants strong second factor, start `totp/enroll/start`, scan the QR, verify the code. Backup codes are shown once.
6. **Finish the session.** The UI POSTs `/auth/session`, sets `sid`/`did`/`vid`, and the console navigates to the KPI/report/orders views.
7. **Day-two session.** The admin returns to the console. The `sid` cookie still exists (`1h idle / 5h absolute`). If they sit idle >1h, the next API call gets `401` and the UI shows the resume panel. Phrase-only resume is offered; TOTP is not offered to a resume session.

> **First-ever admin reminder:** this walkthrough presupposes §1.5 has already been run on `michaelnabeau@gmail.com`. If you are provisioning a **fresh box**, start with the bootstrap script first.

---

## 5. Interactive curl script (copy-paste)

Run from a shell that has the backend as its CORS origin (or `API_BASE` set in the site). All endpoints are relative to your origin.

```bash
# 0. Baseline
BASE="${BASE:-http://localhost:8787}"
EMAIL="michaelnabeau@gmail.com"
echo "[1] Request code"
FLOW=$(curl -s -c /tmp/dcr.txt -X POST "$BASE/auth/request" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\"}" | tee /tmp/dcr.json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).flow||''))")

echo "[2] Verify code (novice path)"
curl -s -c /tmp/dcr.txt -X POST "$BASE/auth/code" \

---

## 6. Quick test **screenshots / UI** map (what lives where)

| Screen | Frontend file | Backend route it calls | Check |
|---|---|---|---|
| Login page | `dodumodu_site/shared/scripts/admin/views/authlog.js` | `POST /auth/request`, `POST /auth/code`, `GET /auth/device/available` | Request + verify + device; wrong code 401; unrecognized device 429 |
| Admin console shell | `dodumodu_site/shared/scripts/admin.js` | `/admin-v2/*` | Session bootstrap; protected page loads |
| Reports dashboard | `dodumodu_site/shared/scripts/admin/views/reports.js` | **GET** `/admin-v2/reports/visitors` | KPI widgets, snapshot toggle, trend chart; pagination |
| Orders (admin) | `dodumodu_site/shared/scripts/admin/views/orders.js` | order action endpoints on `/admin-v2` | cancel/pick + Revert control; reason dialog |
| Users / access / auth-log / blocks / account-requests / notifications | `.../views/users.js`, `.../access.js`, `.../authlog.js`, `.../notifications.js` | `/admin-v2/users*`, `/auth-log*`, `/blocks*`, `/account-requests*`, `/notifications*` | Scoped admin views |

---

## 7. Failure & edge-case quick reference

| Symptom | Cause | Fix / check |
|---|---|---|
| `404` on `/auth/*` and `/admin-v2/*` | `ADMIN_AUTH_V2` not `1` | Set to `1` (flag) in the Worker; restart. |
| `429` on `/auth/code` with `retry_after` | Hourly send cap reached | Use `/auth/resend` (re-uses the same code) or wait; `unlock-email.mjs <email>` for the escape hatch. |
| `401` on code | Wrong / expired code | Request a new one. Codes are single-use. |
| Email **never** arrives locally | Missing/bad `RESEND_API_KEY`, or `ALLOW_TEST_IP=1` set | Confirm root `.env` has a live `RESEND_API_KEY` and `ALLOW_TEST_IP` is empty (`ALLOW_TEST_IP=1` disables real sends — test mailbox only). |
| Resend 4xx/5xx | Sandbox allowlist; bad key | Confirm `RESEND_API_KEY` is the **live** key, and the recipient is on your allowlist. `delivered@resend.dev` / `bounced@resend.dev` confirm failure behavior. |
| `403` on an admin route | Wrong role/permission | Check registry (`docs/route-registry.md`) for the required privilege; grant via `grantPerm`. |
| Session dies mid-flow | >1h idle, or >5h absolute | Resume with the phrase (1h idle → yes; >5h absolute → no). |
| **`admin_bootstrapped` script refuses with "an admin already exists"** | A previous bootstrap ran (one-shot) | The first admin already exists; run a fresh plan or use `reopen-device-window.mjs` / `unlock-email.mjs` if you purposely need to rework a user. |
| **First login loses the 72h window (parallel logins)** | Two browsers finish code→phrase→TOTP at once | `FINISH_SESSION_ADMIN` lets **one** claim win; the loser gets no session and no device. Have the user complete the path on a single browser. |
| **Window closed and you need it back** | The admin's devices are established | Use `reopen-device-window.mjs <email> [hours]` (break-glass, revokes devices, ends sessions, reopens window). Local only unless the feature is on in production. |

---

## 8. What to stop and fix before launch (hard gates)

1. `ADMIN_AUTH_V2=1` **and** `RESEND_API_KEY` in the deployed Worker secrets (`wrangler secret put`).
2. Cloudflare Access bypass for `/auth/*` only; `/admin-v2/*` stays behind Access.
3. Real from-domain on Resend (SPF/DKIM/DMARc) — the emails come from `auth@example.com`.
4. **Run the first-ever admin bootstrap once** (`bootstrap-admin.mjs michaelnabeau@gmail.com`) and confirm the 72h window opens, phrase enrollment works, TOTP enroll works, and backup codes show once.
5. Verify `/auth/test/mailbox` returns 404 when `ALLOW_TEST_IP` is absent.
6. Run the unit suite before smoke: backend `npm test` + `npm run typecheck`; site `npm test` (build + form UX + CSS + size + pricing).

---

## 9. Reference

- Auth spec: `docs/admin-auth/IMPLEMENT.md`
- Auth v2 operations & secret rotation: `docs/admin-auth/OPERATIONS.md`
- Route registry & auth surface: `docs/route-registry.md`
- Auth progress tracker: `docs/admin-auth/PROGRESS.md`
- First-admin bootstrap script: `dodumodu_backend/scripts/auth/bootstrap-admin.mjs`
- Backend README (local dev, DB, deploy, commands): `dodumodu_backend/README.md`
- Frontend admin build: `dodumodu_site/` (`npm run build`, `npm test`)

*This guide reflects the as-built code in this repo; the auth feature was implemented behind `ADMIN_AUTH_V2`, which is `0` by default.*

  -H 'Content-Type: application/json' \
  -d '{"email":"'$EMAIL'","code":"<paste-the-6-digit>"}' | python3 -m json.tool

echo "[3] Device availability"
curl -s -b /tmp/dcr.txt "$BASE/auth/device/available"

echo "[4] Test mailbox (deterministic, no real email)"
curl -s -H 'ALLOW_TEST_IP: 1' "$BASE/auth/test/mailbox/$EMAIL" | python3 -m json.tool

echo "[5] Admin panel"
curl -s -b /tmp/dcr.txt -H 'cf-access-authenticated-user-email: '$EMAIL "$BASE/admin-v2/" | head -c 200
```

> Note the `FLOW` cookie from step 1 is consumed by the code endpoint; keep only `did`/`vid`/`sid` for the rest.

  text:  <full plaintext body>
  Idempotency-Key: <random>
  ```

- **The code** is a fresh 6-digit number, generated per request, with per-email hourly caps. It is **never** scrolled off or logged.
- **From a real user's perspective:** they get an email with a numeric code at the time they click **Send code**. The moment the code arrives is timing-dependent on Resend's queue; it can be a few seconds, occasionally slower. There is no "instant" in production.
- **If you want to test without a real inbox:** set `ALLOW_TEST_IP=1` in root `.env`
  (local-dev only) and hit `GET /auth/test/mailbox/<email>` **after** a request. That endpoint only exists
  under `ALLOW_TEST_IP=1`; elsewhere it 404s. Keep it empty for real delivery.
- **Actual delivery (current setup):** local testing still runs on `npm run dev`
  (`localhost:8787`, local Postgres), but **email goes live through Resend** — `RESEND_API_KEY`
  in root `.env` makes `POST https://api.resend.com/emails` a real send to the real inbox.
  Sends are fire-and-forget via `afterResponse`/`waitUntil`: the API answers `202` before
  Resend succeeds or fails, and a failed send never changes the HTTP response.
- **TOTP needs a real authenticator app:** Google Authenticator (or 1Password / Authy / any
  TOTP-compatible app) on your phone. Scan the QR shown during TOTP enrolment, then type the
  6-digit code from the app. There is no local mock.

### Resend API key → `.env` mapping

Your `RESEND_API_KEY` does not go into the repo. Set it exactly as the backend expects, and note the blacklisted/restricted addresses your test account belongs to (Resend sandbox only allows sending to addresses on your allowlist; `delivered@resend.dev` and `bounced@resend.dev` are reserved for confirming failure behavior, §7).


### C. The user's first login (the real end-user journey)

1. **Open the console** → Cloudflare Access prompts → login page loads.
2. **Request a code** → type the email → click **Send code**. You receive the 6-digit email (Resend, from `auth@example.com`); the `flow` cookie is set.
3. **Verify the code** → you reach the **phrase** stage. *Power path*: if you already held a device cookie from an earlier trusted login, you skip straight to the dashboard.
4. **Enroll the phrase** → the manager set the phrase (stored by the manager's app via `enroll_phrase`); you enter it. This completes the first full path.
5. **Optional TOTP** → start `totp/enroll/start`, scan the QR, verify the code. Backup codes are shown **once**.
6. **Finish the session** → `POST /auth/session` sets `sid`/`did`/`vid`; the console navigates to the KPI/report/orders views.

> The 72h window is **claimed on the first full path**, not on step 2. If the user opens the login page repeatedly (parallel attempts), only the first one that completes code→phrase→TOTP wins; the others are refused.

### D. After the first login

- **Session**: `1h` idle / `5h` absolute; a phrase-only resume is offered inside 5h.
- **Device**: the browser is now the first active device; subsequent logins without a device token move to the "unrecognized device" `429` + denied-alert path.
- **TOTP**: once enrolled, backup codes are shown once; the authenticator must be re-enrolled on reset by another admin.
- **Fresh box again**: any subsequent new admin on a *different* machine must first verify an existing admin's device, then complete code→phrase→(TOTP).


The entry point is a **device-first** flow, not a bare password field. On the login page, the server tells the UI which device/alias the admin already trusts (`GET /auth/device/available`), then the user authenticates in three gates:

| Step | Server route | What the user does | What you see |
|---|---|---|---|
| 1. Request a code | `POST /auth/request` | Enter email → click **Send code** | `202 { ok: true }` + a `flow` cookie. **No code is visible to the user yet.** |
| 2. Verify the code | `POST /auth/code` | Paste the 6-digit code (emailed to the account) | Moves to the next stage. If the device is unrecognized → `429 { retry_after }` + a denied-alert email is queued in the background. |
| 3. Phrase (admin) OR device invite/accept | `POST /auth/phrase/enroll`, `enroll_phrase`; device flows | Admins finish with the **phrase** (a manager-controlled "something you know"); staff accept the pending invite. | `200` + session. The very first admin on the planet also gets the 72h first-device window. |
| 4. TOTP (admin, recommended) | `POST /auth/totp/enroll/start`, `totp` | Scan the QR, enter the 6-digit TOTP on your phone | Creates the authenticator binding. Backup codes are shown **once**. |
| 5. Finish session | `POST /auth/session` | Confirm | Sets the `sid`/`did`/`vid` cookies. Session = **1h idle / 5h absolute**; a phrase-only resume is possible inside 5h. |

The **novice path** is deliberately long (code → phrase → optional TOTP). The **power path** for an existing admin on a trusted device is just `POST /auth/code` with a device token — no phrase, no TOTP.

> **Local reality:** testing still runs on your daily `npm run dev` (`localhost:8787`,
> local Postgres), but **email goes live through Resend** — `RESEND_API_KEY` in root `.env`
> makes `POST https://api.resend.com/emails` a real send to the real inbox. Sends are queued
> fire-and-forget via `afterResponse`/`waitUntil`: the API answers `202` first, so a slow or
> failed send never changes the HTTP response.

> **TOTP reality:** use a **real compatible authenticator app** — Google Authenticator,
> 1Password, Authy, etc. — not a local mock. Scan the QR on your phone, then enter the 6-digit code.
