# Admin auth v2 — operations, rotation, and cutover notes

Everything here is **additive** and behind `ADMIN_AUTH_V2`. With the flag off
(`"0"`, the default) every new route returns `404` and the existing app is a
no-op. Turn it on with `ADMIN_AUTH_V2=1` (Worker var / `.dev.vars`). Turn it off
by setting it back to `"0"` — no code change, no migration needed.

## Turning the feature on / off

- **On:** `ADMIN_AUTH_V2=1`, plus the Worker secrets below, plus a verified
  Resend "from" domain (SPF/DKIM/DMARC). Mounts live at `/auth` and `/admin-v2`.
- **Off:** `ADMIN_AUTH_V2=0`. `flagGate` 404s every route; `loadAuthSecrets` is
  never called, so missing secrets are harmless. Static UI still builds but the
  API it calls 404s.
- **Cutover** of the *existing* admin routes to the new middleware
  (`requireSession`/`requireAdmin`/`requirePerm`/`requireStepUp`, exported from
  `src/auth/middleware.ts`) is a **separate task**. This change does not touch
  the existing Cloudflare Access guard or the `/admin` console.

## Operator scripts (`scripts/auth/`, dev branch only)

| Script | Purpose |
|---|---|
| `bootstrap-admin.mjs <email> [hours]` | Create the FIRST admin + open the 72 h first-device window. Refuses if any admin exists. |
| `unlock-email.mjs <email>` | Delete every `aa_auth_throttle` row for one email (R-NOLOCK escape hatch — only ever unlocks). Needs `THROTTLE_KEY`. Audited. |
| `reopen-device-window.mjs <email> [hours]` | Break-glass: reopen the window, revoke that admin's devices, end their sessions. Audited. |
| `cleanup.mjs [batch]` | Batched janitor (also exposed as `POST /admin-v2/internal/cleanup`, guarded by `x-cron-secret === RECONCILE_CRON_SECRET`). |

Run any of them with `DATABASE_URL=... node scripts/auth/<name>.mjs …`.

## Cleanup scheduling

There is **no Cron Trigger** in this app; the existing external scheduler
(cron-job.org, the same one that hits `/reconcile-pending`) should call
`POST /admin-v2/internal/cleanup` with the shared `x-cron-secret`. It runs the
same batched, safe deletes as `cleanup.mjs` (expired flows/sessions/challenges/
resets/invites, old revoked devices, cold throttle) and never removes an active
lock or a live session.

## Secret rotation

- **`OTP_KEY`** — rotating invalidates all outstanding emailed codes (users just
  request a new one). No data migration.
- **`THROTTLE_KEY`** — rotating changes every HMAC(email), which effectively
  clears all locks/fuses/send-caps (old keys become unreachable and are reaped by
  cleanup). No data migration.
- **`TOTP_ENC_KEY`** — encrypts each admin's TOTP secret at rest. Rotating
  **requires re-encryption**: decrypt with the old key, re-encrypt with the new,
  per admin, before switching the Worker secret. Until then, admins cannot pass
  the authenticator stage. Plan a maintenance window.
- Device, invite, reset, session and backup tokens are random and stored only as
  hashes — nothing to rotate; they expire on their own.

## Known residual risk (documented per spec R-NOLOCK 5)

A stranger who spams `POST /auth/request` for a **staff** email can consume the
hourly send cap and delay that staff user's next code. Admins are unaffected
(the device path needs no email). Mitigation is `unlock-email.mjs` (clears the
send key) plus the Cloudflare per-IP RPM rule on `/auth/*`.

## Not yet verified in this environment

- §8 SQL suite against the **Neon dev branch** through the real driver (only the
  local throwaway Postgres was used).
- §9 Argon2id CPU measurement on `wrangler dev` / a deployed preview Worker.
- §10 Playwright UI tests and §11 attack suite (need a running Worker + Neon dev
  branch `DATABASE_URL` + `.dev.vars` secrets). See `ATTACK_REPORT.md`.
