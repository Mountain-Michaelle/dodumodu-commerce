# Current Work — Django-style Users + TOTP-for-Everyone Auth + Dynamic Authorization

> Master plan. Single source of truth. A fresh/confused session reads THIS FIRST, then `progress.md`.
> Stack: Hono + PostgreSQL + vanilla JS/HTML/CSS. Everything behind `ADMIN_AUTH_V2 === "1"`.
> Status legend in progress.md: ⏳ todo · 🟡 doing · ✅ done · ⛔ blocked.

## 0. MISSION
- Realign auth: **everyone** logs in `email → OTP → TOTP → dashboard`. Phrase + backup codes become **recovery-only**.
- Add security layer: attempt counters, device+IP blocking, admin auth log, attention emails.
- Django-aligned User model; dynamic RBAC (roles, per-user routes/permissions, row-level order scoping).
- Fast, light, reliable, consistent. No new heavy deps.

## NON-NEGOTIABLES (do not weaken)
1. Uniform responses (no account enumeration), `__Host-` cookies, origin guard, fail-closed 500, admin device rule, step-up on sensitive ops, throttling.
2. Everything behind `ADMIN_AUTH_V2==="1"`; flag off → `/auth` + `/admin-v2` return 404, legacy `/admin` untouched.
3. Server is source of truth; frontend hiding is cosmetic.
4. Default-deny; no self-registration; additive migrations only (never edit `0017`; new `0018`).

## PHASES & GATES
| Phase | Work | Gate |
|---|---|---|
| 0 Recon | route-registry.md, registry.ts proposal, as-built transition map, conflicts, UI inventory, runtime/driver | GATE 0 |
| 1 Schema | migration 0018 (idempotent), user cols, flow cols, blocks, outbox, partitioned logs, order cols | GATE 1 |
| 2 Bootstrap | createsuperuser script + tests | GATE 2 |
| 3 Security infra | key separation, proxy trust, encrypted IPs, authLog, blocks, outbox | GATE 3 |
| 4 Auth flow | full transition table: OTP→TOTP all, enrollment, backup generations, recovery reset, limits, block-on-3rd, lost-email | GATE 4 |
| 5 Guards | registry, guard(), per-status keys, cascades, coverage check | GATE 5 |
| 6 Scope | orderScope helper everywhere + assignment | GATE 6 |
| 7 Edit/Audit | atomic edit + snapshot + is_edited, status transitions | GATE 7 |
| 8 Users+Security+Access API | §9 + §4.12 + §5A.3 + audit + emails | GATE 8 |
| 9 Cutover | guard v2 mounts; legacy /admin untouched | GATE 9 |
| 10 Frontend | sub-gates 10a–10f (inventory→foundation→auth→admin→a11y→regression) | GATE 10 |
| 11 Verify | full §13 suite, report real results | GATE 11 |

## RECOVERY MODEL (locked)
- Login = `email → OTP → TOTP → session` for **everyone**.
- First login enrollment: `otp → totp_enroll → enroll_phrase → backup_codes (once) → ready → session`.
- Recovery: only after **3 TOTP fails** (`recovery_unlocked`), phrase/backup **resets TOTP inside the flow** (`recovery_reset`), then re-enroll → new backup generation → normal session. No recovery session.
- Backup codes = **generations** (`aa_backup_code_sets`+`aa_backup_codes`, hashed, acked once).

## ROLES (final)
| Role | Scope | Delete/spam |
|---|---|---|
| admin | all | yes |
| general | all staff orders (filterable by staff) | never |
| mono | assigned_to = me only | never |
Hard rule: delete/spam/users.*/permissions.*/orders.assign/authlog.view/blocks.manage/account_requests.manage = **adminOnly** (registry flag). No self-grant/demote; last-admin protected.

## AUTHORIZATION
- `auth/registry.ts` = single source. Sections (`<area>.view`) + privileges (`<area>.<action>`).
- Per-status keys `orders.status.<status>` (one per real transition), **no bare `orders.status`**.
- `requires` dependencies + cascade revoke (audited/diffed).
- `guard({perm, scope})` after requireSession; status policy 401/404/403/409/429/500.
- `orderScope(user,{staff})` = parameterized SQL predicate applied to **every** order query/count/export/bulk/aggregate; mono forces assigned_to=self.
- Presets: mono=`orders.view,orders.change,orders.status.<s non-admin>,reports.view`; general=`+orders.export,orders.filter_staff,products.view,categories.view`.
- Coverage check: boot/test fails if any `/admin-v2` or protected `/auth` route lacks registry entry + guard().
- `perms_version` bump + `X-Perms-Version` header = instant effect, no logout.

## CONFLICTS TO APPROVE AT GATE 0/1
- C1: login realignment is a breaking behavior change (intended).
- C2: role CHECK change `staff→mono/general` (destructive, approve).
- C3: reconcile my existing `orders.assigned_to_email` with spec `assigned_to` (user id).
- C4: store **encrypted** IPs in auth log/blocks (change from v1 "never store raw IP").
- C5: confirm runtime (Workers vs Node) + scheduler for waitUntil/partition maintenance.

## §4.6 LOST-EMAIL (locked = Option A)
Always-visible "recover by username"; server-gated by flow ownership; throttled/capped; **uniform** message for right/wrong username (no enumeration oracle). Non-registered emails stay in retry+rate-limit loop.

## §14 ASSUMPTIONS (all recommended "agree")
Backup=recovery · IP block 24h/device until lifted · encrypted IPs · in-flow TOTP reset · status≠edited · staff→mono +7d window · general no audit-view · admin-reserved destructive ops · instant email per save + affected-user notice · templates copied · alert IP masked · recovery lock auto-expires 24h · v1 ciphertexts keep keys · dashboard only existing API data.

## DEFINITION OF DONE
All gates passed, §13 green, flag-off unchanged, no protection weakened (except §1.10 encrypted IP), docs updated. STOP after every gate for approval.
