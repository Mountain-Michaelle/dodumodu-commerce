# Admin authentication: implementation spec for Cline (aligned revision)

This one file is the whole task. It replaces `PACK.md` and `CLINE_PROMPT.md` for implementation. Nothing else needs to be read to build the feature.

**What changed in this revision.** Every new database object now carries the `aa_` prefix (applied in the appendices, no rename step). TOTP reset can no longer be bypassed through the device path. Hourly send caps use a new non-escalating function. Phrase-reset and device-invite creation are two-statement transactions. Middleware is scoped per route so existing routes are untouched. Turnstile is always required on the two entry endpoints. Missing queries are in Appendix E. The work is split into three runs with human checkpoints. Session lifetime and resume are specified in section 5.11: 1 hour idle, 5 hours absolute, browser close ends the session, and a phrase-only resume inside the 5 hours.

**Setup.** Cline in Act mode. Keep this file in the repo at `docs/admin-auth/IMPLEMENT.md`. Put dev secrets in `.dev.vars` (not committed): `OTP_KEY`, `THROTTLE_KEY`, `TOTP_ENC_KEY` (each 32 random bytes, standard base64: `openssl rand -base64 32`), `RESEND_API_KEY`, `TURNSTILE_SECRET` (Cloudflare test keys), `DATABASE_URL` (Neon **dev branch**).

**Before you start (operator, not Cline):**
- Argon2id needs a Workers **Paid** plan (the free plan's 10 ms CPU limit cannot run it). Confirm the plan first. If it is free, stop and decide.
- If Cloudflare Access protects the app, `/auth/*` must be reachable without an Access login (add a bypass policy for `/auth/*` only). The new `/admin/*` routes stay behind Access. Cline does not edit Access.
- Confirm CI does not run migrations or deploy to production on a branch push. Cline only reports what it finds and never edits CI.

## How to run it: three runs, three checkpoints

A single session will lose context on a task this size. Run it in three separate Cline tasks. Each run reads this file once and `docs/admin-auth/PROGRESS.md` (created in Run 1, updated after every phase).

| Run | Build steps | Stops at |
|---|---|---|
| 1 | 1 to 4 (baseline, recon, migration, crypto, service layer) | **CP1** after the recon note (wait for "go"), **CP2** after migration, SQL tests and the Argon2id measurement |
| 2 | 5 to 8 (middleware and routes, Resend, UI, scripts) | **CP3** after step 8 |
| 3 | 9 to 12 (UI tests, attack phase, final report) | the final report |

**Human checkpoints.** CP1: read the recon note and the baseline counts. CP2: a person (not Cline) reviews Appendix F4 (`FINISH_SESSION_ADMIN`) and the SQL test output, and reads the Argon2id CPU number. CP3: a person skims the diff for shared-file edits, then starts Run 3.

**COPY START (Run 1)**

Implement the feature described in `docs/admin-auth/IMPLEMENT.md`, Run 1 only (build steps 1 to 4). Read that file once, fully, then read `docs/admin-auth/PROGRESS.md` if it exists. Work on branch `feat/admin-auth`. Stop after the recon note and wait for my "go". After "go", continue to the end of step 4 and stop with the checkpoint report.

**COPY END**

**COPY START (Run 2)**

Implement the feature described in `docs/admin-auth/IMPLEMENT.md`, Run 2 only (build steps 5 to 8). Read that file once, then `docs/admin-auth/PROGRESS.md`. Continue on branch `feat/admin-auth`. Stop at the end of step 8 with a short report.

**COPY END**

**COPY START (Run 3)**

Implement the feature described in `docs/admin-auth/IMPLEMENT.md`, Run 3 only (build steps 9 to 12). Read that file once, then `docs/admin-auth/PROGRESS.md`. Continue on branch `feat/admin-auth`. Finish with the final report.

**COPY END**

---
---

# 1. Goal

Add a login system for staff and admins on the existing Hono-on-Workers app with Neon Postgres and a plain HTML/CSS/vanilla JS UI.

- Staff: email code, then phrase.
- Admin: registered device (or email code), then phrase, then authenticator (TOTP). Backup codes replace the authenticator when it is lost.
- Admin devices and IPs are captured. Same device shows the device option; if the IP changed, authorization and rate limits get stricter.
- Real users are never locked out by strangers or by our own server faults.
- Email is sent with Resend.

Django's user and permission model is the inspiration only. No Django.

# 2. Constraints: do not break existing or incoming work

This is the most important section. The feature must be additive and removable.

1. **Feature flag.** Everything new is behind `ADMIN_AUTH_V2` (`"0"` default, `"1"` on). With the flag off, the new routes return `404` and no existing behavior changes. Deploying the code with the flag off must be a no-op.
2. **Existing admin protection stays exactly as it is** (for example Cloudflare Access or the current guard). Do not edit, wrap, reorder or remove it. Export `requireSession`, `requireAdmin`, `requirePerm(perm)` and `requireStepUp` from `src/auth/middleware.ts` so existing routes *can* adopt them later. Do not apply them to any existing route. Cutover is a separate task.
3. **Additive database changes only.** New tables, new columns with defaults or nullable, new functions. No drops, renames, type changes, or edits to existing migration files. **Every new table, function and index name starts with `aa_`; the appendices already use these names, so there is no collision check and no rename step.** Before migrating, grep the migrations folder once for `aa_` (expect no hits) and grep the repo once for `pg_advisory` (the advisory-lock keys `7001` and `7002` must be unused; if either is used, change that one constant in the SQL and in `config.ts` and say so). Use the repo's migration tool and numbering and add new migration files only.
4. **Additive routes only.** Mount under `AUTH_BASE` (`/auth`) and `ADMIN_BASE` (`/admin`) constants. If a route with the same method and path already exists, change that base to `/auth-v2` or `/admin-v2` for the whole feature. Never override an existing route. Static UI goes in its own new folder and is served under `${AUTH_BASE}/ui/*`.
5. **Small footprint in shared files.** New code lives in `src/auth/**`, `src/auth-ui/**` (or the repo's equivalent), `tests/auth/**`, `scripts/auth/**`. In shared files (Worker entry, `wrangler` config, `package.json`) make the smallest edit possible: one mount line, new bindings and vars, new scripts. Do not reformat, rename, reorder or "clean up" anything you do not own. Do not change lint, tsconfig, formatter or CI config. Do not upgrade existing dependencies. Do not add the `nodejs_compat` flag (Appendix D uses no `Buffer`).
6. **Dependencies.** Add none unless required. Resend is called with `fetch`, no SDK. The only likely addition is an Argon2id implementation (section 9).
7. **Baseline first.** Before changing anything run the existing test suite once and record pass and fail counts. At the end there must be no new failures versus that baseline. If the baseline already fails, note it and do not fix it.
8. **Rebase-friendly.** Small commits per phase. Before each phase run `git status` and `git log -1`; if someone else changed shared files, adapt with a targeted `grep`, do not re-read whole files.
9. **No production access.** Dev branch database only. Nothing here may be applied to production.
10. **Middleware scoping (Hono).** Middleware registered with `use` on a path runs for every request that matches that path, including existing routes. Therefore: never call `use` with `*` or on a shared base such as `/admin/*` or `/*`. Build every new route with one helper, `route(method, path, ...handlers)`, whose chain starts with `flagGate` (flag off: `return c.notFound()`), then the per-route guards of step 5. The Origin and content-type guard, JSON-only rule, CSP, body limit and cookie handling apply only inside these chains and to `${AUTH_BASE}/ui/*`. Register no wildcard on a shared base. Prove it with a snapshot test: status and headers of five existing routes (including one form POST and one admin route) are identical with the flag off and on.


# 3. How to work (speed)

- Read this file once per run, and `PROGRESS.md` at the start of a run. Never re-read a file you just wrote. If context is compacted, re-read `PROGRESS.md` and only the section of this file for the current step.
- After each phase append at most 10 lines to `docs/admin-auth/PROGRESS.md`: phase, commit hash, test counts, decisions, open items.
- Recon is capped at 10 tool calls: `package.json`, `wrangler` config, Worker entry file, DB client file, migrations folder listing, one grep for the existing admin guard, frontend folder listing, test setup listing, one grep of the CI workflow files for `migrate`, `wrangler deploy` and `DATABASE_URL`, one grep for `pg_advisory` and `aa_`. Then write a note of at most 20 lines (how DB calls are made, whether `transaction([...])` exists, how cookies are set, where the guard is, migration tool, test runner, UI folder, CI findings, route collisions). Then stop for CP1. Do not ask questions the note answers.
- Batch work: several files per step, several commands per call, one write per file, no per-file narration.
- Run the focused tests for the layer you just changed; the full suite only at the end of each phase. Do not rerun a failing test more than twice without changing something.
- Copy the SQL and crypto in the appendices **verbatim** into code. Do not rewrite them. Appendices E and F, and the edits marked in C and D, are unverified: test and fix them.
- Stop and report instead of patching around it when: a verified test from this file fails, a rule in section 4 would have to be weakened, or something would touch production.

# 4. Security rules (never broken)

- Staff: email code, then phrase. Admin: a registered device or an email code, then phrase, then authenticator. An admin never gets in on fewer than three independent proofs. A device cookie alone grants nothing and never replaces the phrase or the authenticator. IP is never a trust signal on its own. One documented exception: after another admin resets an admin's authenticator (with step-up), that admin signs in on the email path only (code, phrase, matching active device cookie) and enrolls a new authenticator; the device path is closed until enrollment completes (`DEVICE_FLOW_START` requires an enrolled authenticator), and the reset is notified to the admin and the other admins. A resume login (5.11) is not a new entry: it restores a session that a full login created within the last 5 hours, from the same browser, device and network. Staff need the phrase; admins need the phrase and the authenticator (or a backup code).
- The server owns the state machine. The browser holds an opaque HttpOnly flow cookie; the stage lives in the database. The client never chooses the next stage or its own privileges.
- Every failed attempt is reserved atomically before verification. Every state change is one guarded SQL statement (`WHERE stage = <expected>`), so races and replays fail. Multi-statement changes use one transaction and are named as such.
- No raw secrets stored: phrase is Argon2id; emailed code is an HMAC only; TOTP secret is AES-GCM encrypted; session, flow, device, invite, reset and backup tokens are stored only as hashes.
- Unknown email, known staff email and admin email on an unregistered device get identical responses, counters and (best effort) timing. There is no registration endpoint. An admin on an unregistered device gets no email and no code: the flow is created like an unknown email (`user_id` NULL).
- Nothing the client sees may depend on account state before a valid device cookie has matched. In particular Turnstile is required unconditionally on the two entry endpoints (decision 13), never "when risky".
- Never log codes, phrases, tokens, request bodies or full emails. Log request id, route, status and the HMAC of the email.
- Default deny. Permissions are read live on each request. The server decides; the UI only hides buttons.
- Fail closed: an unexpected error in the auth path denies with `503` or `401`, never allows.

## R-NOLOCK (no lockout of real users)

1. A lock only affects the client that caused the failures: the pair `email + IP`, or for a trusted device the pair `email + device`. No state keyed by email alone may block a sign-in.
2. Per-email counters (the fuse) only add friction: an audit event and a rate-limited alert email. They never lock and never change a response.
3. A server fault is not a user failure. If a reserved attempt ends in a fault of ours (DB error, timeout, exception), call `aa_auth_refund` and return `503 {retry:true}`. Never answer `401` for a fault. Never refund a wrong answer or a client abort. A Worker killed mid-request cannot refund; that attempt counts.
4. A trusted device has its own limits and is exempt from the IP-pair lock. A lock on one device never touches another device or the account.
5. Known residual risk, to be documented in the report: a stranger can use the hourly send cap (a fixed one-hour window, never an escalating lock) to delay a staff user's next code by up to an hour. Admins are not affected because they have the device path.

# 5. Specification

## 5.1 Entry routing (`POST /auth/request {email}` always returns the same `202`)

"Device active" below means: the browser's `__Host-did` cookie matches an active device row of that admin. A device that exists but whose cookie this browser does not hold does not count.

| Who | Entry | Email sent |
|---|---|---|
| Unknown, inactive or non-ASCII email | dummy flow (`user_id` NULL) | no |
| Staff | normal path | yes |
| Admin, cookie matches an active device | normal path (device path also available if the authenticator is enrolled) | yes |
| Admin, cookie matches a pending device (invite accepted) | normal path with all three proofs; activates the device at the end | yes |
| Admin, first-device window open | normal path; device registered at the end | yes |
| Admin, no valid device and window closed | dummy flow, plus one rate-limited alert email to the admin | no |

```
Normal path
POST /auth/request -> flow(stage=otp)
otp            -- emailed code ok -->  phrase | enroll_phrase (first login)
phrase / enroll_phrase
               -- phrase ok -->        ready (staff) | totp (admin, enrolled) | totp_enroll (admin, first time or after reset)
totp           -- authenticator code OR one backup code --> ready
totp_enroll    -- first valid authenticator code --> ready (8 backup codes shown once)
ready          -- POST /auth/session --> session cookie (+ device cookie on the first admin login)

Device path (admin, active device, authenticator enrolled, phrase set)
POST /auth/device/start {email} + __Host-did -> flow(stage=phrase, via=device)
phrase -> totp (authenticator or backup code, never skipped) -> ready -> POST /auth/session
```

A session is created only from `ready`. For an admin it also needs an active device, a pending device this login activates, or the single winning first-device claim.

```
Resume path (5.11: within 5 hours of the last full login, same browser, device, network)
GET /auth/resume (__Host-rid cookie) -> {resume:true, hint}
POST /auth/resume/start -> flow(stage=phrase, via=resume)
phrase -> ready (staff) | totp -> ready (admin) -> POST /auth/session -> same session row, new tokens
```

## 5.2 Decisions

1. The phrase is not unique. Argon2id with a per-user salt. Length 12 to 64, no spaces, any symbol.
2. Admin third factor is TOTP, never a second emailed code. Backup codes are the fallback.
3. Nobody, admins included, can view a phrase. Reset: an admin triggers it, the user gets a single-use 15-minute link and chooses a new phrase; all their sessions end. A new reset replaces any unused older one (`PHRASE_RESET_CREATE`, a transaction).
4. Emailed code: 10 characters from `0-9 A-F ! # $ % & * + ?`, 3-minute expiry, derived from a server key so a resend reuses the same code and nothing sensitive is stored (Appendix D).
5. Locks (see 5.3 for tiers). Pair key `stage:HMAC(email):ip`: 3 failures per round, lock 10 minutes, then +10 per failed round, capped at 24 h; the round resets after 24 h quiet or on success. The per-email fuse is a non-blocking counter `fuse:HMAC(email)` (`aa_auth_fuse_note`) that only raises an audit event and an alert email. Blocked requests are not counted again.
6. Each flow also ends after 3 failed attempts at one stage. The next try needs a new `/auth/request` and so a new email code.
7. Resend: 45 s cooldown, at most 3 sends per code; a 4th request counts as a failure on the pair lock. New codes are capped per email per hour and per email+IP per hour with `aa_auth_send_cap` (fixed one-hour window, `send:` keys). Dummy flows go through the same caps with the same keys. The send cap is never an escalating lock.
8. Sessions: server-side. `__Host-sid` is a browser-session cookie (HttpOnly, Secure, SameSite=Strict, **no Max-Age or Expires**, so closing the browser drops it); 32-byte random token stored as SHA-256. Idle limit 1 hour and absolute limit 5 hours from the last full login (strict tier: 10 minutes and 4 hours). Revocation by `session_version`. An admin session also ends the moment its device is revoked. Lifetime, resume and cookies are in 5.11.
9. Staff privileges come from one `PERMISSIONS` registry (`orders.view`, `orders.add`, `orders.change`, `orders.delete`, `orders.export`, `reports.view`, `users.manage`). Default none. Only admins grant. Admins implicitly hold all.
10. The last active admin cannot be demoted or deactivated (`DEMOTE_ADMIN_GUARDED`, `DEACTIVATE_GUARDED`), and an admin cannot revoke their own last active device (advisory-lock transactions).
11. Same-origin deployment: UI and API on one hostname, JSON only, custom Origin and content-type guard on every unsafe method of the new routes (`hono/csrf` alone does not cover JSON).
12. Devices apply to admins only.
13. **Turnstile is verified on every call to `POST /auth/request` and `POST /auth/device/start`, in every tier, for every email.** It is never conditional on anything derived from the email, because a conditional requirement would reveal account state. A missing or failed token gets the same rejection for all emails, before any lookup. Strict tier and a hot fuse add an audit event and an alert email, not a different Turnstile rule.
14. Keys and email handling. `OTP_KEY`, `THROTTLE_KEY`, `TOTP_ENC_KEY` are standard base64 of exactly 32 bytes; load them once with `loadKey` (Appendix D) and fail closed at startup if the length is wrong. Email is normalized by `normalizeEmail` (trim, lowercase, ASCII only, at most 254 characters, one `@`); anything else is treated as unknown (dummy flow). `HMAC(email)` is `emailHmac(THROTTLE_KEY, normalizedEmail)`.

## 5.3 IP and device capture, and the strict tier

On every request in the auth path compute `ctx = {ip, prefix, country, ua}` once in middleware. `ip` comes only from `CF-Connecting-IP`, never from `X-Forwarded-For` or other headers. `prefix` is IPv4 `/24` written `a.b.c`, and IPv6 `/48` written as the first three expanded hextets (expand `::` first, lowercase; IPv4-mapped IPv6 is treated as IPv4). `country` is `request.cf.country`. `ua` is truncated to 120 characters. For tests only, an `X-Test-IP` header may override `ip` when `env.ALLOW_TEST_IP === "1"`; that var exists only in `.dev.vars`, and a test must assert it is absent from the deployed config.

Store `ip`, `prefix`, `country`, `ua` on flows, sessions and audit events, and `last_*` on devices.

| Tier | When | Effects |
|---|---|---|
| `anon` | no device cookie | IP-pair lock as in decision 5 |
| `normal` | active device, same prefix and country as the device's last login | device path shown; device lock 5 failures, step 5 min, cap 60 min; idle 60 min (staff and admin); absolute 5 h; step-up window 5 min; resume allowed (5.11) |
| `strict` | active device, prefix or country differs | device path still shown, plus everything below |

**Strict tier effects:**
1. The flow response for a real strict flow carries `strict:true` so the UI shows its banner (only a holder of a matching device cookie can see this). Turnstile is already required in every tier (decision 13).
2. The device path needs phrase and authenticator code. Backup codes are refused on the device path in strict tier (use the normal path).
3. Lock key `stage:HMAC(email):dev:<device_id>:<prefix>`, 3 failures, step 15 min, cap 24 h. It never affects the device's normal key or other devices.
4. The session is created with `tier='strict'`: admin idle 10 min, absolute 4 h, step-up window 2 min, and every admin write route needs a fresh step-up.
5. Admin route rate limit: `ADMIN_RPM_NORMAL=60`, `ADMIN_RPM_STRICT=15`. Use the Workers Rate Limiting binding if available; otherwise a Cloudflare rule per path plus an `aa_auth_bump` key on write routes only. Do not add a DB query to read routes for this.
6. Send the alert email "sign-in from a new network" (time, country, truncated user agent; never the full IP).
7. A strict login does not update the device's `last_ip_prefix` until the admin completes a step-up in that session (`DEVICE_SET_LAST_IP`).
8. Drift in a live session: if a request's prefix differs from the session's, call `SESSION_DRIFT`. The session stays but behaves as strict; audit `ip_drift`. A country change also clears step-up. If `SESSION_DRIFT` returns `drift_count > 3` (within an hour), delete the session and audit `ip_drift_revoke`.

The tier is computed from the row that `DEVICE_RESOLVE` or `SESSION_LOOKUP` already returned. It adds no query.

## 5.4 Trusted admin device

- A device is a browser holding `__Host-did`: 32 random bytes, HttpOnly, Secure, SameSite=Strict, Path=/, 90 days sliding. The database stores only its SHA-256, a status (`pending`, `active`, `revoked`), a truncated user-agent label, last seen, last ip, last prefix, last country.
- **First login registers the device.** When an admin is created (bootstrap or by another admin with step-up, `USER_CREATE`) set `device_window_until = now() + 72 h`. The first login that completes the full path claims the window and registers that browser as the first active device in the same statement as the session (`FINISH_SESSION_ADMIN`). Exactly one claim wins under parallel logins; the loser gets no session. Notify the other admins.
- **Unregistered device:** denied as in 5.1.
- **Adding a device later:** (1) from a trusted session with step-up, `POST /admin/devices/invite` creates a single-use 15-minute link; opening it on the new browser registers a pending device, which becomes active only after a full three-proof login; a pending device cannot use the device path. (2) If the only device is lost, another admin calls `POST /admin/users/:id/device-invite` with step-up. (3) With no other admin, the operator runs the reopen-window script.
- Maximum 3 active plus pending devices per admin. Revoking a device ends its sessions at once.

## 5.5 Step-up (admins)

These actions need a fresh authenticator or backup code posted to `POST /auth/stepup`, which opens a window on that session (5 min normal, 2 min strict): grant or revoke permissions, reset a phrase, deactivate a user, create an admin, reset another admin's authenticator, force another user's logout, regenerate backup codes, create a device invite, revoke a device. In strict tier every admin write needs it.

## 5.6 Backup codes

8 single-use codes shown as `XXXXX-XXXXX` (base32, about 50 bits), displayed once, stored as SHA-256. They are inserted in the same statement that confirms authenticator enrollment (`TOTP_ENROLL_CONFIRM`, Appendix E), so a failure never leaves an admin without codes. Usable at the `totp` stage instead of the authenticator code (not on the strict device path). They count against the same `totp` lock and are consumed atomically. After use: show the remaining count, warn at 2 or fewer, require regeneration (step-up) or re-enrollment, and email "a backup code was used". If both authenticator and codes are lost, another admin resets the authenticator (step-up), or the operator runs the break-glass script.

## 5.7 Endpoints

| Method and path | Needs | Result |
|---|---|---|
| `POST /auth/request {email}` | Turnstile (always) | always `202`, same message, sets flow cookie |
| `POST /auth/resend` | flow cookie | same answer, cooldown and caps |
| `POST /auth/code {code}` | flow at otp | next stage, `401`, `429 {retry_after}`, `503 {retry}` |
| `POST /auth/device/start {email}` | Turnstile (always), `__Host-did` | always `202`; real phrase-stage flow only for a matching active device of an admin with phrase and authenticator, otherwise a dummy flow |
| `POST /auth/phrase/enroll {phrase, confirm}` | flow at enroll_phrase | next stage |
| `POST /auth/phrase {phrase}` | flow at phrase | next stage, `401`, `429`, `503` |
| `POST /auth/totp/enroll/start` | flow at totp_enroll | `{secret, otpauth_uri}` once (`TOTP_PENDING_SET`; a reload needs a new flow) |
| `POST /auth/totp {code}` or `{backup_code}` | flow at totp or totp_enroll | next stage; enrollment returns the 8 backup codes once |
| `POST /auth/session` | flow at ready | sets `__Host-sid` and `__Host-rid`; sets `__Host-did` on the first admin login; a resume flow re-keys the existing session row (`FINISH_RESUME`) |
| `POST /auth/logout` | session | deletes the session row (which also ends the resume right), clears both cookies, always `204` |
| `GET /auth/resume` | `__Host-rid` (admins also `__Host-did`) | `{resume:true, hint}` with a masked email, or `{resume:false}`; one answer for every ineligible case; no cookie means no DB query |
| `POST /auth/resume/start` | `__Host-rid` (admins also `__Host-did`) | creates a phrase-stage flow (`via=resume`) or a neutral `401`; no Turnstile, because it takes no email and needs the cookie |
| `POST /auth/stepup {code}` or `{backup_code}` | admin session | opens the step-up window |
| `GET /auth/me` | session | `{email, role, perms, stepup_ok, tier, device:{trusted}}` |
| `GET /auth/sessions`, `DELETE /auth/sessions/:sid`, `POST /auth/sessions/revoke-others` | session | own sessions only |
| `POST /auth/phrase-reset/:token {phrase}` | token | sets phrase, ends sessions |
| `POST /auth/backup-codes/regenerate` | admin + step-up | new set shown once |
| `GET /admin/devices` | admin | my devices |
| `POST /admin/devices/invite` | admin + step-up | single-use link for me |
| `POST /admin/users/:id/device-invite` | admin + step-up, not self | invite for another admin |
| `POST /auth/device/accept/:token` | invite token | registers a pending device (cookie set) |
| `DELETE /admin/devices/:id` | admin + step-up | revoke; refuses my last active device |
| `POST /admin/users` | `users.manage` + step-up for the admin role | create user |
| `POST /admin/users/:id/phrase-reset` | `users.manage` + step-up | emails reset link |
| `PUT /admin/users/:id/permissions` | `users.manage` + step-up | grant or revoke |
| `POST /admin/users/:id/deactivate` | `users.manage` + step-up | deactivate, bump `session_version` |
| `POST /admin/users/:id/totp-reset` | admin + step-up, not self | clear authenticator and codes |
| `POST /admin/users/:id/force-logout` | admin + step-up | end all sessions |

Wrong code, unknown email, expired code, used code and an admin on an unregistered device all return the same `401` body. Lock responses are identical for real, unknown and denied emails. A fault returns `503 {retry:true}` and is refunded. If any of these paths collides with an existing route, apply constraint 2.4.

## 5.8 Config (one module, `src/auth/config.ts`)

`OTP_LEN=10`, `OTP_TTL_SECS=180`, `OTP_RESEND_COOLDOWN_SECS=45`, `OTP_RESEND_MAX=3`, `OTP_SENDS_PER_HOUR=10`, `OTP_SENDS_PER_HOUR_IP=4`, `SEND_CAP_WINDOW='1 hour'`, `PAIR_THRESHOLD=3`, `LOCK_STEP_MIN=10`, `LOCK_MAX_MIN=1440`, `DEVICE_THRESHOLD=5`, `DEVICE_LOCK_STEP_MIN=5`, `DEVICE_LOCK_MAX_MIN=60`, `STRICT_THRESHOLD=3`, `STRICT_LOCK_STEP_MIN=15`, `FUSE_FRICTION_THRESHOLD=9`, `FUSE_DECAY_HOURS=1`, `FLOW_STAGE_MAX_FAILS=3`, `ROUND_DECAY_HOURS=24`, `FLOW_TTL_SECS=900`, `PHRASE_MIN=12`, `PHRASE_MAX=64`, `SESSION_IDLE_SECS_STAFF=3600`, `SESSION_IDLE_SECS_ADMIN=3600`, `SESSION_IDLE_SECS_STRICT=600`, `SESSION_ABSOLUTE_SECS=18000`, `SESSION_ABSOLUTE_SECS_STRICT=14400`, `RESUME_COOKIE_MAX_SECS=18000`, `STEPUP_WINDOW_SECS=300`, `STEPUP_WINDOW_SECS_STRICT=120`, `BACKUP_CODE_COUNT=8`, `ADMIN_DEVICE_MAX=3`, `DEVICE_TTL_SECS=7776000`, `DEVICE_INVITE_TTL_SECS=900`, `DEVICE_PENDING_SECS=900`, `FIRST_DEVICE_WINDOW_HOURS=72`, `DENIED_ALERT_COOLDOWN_HOURS=6`, `ADMIN_RPM_NORMAL=60`, `ADMIN_RPM_STRICT=15`, `DB_TIMEOUT_MS=4000`, `EMAIL_TIMEOUT_MS=3000`, `ADVISORY_KEY_ADMINS=7001`, `ADVISORY_KEY_DEVICES=7002`.

`SESSION_LOOKUP` is called with the largest idle value (3600). `idle_secs` comes back in the row and the Worker enforces the role and tier limit from it. An idle-expired session is denied but **never deleted**: the row is the resume right. Only logout, revoke, a `session_version` bump, a device revoke or absolute expiry remove it.

Secrets (Worker secrets only): `OTP_KEY`, `THROTTLE_KEY`, `TOTP_ENC_KEY`, `RESEND_API_KEY`, `TURNSTILE_SECRET`.

## 5.9 Frontend (vanilla JS, external script files only because CSP forbids inline)

- One input per stage, rendered from the server's `next` value. No tokens in `localStorage`. `autocomplete="one-time-code"` for the emailed code, `current-password` for the phrase, `new-password` for enrollment; paste allowed.
- Resume panel: on load of the login page call `GET /auth/resume`. If `resume:true`, show "Welcome back, <hint>. Enter your phrase" (admins then the authenticator code) with a "Use a different account" link to the normal form. On any `401` from an API call, run the same check instead of showing an error page. The email field uses `autocomplete="username"` so the browser can remember it for full sign-ins.
- Idle awareness without extra traffic: on `visibilitychange` to visible after being hidden for an hour or more, call `GET /auth/me` once; the server decides. No heartbeat, no polling.
- After the email form always show "If this email is registered, check your inbox." Resend button after 45 s with a countdown. On `429` show a server-driven countdown and disable the form. On `503 {retry}` show "Something went wrong on our side. Nothing was counted. Try again." and keep the form usable. Disable submit while a request is in flight. The same neutral error for every failure. The Turnstile widget is on the email form and the device-start button every time.
- Authenticator stage: "Use a backup code instead" link (hidden in strict device path). TOTP secret and backup codes shown once with copy and print and an "I saved them" confirmation.
- "Use this trusted device" appears only when a device cookie exists. A static link "Signing in from a new device?" explains the invite flow; denials never explain why. When the flow response says `strict:true`, show "Extra checks are on because your network changed."
- A sensitive action without a fresh step-up opens a re-authentication prompt, then retries.
- Pages: login, sessions, devices (list, add-device invite as link and QR, revoke; last-device revoke disabled with a note), users and permissions. Render user-agent labels with `textContent`. Desktop and mobile.

## 5.10 Operations

- Scripts in `scripts/auth/`: `bootstrap-admin` (refuses if any admin exists; sets the first-device window), `unlock-email` (delete `aa_auth_throttle` rows for an email HMAC, audited), `reopen-device-window` (`OPERATOR_REOPEN_DEVICE_WINDOW`, Appendix F3, audited).
- Cleanup (`CLEAN_*`, `CLEAN_DEVICES`, `CLEAN_INVITES`) in batches, wired to the scheduler that already exists. Do not assume a Cron Trigger.
- Secret rotation notes: rotating `OTP_KEY` invalidates outstanding codes; `THROTTLE_KEY` clears locks; `TOTP_ENC_KEY` needs re-encryption. Device and invite tokens are random and hash-only.
- Notification emails: phrase reset requested or used, backup code used, authenticator reset (to the admin and the other admins), permission change for the affected user, admin signed in through the device path, new device invited or registered, first-device claim (also to other admins), sign-in attempt from an unregistered device (max 1 per admin per 6 h), sign-in from a new network, fuse friction alert (max 1 per user per 6 h).
- Audit events (append-only; never codes, phrases, tokens or free text): login_code_requested, login_failed, login_locked, login_success, login_device_path, login_denied_device, server_fault_refund, backup_code_used, stepup_granted, phrase_enrolled, phrase_reset_requested, phrase_reset_used, totp_enrolled, totp_reset, permission_granted, permission_revoked, user_created, user_deactivated, role_changed, session_revoked, forced_logout, admin_unlock, device_registered, device_invited, device_activated, device_revoked, device_window_reopened, ip_drift, ip_drift_revoke, fuse_friction.
- Cloudflare in front: Turnstile on `/auth/request` and `/auth/device/start`, a coarse requests-per-minute rule on `/auth/*` per IP (not an escalating lock), WAF. Keep any existing Cloudflare Access, with the `/auth/*` bypass described in the setup section.

## 5.11 Session lifetime and resume

1. **Idle.** No authenticated request for 1 hour ends the session (strict tier: 10 minutes). **Browser close** ends it too, because `__Host-sid` has no Max-Age or Expires. A browser that restores session cookies after a restart is still bound by the idle and absolute limits.
2. **Absolute.** 5 hours from the last full authentication (strict: 4 hours), whatever the activity. Resume never extends it: `absolute_expires_at` is never changed after login.
3. **Resume.** After idle or browser close, still inside the absolute window, the person signs in with the phrase alone (admin: phrase plus authenticator or a backup code), with the account remembered, only if all of these hold: the same `__Host-rid` cookie (a second HttpOnly token bound to the session row, `Max-Age` equal to the time left, at most `RESUME_COOKIE_MAX_SECS`); the same network (the `/24` or `/48` prefix) and country; the same user agent string; tier `normal`; user active and `session_version` unchanged; and, for admins, the same active device cookie and an enrolled authenticator. Anything else, including more than 5 hours, a changed network, logout, revocation or deactivation, means full authentication from the start (staff: email, code, phrase; admin: as in 5.1). "Same IP" means same prefix, so a changing last octet does not break it.
4. **In place, single winner.** `FINISH_RESUME` changes the session token hash and the resume hash on the existing row (`sid` stays, tokens rotate), clears step-up and drift, and is matched by the resume hash the flow started with, so parallel resumes give one session and an old rid or old session cookie then finds nothing.
5. **What removes the resume right:** logout (always means full authentication next time), "end this session", force logout, a `session_version` bump (role change, phrase reset, TOTP reset, deactivation), device revoke, absolute expiry. A drifted session is `strict` and is never offered resume.
6. **Locks.** Staff resume failures use the phrase pair key. Admin resume failures use the device key with the device-path numbers. R-NOLOCK applies: reserve first, refund on our fault, never touch the account key.
7. **No emails on resume.** Resume sends no code and no device-path alert. The full login already notified.
8. **Cost.** No new table, one new unique index (`resume_hash`), the hot path is still one `SESSION_LOOKUP` and a touch at most once a minute. `GET /auth/resume` makes no query without the cookie.
9. **Idempotence.** Logout is always `204`; resume start can be repeated; resume finish is single-winner; the touch only moves forward; cleanup deletes only rows past the absolute limit and is safe to rerun. If the `/auth/session` response is lost the old rid no longer matches and the person signs in in full once; add no retry logic for this.

# 6. Production behavior

- **One DB round trip per hot path.** `SESSION_LOOKUP` is the only query on an authenticated request. Touch `last_seen_at` only when `needs_touch`, inside `ctx.waitUntil`.
- **Timeouts.** DB calls time out at `DB_TIMEOUT_MS`, Resend at `EMAIL_TIMEOUT_MS` with one retry using the same idempotency key. A timeout or exception after a reservation is a server fault (R-NOLOCK 3).
- **Resend.** Call `POST https://api.resend.com/emails` with `Authorization: Bearer <RESEND_API_KEY>` and header `Idempotency-Key: <flow_id>:<send_count>` (use a stable key per notification type and event for other mails). Send from a domain verified in Resend (SPF, DKIM, and DMARC set up in DNS). Send inside `ctx.waitUntil` so the response never waits and never changes with email success. Never log the email body or code. Put the provider behind an interface; tests use a stub. The Resend MCP is for development checks only; the Worker cannot call it.
- **Dummy flows match in shape, not in literal writes.** A dummy flow cannot write `aa_login_challenges` (foreign key to `aa_users`). Instead it makes the same number of DB round trips with the same statement shapes: `FLOW_START` with `user_id` NULL, the same `aa_auth_send_cap` and `aa_auth_bump` keys, one extra indexed no-op read in place of `ISSUE_CHALLENGE`, and the same `waitUntil` shape (a no-op task). The dummy phrase stage runs a dummy Argon2id verify against a fixed hash. The 200-request timing comparison in section 11 is noisy by nature: report medians, spread and the method, and do not weaken a rule to make it pass.
- **Log shape.** One line per request: request id, route, status, duration, tier, HMAC of email. No secrets.

# 7. Build order (each step ends with its focused tests passing)

**Run 1**
1. Baseline test run; recon (section 3); the note. **Stop for CP1.**
2. Migration on the dev branch only: Appendix A, then F1, then the functions from B, E7 and F2. Run the SQL tests below.
3. Crypto helpers (Appendix D) with unit tests; the Argon2id choice and CPU measurement (section 9).
4. Service layer in `src/auth/*`: reserve, settle, refund, entry routing, device resolve and claim, tier calculation, step-up, sessions and resume, permissions, bootstrap, reopen window, cleanup. **Stop for CP2** (SQL test counts, Argon2id CPU number, F4 flagged for human review).

**Run 2**

5. Middleware and routes from 5.7, behind the flag, using the per-route chain of constraint 2.10. Chain order: flag gate, request id, ip capture, body limit, origin and content-type guard, security headers, cookies, tier, auth. Include the snapshot test of constraint 2.10.
6. Resend provider and notification emails.
7. UI.
8. Scripts, cleanup wiring, rotation notes. **Stop for CP3.**

**Run 3**

9. Real UI tests (section 10) and attack phase (section 11).
10. Final report (section 12).

# 8. Database tests (run against a throwaway local Postgres for races, then once against the Neon dev branch through the real driver)

Appendices A to C were verified under their original unprefixed names; they are now prefixed and edited, so treat everything as needing a re-run. Re-run these every time SQL changes:
- Appendices A to D behavior: OTP verify and replay, stage advance guards, session create only from `ready`, TOTP step replay, backup code single use and parallel use, last-admin guard with the advisory lock for both demote and deactivate (40 trials each, zero admins left must be 0), throttle escalation 10, 20, 30 minutes, cap, 24 h reset, parallel reservation gives exactly the allowed attempts, cleanup never deletes an active lock.
- `aa_auth_refund`: refund after a non-lock reservation; refund after the reservation that tripped the lock (only when the lock is still the same); never below zero; parallel refunds never exceed reservations.
- `aa_auth_fuse_note`: counts, decays, never locks.
- `aa_auth_send_cap`: allows exactly the limit inside a window, refuses the rest without ever locking, resets after the window, parallel calls never exceed the limit, a continuous stream does not extend the window.
- `FLOW_START`: a device id of another user or a revoked device is not bound; dummy flows (`user_id` NULL) are created for both stages.
- `ADVANCE` with `via='device'` cannot reach `totp_enroll`. `DEVICE_FLOW_START` returns nothing for an admin with no authenticator or no phrase; after `ADMIN_RESET_TOTP` the device path is closed until re-enrollment completes.
- `TOTP_ENROLL_CONFIRM`: authenticator and the 8 backup codes are written together or not at all (inject a failure); a second confirm changes nothing.
- `PHRASE_RESET_CREATE`: a second reset replaces the first, including an expired unused one; two parallel creates leave exactly one active row. `DEVICE_INVITE_CREATE` likewise.
- Device claim: 20 parallel first logins give exactly one device and one session. A device revoked a moment before `FINISH_SESSION_ADMIN` cannot produce a session. A pending device activates only through a full login. `DEVICE_INVITE_ACCEPT` single use, expiry and cap. `DEVICE_REVOKE_GUARDED` refuses the last active device under concurrency. `SESSION_LOOKUP` returns nothing for an admin session whose device was revoked.
- `SESSION_DRIFT`: counts within the hour, resets after it, clears step-up on country change.
- Resume: `RESUME_PEEK` and `RESUME_START` return a row only for the exact rid, same prefix, country and user agent, tier normal, inside the absolute limit, matching `session_version`, active user and, for admins, the matching active device with an enrolled authenticator; test each condition alone. `FINISH_RESUME`: 20 parallel resumes of one rid give exactly one updated row; the old rid and the old session hash then match nothing; `absolute_expires_at` is unchanged; step-up is cleared; a device revoked a moment before cannot resume; a flow started on another prefix cannot finish. Idle-expired rows are not deleted by `SESSION_LOOKUP` or the Worker path, and `SESSION_LIST` hides them.
- Crypto edits (Appendix D): the `btoa` and `atob` helpers round-trip every byte value; `encryptSecret` and `decryptSecret` round-trip; `loadKey` rejects wrong lengths; the RFC 6238 vectors still pass.

Record the real output counts. Anything not run is reported as unverified.

# 9. Argon2id on Workers

Workers cannot compile WASM at runtime, and the free plan has a 10 ms CPU limit, so this feature needs the Workers Paid plan (see the setup section). Pick an implementation that ships importable WASM or is pure JS. Measure real CPU time with `wrangler dev`, then once on a deployed **preview** Worker, report the number, choose parameters from it, and confirm the Workers plan and its configured CPU limit allow it. If it does not fit, stop and report the options. The phrase stage must never exceed the CPU limit; if it does anyway, that is a refunded `503`.

# 10. Real UI tests (Playwright against `wrangler dev`, headless, traces on failure only)

Use a stub email provider that keeps the last code in memory and a read endpoint that exists only when `ALLOW_TEST_IP=1`. Use Cloudflare's Turnstile test keys (always-pass for the happy path, always-fail for the rejection test).

1. Staff: email, code, phrase, dashboard; hidden-permission actions are also refused by the server.
2. Admin first login: code, enroll phrase, enroll authenticator (compute TOTP in the test), backup codes shown once, session, device cookie set, device row exists.
3. Admin second login, same device: device option visible; phrase, authenticator, session; no email sent.
4. Admin in a fresh browser context: neutral message identical to an unknown email, no email sent, no later stage reachable, one alert email only.
5. Invite: create with step-up, accept in a new context, pending device cannot use the device path, a full login activates it.
6. Same device, different IP (`X-Test-IP`): strict banner, backup code refused, tighter lock, step-up on every write, alert email. A missing Turnstile token is rejected identically for unknown, staff and admin emails.
7. Mid-session IP drift: session survives and turns strict; a fourth prefix change within an hour ends it.
8. A forced server fault: the UI shows the "nothing was counted" message and the form still works.
9. Mobile viewport pass of the login and devices pages.
10. One real smoke send each to `delivered@resend.dev` and `bounced@resend.dev` to confirm a Resend failure does not change any response.
11. Authenticator reset: another admin resets it; the device path is refused for that admin; the email path ends in enrollment and shows new backup codes once.
12. Staff resume: log in, then open a new context keeping only the rid cookie (a browser close). The login page greets with the masked email and asks only for the phrase; no email is sent; the `sid` is unchanged; a second resume with the old rid fails.
13. Idle: move `last_seen_at` back 61 minutes in the test database; the next call gets `401`, the page shows the resume panel, the row still exists.
14. Absolute and mismatches: move `absolute_expires_at` into the past; then separately use a different prefix (`X-Test-IP`), a different user agent, logout, force logout and a device revoke. In every case no resume is offered, with an identical `{resume:false}` body, and the full path runs.
15. Admin resume: phrase then authenticator, no email; a backup code works; a strict-tier session is not offered resume.

# 11. Attack phase (you are the attacker)

Write `tests/auth/attack/*` and `docs/admin-auth/ATTACK_REPORT.md`. For each item run the attack against the running Worker and record result, evidence, fix and re-test. Fix real findings and re-run the whole attack suite until it is clean.

- **Brute force and races:** 60 parallel guesses at otp, phrase, totp, backup code and device phrase give exactly the allowed attempts; parallel correct submissions give one session; parallel invite accept gives one device; 20 parallel first logins give one device.
- **Lockout abuse:** a stranger on many IPs hammering a real email cannot lock out the real user or the trusted device; a stranger spamming `/auth/request` causes no email to admins and is capped for staff within the fixed hourly window; count Resend calls and confirm they stay inside the caps; confirm the send cap never produces a lock longer than the remainder of its window.
- **Stage and flow:** skip stages; reuse an old flow cookie; flow cookie of another user; expired or `done` flow; session creation from any stage but `ready`; device-path flow of an admin whose authenticator was reset.
- **Device:** cookie alone; admin A's cookie with admin B's email; revoked, expired, pending, tampered, truncated and oversized cookies; the cookie from another prefix must be strict, never normal; `X-Forwarded-For`, `X-Real-IP` and `X-Test-IP` ignored in a build without `ALLOW_TEST_IP`; IPv6 prefix evasion and IPv4-mapped forms.
- **Enumeration:** compare status, body, headers, cookies and median timing over 200 requests between unknown, staff, admin with device, admin without device and inactive user; differences must be within noise (report the method and spread). Include missing and invalid Turnstile tokens and non-ASCII emails.
- **Replay:** reused code, TOTP step, backup code, invite and reset token; a session cookie replayed after logout, revoke, `session_version` bump and device revoke.
- **Resume:** 60 parallel resume finishes give one session; a stolen rid without the phrase (and authenticator for admins) grants nothing; a rid from another network, user agent or browser; a rid after logout, force logout, deactivation, demotion, TOTP reset and device revoke; tampered, truncated and oversized rid; a rid replayed after rotation; `GET /auth/resume` and `POST /auth/resume/start` return the same body and headers for every ineligible case; repeated resumes can never extend the 5-hour limit.
- **Web:** cross-origin JSON POST, form POST, `text/plain` POST, method override headers, missing or `null` Origin, wrong Host, oversized and malformed JSON, duplicate keys, prototype keys, Unicode and case tricks in email, CRLF in headers, clickjacking, stored XSS through the UA label, open redirects, `__Host-` cookie tossing, SQL injection strings in every field.
- **Authorization:** every admin and report route with no session, a staff session, a staff session lacking the permission, an admin without step-up, an expired step-up, strict tier without a fresh step-up; IDOR on `sid`, device id and user id.
- **Leaks:** search all captured logs and every response in the suite for the codes, phrases, tokens, TOTP secrets, API keys and full emails used; zero hits.
- **Resilience:** drop the DB connection mid-request; Resend returning 500 and timing out; Turnstile unreachable. Each follows the documented behavior (fail closed, `503` plus refund, email failure invisible to the client).
- **Config audit:** cookie flags, security headers, no secrets or test flags in `wrangler` vars, no reachable route without the guard except the documented public auth routes. With the flag off, every new route returns `404` and the existing suite is unchanged. The constraint 2.10 snapshot test passes.

# 12. Final report (one message, at most 60 lines)

Branch and files changed; migration applied (dev branch only); baseline versus final existing test counts; Argon2id measured CPU, parameters and plan; counts from the SQL, unit, e2e and attack suites; attack findings (found, fixed, re-tested); the CI and Cloudflare Access findings from the recon note; the residual risk from R-NOLOCK 5; what is unverified or deferred; commands to rerun everything; how to turn the feature on (`ADMIN_AUTH_V2=1`) and off. Do not touch production. Stop after the report. Cutover of the existing admin routes to the new middleware is a separate task.

---

# Appendix A: schema (logic verified on PostgreSQL 16 under the original unprefixed names; now `aa_` prefixed, re-run section 8)

```sql
-- Auth schema (PostgreSQL / Neon). Phrase hash lives in aa_users.phrase_hash.
CREATE TABLE aa_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  phrase_hash     text,                                   -- Argon2id PHC string; NULL until enrolled
  role            text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  is_active       boolean NOT NULL DEFAULT true,
  session_version integer NOT NULL DEFAULT 1,             -- bump to kill every session of this user
  totp_secret_enc text,                                   -- AES-GCM encrypted, admins only
  totp_enabled_at timestamptz,
  totp_last_step  bigint,                                 -- anti-replay
  created_by      uuid REFERENCES aa_users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aa_user_permissions (
  user_id    uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  perm       text NOT NULL,                               -- must exist in the PERMISSIONS registry (app-enforced)
  granted_by uuid REFERENCES aa_users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, perm)
);

-- One row per user, reused. Unexpired row = same code (idempotent send).
CREATE TABLE aa_login_challenges (
  user_id      uuid PRIMARY KEY REFERENCES aa_users(id) ON DELETE CASCADE,
  nonce        bytea NOT NULL,                            -- code = f(HMAC(OTP_KEY, user_id || nonce)); no plaintext stored
  code_mac     bytea NOT NULL,                            -- HMAC(OTP_KEY, "mac:" || user_id || ":" || code)
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  send_count   smallint NOT NULL DEFAULT 1,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);

-- Server-side login state machine. email kept even for unknown emails (user_id NULL).
CREATE TABLE aa_auth_flows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  email      text NOT NULL,
  user_id    uuid REFERENCES aa_users(id) ON DELETE CASCADE,
  pending_totp_enc text,                                  -- admin TOTP secret awaiting first valid code
  stage      text NOT NULL CHECK (stage IN ('otp','phrase','enroll_phrase','totp','totp_enroll','ready','done')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE aa_sessions (
  id_hash             bytea PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  session_version     integer NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  sid                 uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,  -- public handle for "my sessions"; never the token hash
  stepup_until        timestamptz,                                      -- fresh re-authentication window for sensitive actions
  ip                  text,
  ua                  text                                              -- truncated user agent, display only
);
CREATE INDEX aa_sessions_user_idx ON aa_sessions (user_id);

CREATE TABLE aa_phrase_resets (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES aa_users(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE UNIQUE INDEX aa_phrase_resets_one_active ON aa_phrase_resets (user_id) WHERE used_at IS NULL;

CREATE TABLE aa_recovery_codes (
  user_id   uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  used_at   timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE aa_auth_throttle (
  key          text PRIMARY KEY,                          -- "otp:<hmac(email)>:<ip>", "fuse:<hmac(email)>", "send:..."
  thr          smallint NOT NULL,                         -- failures per round (3 pair, 9 fuse) or the send-cap limit
  fails        smallint NOT NULL,
  round        integer  NOT NULL,
  locked_until timestamptz,
  last_fail_at timestamptz NOT NULL                       -- for send-cap keys this is the window START (see E7)
);

CREATE TABLE aa_audit_events (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor_id  uuid,
  target_id uuid,
  event     text NOT NULL,
  ip        text,
  meta      jsonb                                         -- never codes, phrases or free-text reasons
);
CREATE INDEX aa_audit_target_idx ON aa_audit_events (target_id, at DESC);
```

# Appendix B: throttle function (logic verified; now prefixed)

The old two-key `auth_reserve` (per-email fuse that blocked) was superseded and is **dropped** in this revision so it cannot be called by mistake. Use `aa_auth_reserve_v2` and `aa_auth_fuse_note` (Appendix F2). `aa_auth_bump` is for lock keys only (pair, device, strict). It is never used for `send:` keys (use `aa_auth_send_cap`, Appendix E7).

```sql
-- One failed-attempt reservation for one key. Atomic per row (ON CONFLICT row lock).
-- Escalation: every p_thr reserved attempts => lock for LEAST(step * round, max) minutes.
CREATE OR REPLACE FUNCTION aa_auth_bump(
  p_key text, p_thr int,
  p_step_min int DEFAULT 10, p_max_min int DEFAULT 1440, p_decay interval DEFAULT '24 hours'
) RETURNS TABLE (allowed boolean, locked_until timestamptz)
LANGUAGE plpgsql AS $$
DECLARE r aa_auth_throttle%ROWTYPE;
BEGIN
  -- quiet period: forget old failures and the round counter
  UPDATE aa_auth_throttle t SET fails = 0, round = 0, locked_until = NULL
   WHERE t.key = p_key AND t.last_fail_at < now() - p_decay;

  INSERT INTO aa_auth_throttle AS t (key, thr, fails, round, locked_until, last_fail_at)
  VALUES (p_key, p_thr, 1, 0, NULL, now())
  ON CONFLICT (key) DO UPDATE SET
    thr          = EXCLUDED.thr,
    fails        = CASE WHEN t.fails + 1 >= EXCLUDED.thr THEN 0 ELSE t.fails + 1 END,
    round        = CASE WHEN t.fails + 1 >= EXCLUDED.thr THEN t.round + 1 ELSE t.round END,
    locked_until = CASE WHEN t.fails + 1 >= EXCLUDED.thr
                        THEN now() + make_interval(mins => LEAST(p_step_min * (t.round + 1), p_max_min))
                        ELSE t.locked_until END,
    last_fail_at = now()
  WHERE t.locked_until IS NULL OR t.locked_until <= now()   -- evaluated on the locked, latest row version
  RETURNING * INTO r;

  IF FOUND THEN
    RETURN QUERY SELECT true, CASE WHEN r.locked_until > now() THEN r.locked_until END;
  ELSE
    RETURN QUERY SELECT false, (SELECT x.locked_until FROM aa_auth_throttle x WHERE x.key = p_key);
  END IF;
END $$;
```

# Appendix C: queries (logic verified, now `aa_` prefixed; edits are marked)

Edited versus the verified original: `SESSION_LOOKUP`, `BOOTSTRAP_ADMIN`, `ADVANCE` (device-path guard), `FINISH_SESSION` (staff only, resume columns), `SESSION_LIST` (hides idle rows). `TOTP_ENROLL_CONFIRM` moved to Appendix E3 (now writes the backup codes too). `PHRASE_RESET` creation is Appendix E4. Edited queries are **not** covered by the original 91 checks; test them in section 8.

```sql
-- name: ISSUE_CHALLENGE
-- $1 user_id, $2 nonce, $3 code_mac, $4 ttl_secs, $5 resend_cooldown_secs, $6 resend_max
INSERT INTO aa_login_challenges AS c (user_id, nonce, code_mac, expires_at, send_count, last_sent_at)
VALUES ($1, $2, $3, now() + make_interval(secs => $4::float8), 1, now())
ON CONFLICT (user_id) DO UPDATE SET
  nonce      = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL THEN EXCLUDED.nonce      ELSE c.nonce END,
  code_mac   = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL THEN EXCLUDED.code_mac   ELSE c.code_mac END,
  expires_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL THEN EXCLUDED.expires_at ELSE c.expires_at END,
  used_at    = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL THEN NULL                ELSE c.used_at END,
  send_count = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL THEN 1
                    WHEN c.send_count < $6::int AND now() - c.last_sent_at >= make_interval(secs => $5::float8) THEN c.send_count + 1
                    ELSE c.send_count END,
  last_sent_at = CASE WHEN c.expires_at <= now() OR c.used_at IS NOT NULL
                        OR (c.send_count < $6::int AND now() - c.last_sent_at >= make_interval(secs => $5::float8))
                      THEN now() ELSE c.last_sent_at END
RETURNING nonce, expires_at, send_count, (last_sent_at = now()) AS send_now;

-- name: VERIFY_OTP
-- $1 user_id, $2 code_mac, $3 flow_id. Consumes the code and advances the flow in ONE statement.
WITH used AS (
  UPDATE aa_login_challenges SET used_at = now()
  WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() AND code_mac = $2
    AND EXISTS (SELECT 1 FROM aa_auth_flows WHERE id = $3 AND user_id = $1 AND stage = 'otp' AND expires_at > now())
  RETURNING user_id
)
UPDATE aa_auth_flows f
   SET stage = CASE WHEN u.phrase_hash IS NULL THEN 'enroll_phrase' ELSE 'phrase' END
  FROM used JOIN aa_users u ON u.id = used.user_id
 WHERE f.id = $3 AND f.stage = 'otp'
RETURNING f.stage;

-- name: ENROLL_PHRASE
-- $1 flow_id, $2 phrase_hash. Sets the phrase only if none exists, and advances, atomically.
WITH setp AS (
  UPDATE aa_users SET phrase_hash = $2
    FROM aa_auth_flows f
   WHERE f.id = $1 AND f.stage = 'enroll_phrase' AND f.expires_at > now()
     AND aa_users.id = f.user_id AND aa_users.phrase_hash IS NULL AND aa_users.is_active
  RETURNING aa_users.id, aa_users.role, aa_users.totp_enabled_at
)
UPDATE aa_auth_flows f
   SET stage = CASE WHEN setp.role <> 'admin' THEN 'ready'
                    WHEN setp.totp_enabled_at IS NULL THEN 'totp_enroll' ELSE 'totp' END
  FROM setp
 WHERE f.id = $1 AND f.stage = 'enroll_phrase'
RETURNING f.stage;

-- name: ADVANCE   (EDITED: a device-path or resume flow can never reach totp_enroll)
-- $1 flow_id, $2 from_stage. Called after the factor for $2 was verified by the app.
UPDATE aa_auth_flows f
   SET stage = CASE
         WHEN f.stage = 'phrase' THEN CASE WHEN u.role <> 'admin' THEN 'ready'
                                           WHEN u.totp_enabled_at IS NULL THEN 'totp_enroll' ELSE 'totp' END
         ELSE 'ready' END
  FROM aa_users u
 WHERE f.id = $1 AND f.stage = $2 AND f.stage IN ('phrase','totp','totp_enroll')
   AND f.expires_at > now() AND u.id = f.user_id AND u.is_active
   AND NOT (f.via IN ('device','resume') AND u.totp_enabled_at IS NULL)
RETURNING f.stage;

-- name: FINISH_SESSION   (STAFF ONLY. Admins use FINISH_SESSION_ADMIN in Appendix F.)
-- $1 flow_id, $2 session_id_hash, $3 absolute_ttl_secs (18000), $4 ip, $5 user_agent,
-- $6 new_resume_hash, $7 ip_prefix, $8 country. Only a 'ready' non-resume flow can become a session.
-- (Resume flows use FINISH_RESUME in Appendix F6.)
WITH f AS (
  UPDATE aa_auth_flows SET stage = 'done'
   WHERE id = $1 AND stage = 'ready' AND via <> 'resume' AND expires_at > now()
  RETURNING user_id, via
)
INSERT INTO aa_sessions (id_hash, user_id, session_version, absolute_expires_at, ip, ua, login_via, ip_prefix, country, resume_hash)
SELECT $2, f.user_id, u.session_version, now() + make_interval(secs => $3::float8), $4, left($5, 120), f.via, $7, $8, $6
  FROM f JOIN aa_users u ON u.id = f.user_id AND u.is_active AND u.role <> 'admin'
RETURNING user_id;

-- name: SESSION_LOOKUP   (EDITED: returns tier, prefix, country, drift, idle_secs; admin sessions need an active device)
-- $1 session_id_hash, $2 max_idle_secs (pass 3600; the Worker enforces the role and tier limit from idle_secs and never deletes an idle row)
SELECT u.id, u.email, u.role, s.sid, s.device_id, s.tier, s.ip_prefix, s.country, s.drift_count, s.drift_at,
       ARRAY(SELECT perm FROM aa_user_permissions WHERE user_id = u.id) AS perms,
       s.last_seen_at < now() - interval '60 seconds' AS needs_touch,
       extract(epoch FROM now() - s.last_seen_at)::int AS idle_secs,
       COALESCE(s.stepup_until > now(), false) AS stepup_ok
  FROM aa_sessions s JOIN aa_users u ON u.id = s.user_id
 WHERE s.id_hash = $1
   AND s.absolute_expires_at > now()
   AND s.last_seen_at > now() - make_interval(secs => $2::float8)
   AND s.session_version = u.session_version
   AND u.is_active
   AND (u.role <> 'admin' OR EXISTS (SELECT 1 FROM aa_admin_devices d WHERE d.id = s.device_id AND d.status = 'active'));

-- name: TOTP_CONSUME_STEP
-- $1 user_id, $2 time_step. Replay guard: a step can be used once, and only moves forward.
UPDATE aa_users SET totp_last_step = $2
 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
RETURNING id;

-- name: PHRASE_RESET_CONSUME
-- $1 token_hash, $2 new_phrase_hash. Single-use link; also kills every existing session.
WITH r AS (
  UPDATE aa_phrase_resets SET used_at = now()
   WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
  RETURNING user_id
)
UPDATE aa_users u SET phrase_hash = $2, session_version = u.session_version + 1
  FROM r WHERE u.id = r.user_id AND u.is_active
RETURNING u.id;

-- name: RECOVERY_CODE_CONSUME
-- $1 user_id, $2 code_hash
UPDATE aa_recovery_codes SET used_at = now()
 WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
RETURNING user_id;

-- name: DEMOTE_ADMIN_GUARDED
-- Run as the 2nd statement of one transaction whose 1st statement is: SELECT pg_advisory_xact_lock(7001);
-- $1 target_user_id. Refuses to remove the last active admin.
UPDATE aa_users SET role = 'staff', session_version = session_version + 1
 WHERE id = $1 AND role = 'admin'
   AND (SELECT count(*) FROM aa_users WHERE role = 'admin' AND is_active) > 1
RETURNING id;

-- name: AUTH_CLEAR
-- $1 text[] of throttle keys. Called after a factor is verified successfully.
DELETE FROM aa_auth_throttle WHERE key = ANY($1::text[]);

-- name: RECOVERY_LOGIN
-- $1 user_id, $2 recovery_code_hash, $3 flow_id. Backup code used INSTEAD of the authenticator code. One statement.
-- remaining = unused codes left after this one (count sees the pre-statement snapshot, hence -1).
WITH r AS (
  UPDATE aa_recovery_codes SET used_at = now()
   WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
     AND EXISTS (SELECT 1 FROM aa_auth_flows WHERE id = $3 AND user_id = $1 AND stage = 'totp' AND expires_at > now())
  RETURNING user_id
), adv AS (
  UPDATE aa_auth_flows SET stage = 'ready'
    FROM r WHERE aa_auth_flows.id = $3 AND aa_auth_flows.stage = 'totp'
  RETURNING aa_auth_flows.stage
)
SELECT (SELECT stage FROM adv) AS stage,
       (SELECT count(*) FROM aa_recovery_codes WHERE user_id = $1 AND used_at IS NULL)::int - 1 AS remaining
 WHERE EXISTS (SELECT 1 FROM adv);

-- name: REGEN_RECOVERY
-- $1 user_id, $2 bytea[] of new code hashes. Replaces ALL codes atomically (needs a fresh step-up first).
WITH d AS (DELETE FROM aa_recovery_codes WHERE user_id = $1)
INSERT INTO aa_recovery_codes (user_id, code_hash)
SELECT $1, unnest($2::bytea[])
RETURNING 1;

-- name: STEPUP_GRANT
-- $1 session_id_hash, $2 window_secs (300 normal, 120 strict). Call only after a fresh TOTP step or recovery code was consumed.
UPDATE aa_sessions SET stepup_until = now() + make_interval(secs => $2::float8)
 WHERE id_hash = $1 AND absolute_expires_at > now()
RETURNING stepup_until;

-- name: SESSION_LIST   (EDITED: hides idle rows, which are only resume rights)
-- $1 user_id, $2 current_session_hash, $3 idle_secs (3600)
SELECT sid, created_at, last_seen_at, ip, ua, (id_hash = $2) AS current
  FROM aa_sessions WHERE user_id = $1 AND absolute_expires_at > now()
   AND last_seen_at > now() - make_interval(secs => $3::float8)
 ORDER BY last_seen_at DESC;

-- name: SESSION_REVOKE
-- $1 sid, $2 user_id. A user can only end their own sessions.
DELETE FROM aa_sessions WHERE sid = $1 AND user_id = $2 RETURNING sid;

-- name: SESSION_REVOKE_OTHERS
-- $1 user_id, $2 current_session_hash
DELETE FROM aa_sessions WHERE user_id = $1 AND id_hash <> $2 RETURNING sid;

-- name: FORCE_LOGOUT_USER
-- $1 target_user_id. Admin action (needs step-up). Kills every session at once.
WITH v AS (UPDATE aa_users SET session_version = session_version + 1 WHERE id = $1 RETURNING id)
DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM v) RETURNING sid;

-- name: ADMIN_RESET_TOTP
-- $1 target_admin_id, $2 acting_admin_id. Another admin resets a lost authenticator; target re-enrolls at next login.
-- The target's devices stay active, but DEVICE_FLOW_START now refuses the device path until TOTP is enrolled again.
WITH u AS (
  UPDATE aa_users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                   session_version = session_version + 1
   WHERE id = $1 AND id <> $2 AND role = 'admin' RETURNING id
), d AS (DELETE FROM aa_recovery_codes WHERE user_id IN (SELECT id FROM u)),
   s AS (DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM u))
SELECT id FROM u;

-- name: BOOTSTRAP_ADMIN   (EDITED: also opens the first-device window; needs F1 applied)
-- $1 email (already normalized), $2 window_hours. Operator script only; refuses if any admin already exists.
INSERT INTO aa_users (email, role, device_window_until)
SELECT $1, 'admin', now() + make_interval(hours => $2::int) WHERE NOT EXISTS (SELECT 1 FROM aa_users WHERE role = 'admin')
RETURNING id;

-- name: CLEAN_FLOWS
-- $1 batch_limit. Run each CLEAN_* repeatedly until n = 0.
WITH d AS (DELETE FROM aa_auth_flows WHERE id IN (SELECT id FROM aa_auth_flows WHERE expires_at < now() - interval '1 day' LIMIT $1) RETURNING 1)
SELECT count(*)::int AS n FROM d;

-- name: CLEAN_SESSIONS
WITH d AS (DELETE FROM aa_sessions WHERE id_hash IN (SELECT id_hash FROM aa_sessions WHERE absolute_expires_at < now() LIMIT $1) RETURNING 1)
SELECT count(*)::int AS n FROM d;

-- name: CLEAN_CHALLENGES
WITH d AS (DELETE FROM aa_login_challenges WHERE user_id IN (SELECT user_id FROM aa_login_challenges WHERE expires_at < now() - interval '1 day' LIMIT $1) RETURNING 1)
SELECT count(*)::int AS n FROM d;

-- name: CLEAN_THROTTLE
WITH d AS (DELETE FROM aa_auth_throttle WHERE key IN (SELECT key FROM aa_auth_throttle WHERE last_fail_at < now() - interval '48 hours' AND (locked_until IS NULL OR locked_until < now()) LIMIT $1) RETURNING 1)
SELECT count(*)::int AS n FROM d;

-- name: CLEAN_RESETS
WITH d AS (DELETE FROM aa_phrase_resets WHERE token_hash IN (SELECT token_hash FROM aa_phrase_resets WHERE expires_at < now() - interval '7 days' LIMIT $1) RETURNING 1)
SELECT count(*)::int AS n FROM d;
```

Note on `FINISH_SESSION`: it now also requires `u.role <> 'admin'`, so a staff-only query can never mint an admin session even by mistake.

# Appendix D: crypto helpers (logic verified on Node 22; EDITED here to drop `Buffer`, so re-run the crypto tests; WebCrypto only)

```js
// WebCrypto-only helpers (run unchanged on Cloudflare Workers and Node 20+). No Buffer, no nodejs_compat.
const enc = new TextEncoder();
const ALPHABET = '0123456789ABCDEF!#$%&*+?';          // 16 hex + 8 symbols = 24 symbols (no look-alikes)
export const CODE_LEN = 10;

// base64 helpers (replace Buffer)
export const toB64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64u = (u8) => toB64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Secrets are standard base64 of exactly 32 bytes. Fail closed at startup if the length is wrong.
export function loadKey(b64, name = 'key') {
  const k = fromB64(b64);
  if (k.length !== 32) throw new Error(`${name} must be 32 bytes`);
  return k;
}

// Email: trim, lowercase, ASCII only, <= 254 chars, exactly one '@'. Returns null when invalid (treat as unknown email).
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 3 || e.length > 254 || !/^[\x21-\x7e]+$/.test(e)) return null;
  const parts = e.split('@');
  return parts.length === 2 && parts[0] && parts[1] ? e : null;
}

// Masked hint for the resume panel: first character of the local part and of the domain, the rest hidden.
export const maskEmail = (e) => { const [l, d] = e.split('@'); return `${l[0]}***@${d[0]}***`; };

const hmacKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const hmac = async (raw, msg) => new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(raw), enc.encode(msg)));

// Keyed identifier of an email for throttle keys and logs (never the raw email).
export const emailHmac = async (throttleKey, normalizedEmail) => b64u(await hmac(throttleKey, `email:${normalizedEmail}`));

// Deterministic code from (server key, user, nonce): resend = recompute, nothing sensitive stored.
// Rejection sampling: bytes >= 240 are skipped, so 240 % 24 == 0 gives zero modulo bias.
export async function deriveCode(otpKey, userId, nonce) {
  let out = '', counter = 0;
  while (out.length < CODE_LEN) {
    const block = await hmac(otpKey, `code:${userId}:${b64u(nonce)}:${counter++}`);
    for (const b of block) { if (b < 240) { out += ALPHABET[b % 24]; if (out.length === CODE_LEN) break; } }
  }
  return out;
}
export const codeMac = (otpKey, userId, code) => hmac(otpKey, `mac:${userId}:${code}`);

export const randomToken = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
export const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));

export function safeEqual(a, b) {                       // constant-time for equal-length strings
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// AES-GCM for the TOTP secret at rest. key32 = 32 raw bytes from loadKey.
export async function encryptSecret(key32, plain) {
  const k = await crypto.subtle.importKey('raw', key32, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(plain)));
  const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12);
  return toB64(out);
}
export async function decryptSecret(key32, blob) {
  const raw = fromB64(blob); const k = await crypto.subtle.importKey('raw', key32, 'AES-GCM', false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, k, raw.subarray(12)));
}

// TOTP (RFC 6238, SHA-1, 6 digits, 30 s). Returns the matched step so it can be replay-guarded in SQL.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const b32decode = (s) => { let bits = '', out = []; for (const c of s.replace(/=+$/, '')) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return new Uint8Array(out); };
export const newTotpSecret = () => { const r = crypto.getRandomValues(new Uint8Array(20)); let bits = ''; for (const b of r) bits += b.toString(2).padStart(8, '0');
  let s = ''; for (let i = 0; i < bits.length; i += 5) s += B32[parseInt(bits.slice(i, i + 5), 2)]; return s; };
export async function hotp(secretB32, counter, digits = 6) {
  const k = await crypto.subtle.importKey('raw', b32decode(secretB32), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8); new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg)); const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export async function totpMatch(secretB32, code, nowMs = Date.now(), window = 1) {
  const step = Math.floor(nowMs / 30000);
  for (let d = -window; d <= window; d++) if (safeEqual(await hotp(secretB32, step + d), code)) return step + d;
  return null;
}
```

# Appendix E: additions in this revision (UNVERIFIED; test in section 8, fix what fails)

## E1. FLOW_START (email path, and dummy flows of both kinds)

```sql
-- name: FLOW_START
-- $1 flow_token_hash, $2 email (normalized), $3 user_id (NULL for a dummy flow), $4 flow_ttl_secs,
-- $5 device_id (NULL if none), $6 ip_prefix, $7 country, $8 stage ('otp' or 'phrase'), $9 via ('email' or 'device')
-- A device id is bound only if it belongs to that user and is active or pending; otherwise device_id stays NULL.
-- Real device-path flows use DEVICE_FLOW_START (F3). A dummy device-path flow uses this with $3 NULL, $8 'phrase', $9 'device'.
INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, via, device_id, expires_at, ip_prefix, country)
VALUES ($1, $2, $3, $8, $9,
        (SELECT d.id FROM aa_admin_devices d WHERE d.id = $5 AND d.user_id = $3 AND d.status IN ('active','pending')),
        now() + make_interval(secs => $4::float8), $6, $7)
RETURNING id;
```

## E2. TOTP_PENDING_SET

```sql
-- name: TOTP_PENDING_SET
-- $1 flow_id, $2 encrypted secret. Once per flow; the secret is shown to the admin once and a reload needs a new flow.
UPDATE aa_auth_flows SET pending_totp_enc = $2
 WHERE id = $1 AND stage = 'totp_enroll' AND pending_totp_enc IS NULL AND expires_at > now()
RETURNING id;
```

## E3. TOTP_ENROLL_CONFIRM (replaces the Appendix C version; also writes the 8 backup codes)

```sql
-- name: TOTP_ENROLL_CONFIRM
-- $1 flow_id, $2 time_step of the code the admin just proved, $3 bytea[] of the 8 backup-code hashes.
-- One statement: authenticator on, flow to 'ready', codes stored. All or nothing. Return the plain codes to the
-- admin only when this statement returns a row.
WITH e AS (
  UPDATE aa_users u
     SET totp_secret_enc = f.pending_totp_enc, totp_enabled_at = now(), totp_last_step = $2
    FROM aa_auth_flows f
   WHERE f.id = $1 AND f.stage = 'totp_enroll' AND f.expires_at > now()
     AND f.pending_totp_enc IS NOT NULL AND u.id = f.user_id AND u.totp_enabled_at IS NULL
  RETURNING u.id
), adv AS (
  UPDATE aa_auth_flows f SET stage = 'ready', pending_totp_enc = NULL
    FROM e WHERE f.id = $1 AND f.stage = 'totp_enroll'
  RETURNING f.stage
), rc AS (
  INSERT INTO aa_recovery_codes (user_id, code_hash)
  SELECT e.id, unnest($3::bytea[]) FROM e
  RETURNING 1
)
SELECT (SELECT stage FROM adv) AS stage WHERE EXISTS (SELECT 1 FROM adv);
```

## E4. PHRASE_RESET_CREATE (one transaction, two statements)

```sql
-- name: PHRASE_RESET_CREATE
-- Statement 1 and 2 run in ONE transaction. $1 target_user_id, $2 token_hash, $3 created_by, $4 ttl_secs.
-- Replaces any unused older reset, expired or not, so the one-active unique index never blocks a new reset.
DELETE FROM aa_phrase_resets WHERE user_id = $1 AND used_at IS NULL;

INSERT INTO aa_phrase_resets (token_hash, user_id, created_by, expires_at)
SELECT $2, u.id, $3, now() + make_interval(secs => $4::float8)
  FROM aa_users u WHERE u.id = $1 AND u.is_active
RETURNING token_hash;
```

## E5. USER_CREATE

```sql
-- name: USER_CREATE
-- $1 email (normalized), $2 role ('staff' or 'admin'), $3 created_by, $4 window_hours (first-device window for admins).
-- Admin creation needs a fresh step-up in the caller. A duplicate email returns no row (ON CONFLICT DO NOTHING).
INSERT INTO aa_users (email, role, created_by, device_window_until)
VALUES ($1, $2, $3, CASE WHEN $2 = 'admin' THEN now() + make_interval(hours => $4::int) END)
ON CONFLICT (email) DO NOTHING
RETURNING id;
```

## E6. DEACTIVATE_GUARDED

```sql
-- name: DEACTIVATE_GUARDED
-- Second statement of one transaction whose first is: SELECT pg_advisory_xact_lock(7001);
-- $1 target_user_id. Refuses to deactivate the last active admin. session_version bump ends every session.
UPDATE aa_users SET is_active = false, session_version = session_version + 1
 WHERE id = $1 AND is_active
   AND (role <> 'admin' OR (SELECT count(*) FROM aa_users WHERE role = 'admin' AND is_active) > 1)
RETURNING id;
```

Other small queries (set or revoke a permission, audit insert, flow stage-fail counting) are not listed. Write them under the same rules: parameterized, one guarded statement each, and a transaction where more than one statement must succeed together.

## E7. aa_auth_send_cap (fixed window, never locks)

```sql
-- Hourly send caps for `send:` keys. Returns true if this send is allowed, false if the cap is reached.
-- Fixed window: last_fail_at holds the window START and is NOT moved by later calls, so a steady stream cannot extend
-- the window. After p_window the count restarts. Nothing here ever sets locked_until.
CREATE OR REPLACE FUNCTION aa_auth_send_cap(p_key text, p_limit int, p_window interval DEFAULT '1 hour')
RETURNS boolean LANGUAGE sql AS $$
  WITH i AS (
    INSERT INTO aa_auth_throttle AS t (key, thr, fails, round, locked_until, last_fail_at)
    VALUES (p_key, p_limit, 1, 0, NULL, now())
    ON CONFLICT (key) DO UPDATE SET
      thr          = EXCLUDED.thr,
      fails        = CASE WHEN t.last_fail_at < now() - p_window THEN 1 ELSE t.fails + 1 END,
      last_fail_at = CASE WHEN t.last_fail_at < now() - p_window THEN now() ELSE t.last_fail_at END
    WHERE t.last_fail_at < now() - p_window OR t.fails < p_limit
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM i);
$$;
```

Keys: `send:<emailHmac>` with `OTP_SENDS_PER_HOUR`, and `send:<emailHmac>:<ip>` with `OTP_SENDS_PER_HOUR_IP`. A refused send still returns the same `202` and the same body; it only means no new code or email is issued. Dummy flows call the same function with the same keys.

# Appendix F: v2 additions (UNVERIFIED drafts, now `aa_` prefixed; test in section 8, fix what fails)

## F1. Schema

```sql
ALTER TABLE aa_users ADD COLUMN device_window_until timestamptz;   -- open = first admin device may be claimed

CREATE TABLE aa_admin_devices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,                          -- SHA-256 of the __Host-did token
  status         text NOT NULL CHECK (status IN ('pending','active','revoked')),
  label          text,                                           -- truncated user agent, display only
  created_via    text NOT NULL CHECK (created_via IN ('first_login','invite','admin_invite','operator')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,                           -- sliding
  pending_until  timestamptz,
  revoked_at     timestamptz,
  last_ip        text,
  last_ip_prefix text,
  last_country   text
);
CREATE INDEX aa_admin_devices_user_idx ON aa_admin_devices (user_id) WHERE status <> 'revoked';

CREATE TABLE aa_device_invites (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES aa_users(id) ON DELETE CASCADE,   -- the admin the device is for
  created_by uuid NOT NULL REFERENCES aa_users(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE UNIQUE INDEX aa_device_invites_one_active ON aa_device_invites (user_id) WHERE used_at IS NULL;

ALTER TABLE aa_auth_flows ADD COLUMN device_id uuid REFERENCES aa_admin_devices(id) ON DELETE SET NULL,
                          ADD COLUMN via text NOT NULL DEFAULT 'email' CHECK (via IN ('email','device','resume')),
                          ADD COLUMN resume_hash bytea,
                          ADD COLUMN ip_prefix text, ADD COLUMN country text;
ALTER TABLE aa_sessions   ADD COLUMN device_id uuid REFERENCES aa_admin_devices(id) ON DELETE SET NULL,
                          ADD COLUMN login_via text NOT NULL DEFAULT 'email' CHECK (login_via IN ('email','device')),
                          ADD COLUMN ip_prefix text, ADD COLUMN country text,
                          ADD COLUMN tier text NOT NULL DEFAULT 'normal' CHECK (tier IN ('normal','strict')),
                          ADD COLUMN drift_count smallint NOT NULL DEFAULT 0, ADD COLUMN drift_at timestamptz,
                          ADD COLUMN resume_hash bytea UNIQUE;     -- hash of the __Host-rid cookie; the resume right
```

Apply F1 right after Appendix A in the same migration, because `SESSION_LOOKUP`, `BOOTSTRAP_ADMIN` and `FLOW_START` use these columns.

## F2. Throttle changes

```sql
-- Reserve on ONE key only (pair, trusted-device key or strict key). Never returns a lock caused by another client.
CREATE OR REPLACE FUNCTION aa_auth_reserve_v2(p_key text, p_thr int, p_step_min int, p_max_min int)
RETURNS TABLE (allowed boolean, locked_until timestamptz)
LANGUAGE sql AS $$ SELECT * FROM aa_auth_bump(p_key, p_thr, p_step_min, p_max_min); $$;

-- Non-blocking per-email counter. Returns true when friction (audit event, alert email) should be on.
CREATE OR REPLACE FUNCTION aa_auth_fuse_note(p_key text, p_thr int DEFAULT 9, p_decay interval DEFAULT '1 hour')
RETURNS boolean LANGUAGE plpgsql AS $$
  INSERT INTO aa_auth_throttle AS t (key, thr, fails, round, locked_until, last_fail_at)
  VALUES (p_key, p_thr, 1, 0, NULL, now())
  ON CONFLICT (key) DO UPDATE SET
    fails        = CASE WHEN t.last_fail_at < now() - p_decay THEN 1 ELSE LEAST(t.fails + 1, 32000) END,
    last_fail_at = now()
  RETURNING t.fails >= p_thr;
$$;

-- Refund ONE reservation after a server fault of ours. p_lock = the locked_until that reservation returned (NULL if none).
-- Never call for a wrong answer or a client abort.
CREATE OR REPLACE FUNCTION aa_auth_refund(p_key text, p_lock timestamptz DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF p_lock IS NULL THEN
    UPDATE aa_auth_throttle SET fails = GREATEST(fails - 1, 0)
     WHERE key = p_key AND fails > 0 AND (locked_until IS NULL OR locked_until <= now());
  ELSE   -- that reservation tripped the lock: undo it only if the lock is still exactly that one
    UPDATE aa_auth_throttle SET fails = thr - 1, round = GREATEST(round - 1, 0), locked_until = NULL
     WHERE key = p_key AND locked_until = p_lock;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
```

Request lifecycle: reserve, verify, settle. Success calls `AUTH_CLEAR`. A wrong answer adds nothing more and calls `aa_auth_fuse_note`. A caught server fault calls `aa_auth_refund` and answers `503`. Hourly send caps use `aa_auth_send_cap` (E7), never these functions.

## F3. Device queries

```sql
-- name: DEVICE_RESOLVE
-- $1 token_hash of the cookie (or NULL), $2 email. One round trip for entry routing and tier.
SELECT u.id, u.role, u.is_active,
       u.phrase_hash IS NOT NULL AS has_phrase, u.totp_enabled_at IS NOT NULL AS has_totp,
       COALESCE(u.device_window_until > now(), false) AS window_open,
       d.id AS device_id, d.status AS device_status, d.last_ip_prefix, d.last_country
  FROM aa_users u
  LEFT JOIN aa_admin_devices d ON d.user_id = u.id AND d.token_hash = $1
        AND d.status IN ('active','pending') AND d.expires_at > now()
        AND (d.status = 'active' OR d.pending_until > now())
 WHERE u.email = $2;

-- name: DEVICE_TOUCH
-- $1 device_id, $2 ttl_secs. Sliding expiry, at most once a minute.
UPDATE aa_admin_devices SET last_seen_at = now(), expires_at = now() + make_interval(secs => $2::float8)
 WHERE id = $1 AND status = 'active' AND last_seen_at < now() - interval '60 seconds'
RETURNING id;

-- name: DEVICE_SET_LAST_IP
-- $1 device_id, $2 ip, $3 prefix, $4 country. Called after step-up in a strict session (rule 7).
UPDATE aa_admin_devices SET last_ip = $2, last_ip_prefix = $3, last_country = $4
 WHERE id = $1 AND status = 'active'
RETURNING id;

-- name: DEVICE_FLOW_START   (EDITED: needs phrase AND enrolled authenticator, so a TOTP reset closes the device path)
-- $1 flow_token_hash, $2 email, $3 device_id, $4 flow_ttl_secs, $5 ip_prefix, $6 country.
-- Device path only, for a matching ACTIVE device.
INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, via, device_id, expires_at, ip_prefix, country)
SELECT $1, $2, d.user_id, 'phrase', 'device', d.id, now() + make_interval(secs => $4::float8), $5, $6
  FROM aa_admin_devices d JOIN aa_users u ON u.id = d.user_id AND u.is_active AND u.role = 'admin'
 WHERE d.id = $3 AND d.status = 'active' AND d.expires_at > now() AND u.email = $2
   AND u.phrase_hash IS NOT NULL AND u.totp_enabled_at IS NOT NULL
RETURNING id;

-- name: DEVICE_INVITE_CREATE   (EDITED: one transaction, two statements, so the unique index never races the delete)
-- $1 target_admin_id, $2 created_by, $3 token_hash, $4 ttl_secs. Replaces an unused old invite. Needs step-up.
DELETE FROM aa_device_invites WHERE user_id = $1 AND used_at IS NULL;

INSERT INTO aa_device_invites (token_hash, user_id, created_by, expires_at)
SELECT $3, u.id, $2, now() + make_interval(secs => $4::float8)
  FROM aa_users u WHERE u.id = $1 AND u.role = 'admin' AND u.is_active
RETURNING token_hash;

-- name: DEVICE_INVITE_ACCEPT
-- $1 invite_token_hash, $2 new_device_token_hash, $3 user_agent, $4 pending_secs, $5 device_ttl_secs, $6 max_devices
-- Note: the invite is consumed even if the cap blocks the insert; the app must tell the admin to create a new one.
WITH i AS (
  UPDATE aa_device_invites SET used_at = now()
   WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
  RETURNING user_id, created_by
)
INSERT INTO aa_admin_devices (user_id, token_hash, status, label, created_via, pending_until, expires_at)
SELECT i.user_id, $2, 'pending', left($3, 120),
       CASE WHEN i.created_by = i.user_id THEN 'invite' ELSE 'admin_invite' END,
       now() + make_interval(secs => $4::float8), now() + make_interval(secs => $5::float8)
  FROM i
 WHERE (SELECT count(*) FROM aa_admin_devices d WHERE d.user_id = i.user_id AND d.status IN ('active','pending')) < $6
RETURNING id;

-- name: DEVICE_REVOKE_GUARDED
-- Second statement of a transaction whose first is: SELECT pg_advisory_xact_lock(hashtextextended($2::text, 7002));
-- $1 device_id, $2 owner_user_id, $3 acting_is_other_admin (boolean). Own last active device is refused.
WITH r AS (
  UPDATE aa_admin_devices SET status = 'revoked', revoked_at = now()
   WHERE id = $1 AND user_id = $2 AND status IN ('active','pending')
     AND ($3::boolean OR status = 'pending'
          OR (SELECT count(*) FROM aa_admin_devices x WHERE x.user_id = $2 AND x.status = 'active' AND x.id <> $1) >= 1)
  RETURNING id
), s AS (DELETE FROM aa_sessions WHERE device_id IN (SELECT id FROM r))
SELECT id FROM r;

-- name: OPERATOR_REOPEN_DEVICE_WINDOW
-- Break-glass, operator only, audited. $1 admin_id, $2 window_hours.
WITH u AS (UPDATE aa_users SET device_window_until = now() + make_interval(hours => $2::int),
                            session_version = session_version + 1
            WHERE id = $1 AND role = 'admin' RETURNING id),
     d AS (UPDATE aa_admin_devices SET status = 'revoked', revoked_at = now()
            WHERE user_id IN (SELECT id FROM u) AND status <> 'revoked'),
     s AS (DELETE FROM aa_sessions WHERE user_id IN (SELECT id FROM u))
SELECT id FROM u;

-- name: SESSION_DRIFT
-- $1 id_hash, $2 new_prefix, $3 new_country. Session stays, turns strict; country change clears step-up.
UPDATE aa_sessions SET
  tier = 'strict',
  stepup_until = CASE WHEN country IS DISTINCT FROM $3 THEN NULL ELSE stepup_until END,
  ip_prefix = $2, country = $3,
  drift_count = CASE WHEN drift_at IS NOT NULL AND drift_at > now() - interval '1 hour' THEN drift_count + 1 ELSE 1 END,
  drift_at    = CASE WHEN drift_at IS NOT NULL AND drift_at > now() - interval '1 hour' THEN drift_at ELSE now() END
 WHERE id_hash = $1
RETURNING drift_count;
```

## F4. Admin session finish (replaces `FINISH_SESSION` for admins; **a person reviews this at CP2**)

```sql
-- name: FINISH_SESSION_ADMIN
-- $1 flow_id, $2 session_hash, $3 abs_ttl_secs, $4 ip, $5 user_agent,
-- $6 new_device_token_hash (bytea or NULL; used only when claiming the first device), $7 device_ttl_secs,
-- $8 ip_prefix, $9 country, $10 tier ('normal' or 'strict'), $11 new_resume_hash. Resume flows use FINISH_RESUME (F6).
-- The flow must be 'ready'. An admin needs an ACTIVE device (via flow), a PENDING device this login activates,
-- or the single winning first-device claim. Everything else yields zero rows and no session.
-- A strict-tier login does not update the device's last_* (rule 7); a normal-tier one does.
WITH f AS (
  UPDATE aa_auth_flows SET stage = 'done'
   WHERE id = $1 AND stage = 'ready' AND via <> 'resume' AND expires_at > now()
  RETURNING user_id, device_id, via
), u AS (
  SELECT f.user_id, f.device_id, f.via, us.session_version
    FROM f JOIN aa_users us ON us.id = f.user_id AND us.is_active AND us.role = 'admin'
), act AS (       -- pending -> active (these rows are disjoint from touch below)
  UPDATE aa_admin_devices d
     SET status = 'active', pending_until = NULL, last_seen_at = now(),
         expires_at = now() + make_interval(secs => $7::float8),
         last_ip = $4, last_ip_prefix = $8, last_country = $9
    FROM u
   WHERE d.id = u.device_id AND d.user_id = u.user_id AND d.status = 'pending' AND d.pending_until > now()
  RETURNING d.id
), touch AS (     -- active device on a normal-tier login refreshes its last_* values
  UPDATE aa_admin_devices d
     SET last_ip = $4, last_ip_prefix = $8, last_country = $9
    FROM u
   WHERE d.id = u.device_id AND d.user_id = u.user_id AND d.status = 'active' AND $10 = 'normal'
  RETURNING d.id
), ok_dev AS (
  SELECT d.id FROM aa_admin_devices d JOIN u ON d.id = u.device_id AND d.user_id = u.user_id
   WHERE d.status = 'active' AND d.expires_at > now()
  UNION ALL SELECT id FROM act
), claim AS (
  UPDATE aa_users SET device_window_until = NULL
   WHERE id IN (SELECT user_id FROM u WHERE device_id IS NULL AND $6 IS NOT NULL)
     AND device_window_until > now()
  RETURNING id
), newdev AS (
  INSERT INTO aa_admin_devices (user_id, token_hash, status, label, created_via, expires_at, last_ip, last_ip_prefix, last_country)
  SELECT claim.id, $6, 'active', left($5, 120), 'first_login', now() + make_interval(secs => $7::float8), $4, $8, $9
    FROM claim
  RETURNING id
)
INSERT INTO aa_sessions (id_hash, user_id, session_version, absolute_expires_at, ip, ua, device_id, login_via, ip_prefix, country, tier, resume_hash)
SELECT $2, u.user_id, u.session_version, now() + make_interval(secs => $3::float8), $4, left($5, 120),
       COALESCE((SELECT id FROM ok_dev LIMIT 1), (SELECT id FROM newdev)), u.via, $8, $9, $10, $11
  FROM u
 WHERE EXISTS (SELECT 1 FROM ok_dev) OR EXISTS (SELECT 1 FROM newdev)
RETURNING user_id, (SELECT id FROM newdev) IS NOT NULL AS device_issued;
```

Known risk to test: data-modifying CTEs in one statement do not see each other's changes, so `ok_dev` reads the device as it was when the statement started. Prove that a device revoked just before the statement cannot produce a session, and that the first-login claim has a single winner under 20 parallel calls. The caller passes `absolute_ttl_secs` of 18000 (5 hours) normally and 14400 in strict tier. A reviewer should also confirm that when the claim wins but `$6` is NULL (no new device token), no session is created.

## F5. Cleanup additions

```sql
-- name: CLEAN_DEVICES
-- $1 batch_limit. Removes revoked rows after 30 days and expired pending rows. Never an active device.
WITH d AS (DELETE FROM aa_admin_devices WHERE id IN (
  SELECT id FROM aa_admin_devices
   WHERE (status = 'revoked' AND revoked_at < now() - interval '30 days')
      OR (status = 'pending' AND pending_until < now() - interval '1 day')
   LIMIT $1) RETURNING 1)
SELECT count(*)::int AS n FROM d;

-- name: CLEAN_INVITES
WITH d AS (DELETE FROM aa_device_invites WHERE token_hash IN (
  SELECT token_hash FROM aa_device_invites WHERE expires_at < now() - interval '7 days' LIMIT $1) RETURNING 1)
SELECT count(*)::int AS n FROM d;
```

## F6. Resume queries (see 5.11)

Eligibility is the same predicate in all three queries: the resume hash matches, tier is `normal`, inside the absolute limit, `session_version` current, user active with a phrase, same prefix, country and user agent, and for admins an enrolled authenticator and the same active device cookie.

```sql
-- name: RESUME_PEEK
-- $1 resume_hash, $2 ip_prefix, $3 country, $4 user_agent, $5 device_token_hash (NULL for staff browsers)
SELECT u.email, (u.role = 'admin') AS is_admin
  FROM aa_sessions s JOIN aa_users u ON u.id = s.user_id
 WHERE s.resume_hash = $1 AND s.tier = 'normal' AND s.absolute_expires_at > now()
   AND s.session_version = u.session_version AND u.is_active AND u.phrase_hash IS NOT NULL
   AND s.ip_prefix = $2 AND s.country IS NOT DISTINCT FROM $3 AND s.ua = left($4, 120)
   AND (u.role <> 'admin' OR (u.totp_enabled_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM aa_admin_devices d WHERE d.id = s.device_id AND d.status = 'active'
            AND d.expires_at > now() AND d.token_hash = $5)));

-- name: RESUME_START
-- $1 flow_token_hash, $2 resume_hash, $3 ip_prefix, $4 country, $5 user_agent, $6 device_token_hash, $7 flow_ttl_secs
-- Repeatable: each call makes a new flow, none spends the resume right (only FINISH_RESUME does).
INSERT INTO aa_auth_flows (token_hash, email, user_id, stage, via, device_id, resume_hash, expires_at, ip_prefix, country)
SELECT $1, u.email, u.id, 'phrase', 'resume', s.device_id, s.resume_hash,
       now() + make_interval(secs => $7::float8), $3, $4
  FROM aa_sessions s JOIN aa_users u ON u.id = s.user_id
 WHERE s.resume_hash = $2 AND s.tier = 'normal' AND s.absolute_expires_at > now()
   AND s.session_version = u.session_version AND u.is_active AND u.phrase_hash IS NOT NULL
   AND s.ip_prefix = $3 AND s.country IS NOT DISTINCT FROM $4 AND s.ua = left($5, 120)
   AND (u.role <> 'admin' OR (u.totp_enabled_at IS NOT NULL AND EXISTS (
         SELECT 1 FROM aa_admin_devices d WHERE d.id = s.device_id AND d.status = 'active'
            AND d.expires_at > now() AND d.token_hash = $6)))
RETURNING id;

-- name: FINISH_RESUME
-- $1 flow_id, $2 new_session_hash, $3 new_resume_hash, $4 ip, $5 user_agent, $6 ip_prefix, $7 country
-- Re-keys the existing session row in place (sid and absolute_expires_at unchanged). Single winner: the row is matched
-- by the resume hash the flow started with, which this statement replaces.
WITH f AS (
  UPDATE aa_auth_flows SET stage = 'done'
   WHERE id = $1 AND stage = 'ready' AND via = 'resume' AND expires_at > now()
     AND ip_prefix = $6 AND country IS NOT DISTINCT FROM $7
  RETURNING user_id, resume_hash
)
UPDATE aa_sessions s
   SET id_hash = $2, resume_hash = $3, last_seen_at = now(), ip = $4, ua = left($5, 120),
       stepup_until = NULL, drift_count = 0, drift_at = NULL
  FROM f JOIN aa_users u ON u.id = f.user_id AND u.is_active
 WHERE s.resume_hash = f.resume_hash AND s.user_id = f.user_id
   AND s.tier = 'normal' AND s.absolute_expires_at > now() AND s.session_version = u.session_version
   AND s.ip_prefix = $6 AND s.country IS NOT DISTINCT FROM $7 AND s.ua = left($5, 120)
   AND (u.role <> 'admin' OR EXISTS (SELECT 1 FROM aa_admin_devices d
         WHERE d.id = s.device_id AND d.status = 'active' AND d.expires_at > now()))
RETURNING s.user_id, s.sid, s.absolute_expires_at, (u.role = 'admin') AS is_admin;
```

Zero rows from `FINISH_RESUME` means no session: answer a neutral `401` and let the UI fall back to the full path. The Worker sets the new `__Host-sid` (no Max-Age) and `__Host-rid` (`Max-Age` = `absolute_expires_at` minus now).

---

# Appendix G: results of the original verification (for reference only)

These counts were produced on the **original unprefixed, unedited** SQL and helpers. They do not vouch for the prefixed and edited text above; section 8 exists to re-earn them.

| Suite | Result |
|---|---|
| SQL on PostgreSQL 16 (original Appendices A to C) | 91 passed, 0 failed |
| Crypto (original Appendix D, with `Buffer`) | 17 passed, 0 failed (RFC 6238 vectors included) |
| Hono middleware (origin guard, cookies, body limit, headers) | 8 passed, 0 failed |
| Appendices E and F, `SESSION_LOOKUP`, `BOOTSTRAP_ADMIN`, `ADVANCE`, `FINISH_SESSION` and `SESSION_LIST` edits, the resume queries (F6), the `aa_` rename, the `Buffer` removal, Resend, UI, attack suite | not run |

Notes from those runs: without the advisory lock, concurrent admin demotions left zero admins in 38 to 39 of 40 trials, and with it 0 of 40. `hono/csrf` alone lets cross-origin JSON posts through, so the custom Origin guard is required. The break-glass unlock statement and Argon2id on Workers were never tested.



























