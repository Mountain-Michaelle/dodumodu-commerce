# Progress — Phase 7 v2 Auth + Authorization

> Live tracker. Updated after EVERY step and before EVERY stop.
> Rule: never claim a test passed that was not run. Paste actual output.

## Session log
- **S1** — Plan approved, switched to Act. Created `currentwork.md` + `progress.md`. Beginning Phase 0 recon.

## Phase tracker

### Phase 0 — Recon (read-only) → GATE 0 — 🟡 DOING
- [ ] Confirm runtime (Workers vs Node) + PG driver + `waitUntil`
- [ ] Read auth stages/factors/sessions/routes/config exactly
- [ ] Inventory route mounts (app.ts / node.ts / routes.ts)
- [ ] Produce `docs/route-registry.md`
- [ ] Draft proposed `auth/registry.ts` (sections + privileges + per-status keys)
- [ ] As-built transition map vs §4.2b
- [ ] Conflict list C1–C5 + confirm §14 answers
- [ ] UI inventory (§11.0)
- **GATE 0 exit:** deliverables above approved by user. No code/migration before approval.

### Phase 1 — Schema 0019 — ✅ DONE (applied to local DB + verified) → GATE 1
- Migration `0019_admin_auth_v2.sql` written (idempotent, transactional). `npm run db:migrate` → "Applied 0019_admin_auth_v2.sql".
- Verified on local Postgres (read-only probe, temp script deleted):
  - aa_users new cols ✓ (username/first_name/last_name/is_staff/is_superuser/date_joined/last_login/enroll_window_until/perms_version); role CHECK admin|mono|general + is_superuser invariant; staff→mono backfill.
  - flow cols ✓ (totp_fails/recovery_unlocked/phrase_fails/enroll_mode/vid_hash); stages widened (backup_codes/recovery/dead).
  - 9 new tables ✓ (aa_blocks/aa_alert_outbox/aa_account_requests/aa_role_templates/aa_backup_code_sets/aa_backup_codes/aa_auth_log/aa_audit_log/order_audit_snapshots).
  - order cols ✓ (assigned_by/is_edited/edited_at/edited_by/edit_count/version) + idx_orders_scope.
  - append-only triggers ✓ — verified UPDATE **and** DELETE on aa_auth_log are blocked; aa_maint escape hatch works.
- **Deviations (for GATE 1 approval):**
  1. Logs are SINGLE tables, not monthly partitions (spec §4.7 allows this at GATE 1 — low volume; retention = bounded deletes by aa_maint only).
  2. Assignment stays **email-keyed** (`orders.assigned_to` = staff email, the committed 0018 seam); scoping matches on email — NO data migration, NO FK. (Spec wanted user-id.)
  3. Status events reuse existing `order_status_history` instead of a new `order_events` (avoid duplicating a working audit path).
- **GATE 1 exit:** approve the 3 deviations above (or adjust) before Phase 2.
### Phase 2 — Bootstrap — ✅ DONE (live-verified + committed test) → GATE 2
- createsuperuser.ts + superuser.ts + superuser.test.ts. Grammar (8 committed cases), preflight, create, lockout-safe refresh, abort-when-enrolled, concurrency (one row) all verified.
- Backend: 486 tests, 459 pass, 0 fail. tsc exit 0. completed.md updated.

### Phase 3 — Security infra — ✅ DONE (built + live-verified) → GATE 3
- ip.ts + ipCrypto.ts (7 unit tests), authLog.ts, blocks.ts, outbox.ts, infra.test.ts (4 live-DB tests).
- 0020 transition migration (expand/contract). Fixed ipCrypto b64u bug + 9 colon-tag tests.
- Full suite WITH DB: 497 tests, 495 pass, 0 fail. tsc exit 0. completed.md updated.

### Phase 4 — Auth flow realignment — ✅ DONE (all 7 slices live-verified) → GATE 4
- **Slice 1 — TOTP recovery thresholds** (`totp-verify.ts`, `config.ts`, `errors.ts`, `routes.ts`, `throttle.ts`): 3rd wrong TOTP → `AuthRecoverableError` (401 `recovery_available:true`); 5th → flow `dead`; replay not counted.
- **Slice 2 — recovery endpoints** (`recovery.ts` + `POST /auth/recovery/phrase`, `POST /auth/recovery/backup-code`): gated by `recovery_unlocked`; phrase/backup resets TOTP **inside the flow** (`totp_enroll` + `enroll_mode='recovery_reset'`, session_version bumped, no session); wrong counts down, 3rd → flow dead.
- **Slice 3 — phrase demotion** (`factors.ts` `verifyCode` → `otp→totp`/`totp_enroll`, enroll-window gating else DUMMY; `entry.ts` REAL requires TOTP-or-open-window): `factors.test.ts` + `entry.test.ts` verify the new order.
- **Slice 4 — backup generations + ack** (`totp.ts` `genBackupCodes`/enroll-confirm issuing generations, `ackBackupCodes` → ready; `POST /auth/backup-codes/ack`): `totp.test.ts` + `totp-backup.test.ts` verify single-use + remaining + strict refusal.
- **Slice 5 — staff TOTP gate** (`sessions.ts` `finishStaffSession` hard-requires `totp_enabled_at`, `via <> 'resume'`): `sessions2/3a.test.ts` verify.
- **Slice 6 — lost-email** (`lost-email.ts` + `POST /auth/lost-email`, Option A uniform 202, per-IP lockout, 24h dedupe, capped alert): `lost-email.test.ts` verifies.
- **Slice 7 — blocks** (`blocks.ts` + `__Host-vid` cookie set at flow creation, checked on every `/auth/*` entry; block-on-3rd-wrong-phrase → device block until lifted + 24h ip block): `blocks-flow.test.ts` verifies block → dummy-202 → lift → real path.
- **Verified:** targeted 10/10 pass; full suite WITH DB = **502 tests, 500 pass, 0 fail, 2 skipped**; tsc exit 0.
- **GATE 4 exit:** approve to proceed to Phase 5 (guards/registry).
### Phase 4 — Auth flow — ⏳ todo → GATE 4
### Phase 5 — Guards/registry — ⏳ todo → GATE 5
### Phase 6 — Order scoping — 🟡 DOING → GATE 6
- Phase 8 fixture (route-layer litmus) committed (`30ee1c2`): `orderScope.ts` + `orderScope.test.ts` + `ordersV2.scope.test.ts` (7/7 scope tests: mono own-order 200 via seeded fixture, out-of-scope 404) + `fakeDb.table()` seeded/read split (reads no longer wipe seeded rows). Full suite 552 tests / 498 pass / 0 fail / 54 skipped; `tsc --noEmit` clean.
- Next: Phase 9 — admin/general vs mono routing + list-scope boundary (RESTRICTED_ORDER litmus, dropped here to keep tsc clean; re-introduce there).
### Phase 7 — Edit/Audit — ⏳ todo → GATE 7
### Phase 8 — Users+Security+Access API — ⏳ todo → GATE 8
### Phase 9 — Cutover — ⏳ todo → GATE 9
### Phase 10 — Frontend (10a–10f) — ⏳ todo → GATE 10
### Phase 11 — Verify — ⏳ todo → GATE 11

## Files changed (running)
_(none yet — Phase 0 is read-only)_

## Open questions for user
1. Confirm recovery model (TOTP-for-everyone, phrase/backup = recovery only).
2. Approve C2 (role change) and C4 (encrypted IP storage)?
3. Approve C3 reconciliation of `assigned_to_email` → `assigned_to`.
4. **NEW C6 — migration number collision:** spec wants auth migration `0018`, but `0018_order_assignment.sql` already exists (my committed assignment work). Recommend auth migration = **`0019_*`** (assignment keeps 0018; no renumbering of an applied migration). Confirm?

## Phase 0 — Recon — ✅ DONE (deliverables written, awaiting GATE 0 approval)
- Runtime: Workers (neonDriver, waitUntil) + Node (pgDriver), shared app.ts. **C5 resolved.**
- Auth stages/factors/sessions/routes/config read exactly (M1–M10 mapped).
- Route mounts inventoried (app.ts: /auth + /admin-v2 mounted last, flag-gated).
- `docs/route-registry.md` written (auth routes, transition map, order model, registry proposal).
- Conflict list: C1–C6. §14 answers = all "agree" (see currentwork.md).
- **GATE 0 exit:** needs approval of C2, C4, C6 (+ confirm recovery model) before any Phase 1 code/migration.
