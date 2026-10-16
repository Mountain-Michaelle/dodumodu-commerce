# Completed — Phase-by-phase record

> One section per phase, appended as each gate is approved. Read `currentwork.md` for the plan, `progress.md` for live status. This file is the durable "what is done and verified" log.

---

## Phase 0 — Recon — ✅ APPROVED
- Runtime: Cloudflare Workers (neonDriver, waitUntil) prod; Node (pgDriver) local; one shared `app.ts`. Scheduler = external cron-secret HTTP.
- Deliverable: `docs/route-registry.md` (auth routes, as-built transition map, order model, `registry.ts` proposal, coverage check).
- Conflicts resolved: C1 (breaking realignment, intended), C2 (role change approved), C4 (encrypted IPs approved), C5 (runtime confirmed), C6 (auth migration = 0019).
- Recovery model locked: TOTP-for-everyone; phrase + backup = recovery-only.

## Phase 1 — Schema `0019` — ✅ APPROVED
- `migrations/0019_admin_auth_v2.sql` applied to local DB and verified (read-only probe; temp scripts deleted).
- aa_users Django-aligned + role CHECK admin|mono|general + is_superuser invariant + staff→mono backfill + enroll_window.
- aa_auth_flows recovery counters + new stages (backup_codes/recovery/dead).
- 9 new tables (aa_blocks, aa_alert_outbox, aa_account_requests, aa_role_templates, aa_backup_code_sets, aa_backup_codes, aa_auth_log, aa_audit_log, order_audit_snapshots).
- orders edit-tracking cols + idx_orders_scope.
- Append-only triggers proven: UPDATE + DELETE blocked on aa_auth_log; aa_maint escape hatch works.
- **Approved deviations:** (1) logs single-table not partitioned; (2) assignment email-keyed (no migration/FK); (3) status events reuse `order_status_history` (no `order_events`).

---

## Phase 2 — Bootstrap `createsuperuser` — ✅ DONE (live-verified + committed test) → GATE 2
- `scripts/createsuperuser.ts` + `scripts/auth/superuser.ts` (pure grammar) + `scripts/auth/superuser.test.ts`. npm script `createsuperuser` added; `npm test` glob extended to `scripts/**/*.test.ts`.
- **Live-verified against local DB** (temp scripts deleted):
  - Grammar rejections (no email / invalid email / extra args / bad username / unknown flag / duplicate+empty --username) → exit 1, create nothing ✓
  - Preflight (ADMIN_AUTH_V2, distinct 32-byte OTP/THROTTLE/TOTP keys, migration 0019 applied, email unless ALLOW_TEST_IP) ✓
  - Create when none → row `is_superuser/is_staff/is_active=true`, `phrase_hash/totp_secret_enc=NULL`, `enroll_window_until` open ✓
  - Lockout-safe re-run (sole admin, un-enrolled, matching email) → refreshes windows ✓
  - Abort once enrolled / different email ✓
  - **Concurrency**: two parallel runs → exactly ONE row, no duplicate superuser (advisory lock `pg_advisory_xact_lock(7001)` + `WHERE NOT EXISTS`) ✓
- Committed grammar test: 8 cases, all pass. Backend suite: **486 tests, 459 pass, 0 fail**. tsc exit 0.
- **GATE 2 exit:** approve to proceed to Phase 3 (security infra: key separation, proxy trust, encrypted IPs, authLog, blocks, outbox).

## Phase 3 — Security infra — ✅ DONE (built + live-verified) → GATE 3
- **`src/auth/ip.ts`** — normalizeIp, blockPrefix (/32 v4, /64 v6), clientIp (TRUSTED_PROXY), parseTrustedProxy, ipHash (dedicated IP HMAC). 7 unit tests pass.
- **`src/auth/ipCrypto.ts`** — AES-256-GCM encrypted IPs, keyring `v1:<kid>:<nonce>:<ct>`, AAD, rotation, fail-closed. Fixed a real bug: b64u(base64URL) vs atob(standard) mismatch → toB64.
- **`src/auth/authLog.ts`** — writeAuthLog (sync, bytea-as-hex) + logInfo (fire-and-forget).
- **`src/auth/blocks.ts`** — isBlocked/createBlock/liftBlock (indexed, guarded).
- **`src/auth/outbox.ts`** — enqueue (ON CONFLICT DO NOTHING) + claimOutbox (FOR UPDATE SKIP LOCKED) + markSent/markRetry.
- **`src/auth/infra.test.ts`** — 4 live-DB integration tests (log+append-only, block create/expire/lift, outbox dedupe/claim/send).
- **`0020_role_check_transition.sql`** — expand/contract: re-admits 'staff' + drops the superuser invariant so the working v1 path + tests stay green; hard cutover deferred to Phase 4/5.
- **Fixed latent test bug:** 9 auth test files used colon tags which my earlier normalizeEmail hardening rejects → null email; changed to `word-`.
- **Verified:** full backend suite WITH DB = **497 tests, 495 pass, 0 fail, 2 skipped**; tsc exit 0.
- **GATE 3 exit:** approve to proceed to Phase 4 (auth flow realignment: OTP→TOTP for everyone, phrase/backup = recovery, enroll window, layered limits, block-on-3rd, lost-email).

---

## Phase 4 — Auth flow realignment — ✅ DONE (all 7 slices live-verified) → GATE 4
- **Slice 1 — TOTP recovery thresholds** (`src/auth/totp-verify.ts`): 3rd wrong TOTP → `AuthRecoverableError` (401 `recovery_available:true`); 5th → flow `dead`; step-replay rejected without burning an attempt. Throttle `reserve` takes a threshold override so the per-flow counter (5) fires before the pair-lock (3).
- **Slice 2 — recovery endpoints** (`src/auth/recovery.ts`): `POST /auth/recovery/phrase` + `POST /auth/recovery/backup-code`, gated by `recovery_unlocked`; success resets TOTP **inside the flow** (`totp_enroll`, `enroll_mode='recovery_reset'`, session_version bumped, no session); wrong counts down, 3rd → flow `dead`.
- **Slice 3 — phrase demotion** (`factors.ts` `verifyCode`: `otp→totp` for enrolled, `otp→totp_enroll` for open-window new users, else `dead`; `entry.ts` REAL requires TOTP-or-open-window + device gate for admins): verified by `factors.test.ts` (full staff journey otp→totp_enroll→enroll_phrase→backup_codes→ack→ready; returning code→totp→ready) + `entry.test.ts` (enrolled/window gets code, unknown dummy, denied-admin alert once per 6h, never-loggable admin gets NO alert, pair lockout).
- **Slice 4 — backup generations + ack** (`totp.ts`: generations in `aa_backup_code_sets/codes`, shown once, revoked on new issue; `ackBackupCodes` → ready; `POST /auth/backup-codes/ack`): verified by `totp.test.ts` + `totp-backup.test.ts` (single-use, remaining count, strict-tier refusal).
- **Slice 5 — staff TOTP gate** (`sessions.ts` `finishStaffSession` hard-requires `totp_enabled_at`, `via <> 'resume'`; `sessions-admin.ts` F4 active/pending/first-claim): verified by `sessions2/3a.test.ts`.
- **Slice 6 — lost-email** (`lost-email.ts` + `POST /auth/lost-email`, spec §4.6 Option A: uniform `{ok:true}` for every input, per-IP lockout, 24h dedupe, capped alert): verified by `lost-email.test.ts`.
- **Slice 7 — blocks** (`blocks.ts`: `__Host-vid` cookie set at flow creation, checked on every `/auth/*` entry; block-on-3rd-wrong-phrase → device block until lifted + 24h ip block + outbox alert): verified by `blocks-flow.test.ts` (block → identical dummy-202 for vid+network → lift → real path).
- **Verified 2026-10-11:** targeted auth tests 10/10 pass; full backend suite WITH DB = **502 tests, 500 pass, 0 fail, 2 skipped**; `tsc --noEmit` exit 0.
- **GATE 4 exit:** approve to proceed to Phase 5 (guards/registry).

<!-- Future phases appended below as approved -->

