# Route Registry & Authorization Proposal (GATE 0 deliverable)

> Recon-only. No code/migration changed. Every row Verified from source unless marked.

## 1. Runtime & driver (Verified)
- **Production = Cloudflare Workers**: `src/index.ts` is `main` in `wrangler.toml`, uses `neonDriver` (Neon HTTP). `waitUntil` available (`middleware.ts:87 afterResponse`).
- **Local = Node**: `src/node.ts` uses `pgDriver` (TCP) + `@hono/node-server`; injects `cf-access-authenticated-user-email` + `cf-connecting-ip` for local admin identity.
- Both share **one** `src/app.ts`. Switching env switches the entry point only.
- **Scheduler**: external cron-secret HTTP (`POST /admin-v2/internal/cleanup`, guarded by `RECONCILE_CRON_SECRET`; same pattern as reconcile + monthlyKpiSnapshots + visitorRetention). **No Cloudflare Cron Trigger assumed.**
- **DB**: raw SQL via tagged template `sql` (no ORM). Drizzle used for schema/types + `orders`/`products` repos only.

## 2. Auth v2 as-built (`src/auth/*`) — Verified
| Route | File:line | Guard today |
|---|---|---|
| POST `/auth/request` | routes.ts:131 | flagGate+originGuard; uniform 202 |
| POST `/auth/resend` | routes.ts:154 | same |
| POST `/auth/code` | routes.ts:172 | `verifyCode` |
| POST `/auth/device/start` | routes.ts:183 | — |
| GET `/auth/device/available` | routes.ts:104 | — |
| GET `/auth/test/mailbox/:email` | routes.ts:119 | `ALLOW_TEST_IP=1` only |
| POST `/auth/phrase/enroll` | routes.ts:193 | stage `enroll_phrase` |
| POST `/auth/phrase` | routes.ts:203 | stage `phrase` (**login step today — to remove**) |
| POST `/auth/totp/enroll/start` | routes.ts:214 | stage `totp_enroll` |
| POST `/auth/totp` | routes.ts:224 | stage `totp` |
| POST `/auth/session` | routes.ts:242 | staff vs admin split |
| POST `/auth/stepup` | routes.ts:264 | requireAdmin |
| `GET /auth/me`, `/auth/logout`, `/auth/sessions*`, backup/regenerate, admin user/device ops | routes.ts (300+) | requireSession/requireAdmin/requireStepUp |

Guards (`middleware.ts`): `flagGate` (404 when off), `originGuard`, `securityHeaders`, `requireSession`, `requireAdmin`, `requirePerm(perm)`, `requireStepUp`. **Not yet applied to any `/admin` route** (cutover separate).

## 3. As-built transition map vs spec §4.2b (Verified — divergences)
| Stage today | Next today | Spec target | Divergence |
|---|---|---|---|
| `otp` | `verifyCode` → **`phrase`** (or `enroll_phrase` if no hash) | → **`totp`** / `totp_enroll` | **M1** |
| `phrase` | `verifyPhrase` → `totp`/`totp_enroll`/`ready` | **removed from login** | **M2/M3** |
| `enroll_phrase` | `enrollPhrase` → `totp`(admin)/`ready`(staff) | keep; staff must also reach TOTP | **M4** |
| `totp` | `verifyTotp` → `ready` | keep; add `totp_fails` unlock@3/dead@5 | **M8** |
| `totp_enroll` | `totpEnrollConfirm` → `ready` + backup codes | keep; split `backup_codes` stage + ack | **M6** |
| `ready`→`done` | `finishStaffSession`(`role<>'admin'`)/`finishAdminSession`(`role='admin'`) | everyone reaches `ready` via TOTP; staff no longer skips TOTP | **M4** |
| Stages set | `otp,phrase,enroll_phrase,totp,totp_enroll,ready,done` | add `backup_codes, recovery, dead` | schema |
| Flow cols | none | `totp_fails,recovery_unlocked,phrase_fails,enroll_mode,vid_hash` | schema |
| Backup codes | `aa_recovery_codes` (flat) | generations `aa_backup_code_sets`+`aa_backup_codes` w/ ack | **M6** |
| Roles | `admin,staff` | `admin,mono,general` | **M2/C2** |
| `enroll_window_until` | absent | add; else DUMMY | **M9** |
| blocks/outbox/auth-log/limits | absent | add §4.4b/4.5/4.7/4.8 | **M10** |

## 4. Order model (Verified) — scoping + C3/C6
- **Statuses** (`schema.ts:11`): `awaiting_payment, paid, failed, confirmed_cod, delivered, cancelled, not_picking`.
- **Payment transitions** `ordersRepo.LEGAL_TRANSITIONS`: `awaiting_payment→[paid,failed,cancelled]`, `paid→[delivered,cancelled]`, … (payment/webhook owned).
- **CRM actions** `orderCrmService.availableActions` (orderCrmService.ts:42) — server-authoritative per-status set; CRM transitions separate from payment.
- **Assignment already exists** (committed `feat/order-assignment`): `orders.assigned_to TEXT` = staff **email**, `assigned_at`, partial index, `admin_staff(email PK)`, `order_assignments` audit. `orderCrmService.assign` (orderCrmService.ts:646) is NOT a status transition.
- **Scoping choke point**: `ordersRepo.buildOrderWhere` (ordersRepo.ts:666) — used by `listForAdmin` (148), export (434), and counts. `filtersFromQuery` (560). `findPotentialDuplicates` (439).
- **Duplicate group** (existing detector): same `phone_norm` + Lagos day + address + product signature; ±30 min window. Reuse, don't reinvent.

## 5. Proposed `auth/registry.ts` (sections + privileges) — for GATE 0 approval
Two kinds: **section** (`<area>.view`) and **privilege** (`<area>.<action>`). Entry: `{key,type,group,label,adminOnly,roles[],scoped,requires[],important,notify}`.

| Group | Keys |
|---|---|
| dashboard | `dashboard.view` |
| orders | `orders.view`(sec), `orders.add`, `orders.change`, `orders.status.<s>` (one per CRM transition, **no bare `orders.status`**), `orders.export`, `orders.filter_staff`(general/admin), `orders.audit.view`, `orders.assign`*(admin), `orders.delete`*(admin), `orders.spam`*(admin) |
| products | `products.view`, `products.add`, `products.change`, `products.price.change`, `products.stock.change`, `products.delete`* |
| categories | `categories.view/add/change`, `categories.delete`* |
| testimonials | `testimonials.view/add/change/approve`, `testimonials.delete`* |
| abuse | `abuse.view`, `abuse.resolve`, `abuse.dismiss`, `abuse.delete`* |
| reports | `reports.view` (scope-aware), `reports.export` |
| users/access/security | `users.view`*, `users.manage`*, `access.manage`*, `authlog.view`*, `blocks.manage`*, `account_requests.manage`* |

`*` = adminOnly (registry flag). Presets: **mono**=`orders.view,orders.change,orders.status.<non-admin>,reports.view`; **general**=`mono set + orders.export,orders.filter_staff,products.view,categories.view`; **admin**=all.

## 6. Per-status privilege keys (generated from the CRM transition table)
One privilege per legal CRM transition target. Enumerated exactly at GATE 1 once `availableActions`/CRM transitions are read in full. Rule: `orders.status.<target>` requires `orders.view` + role + in-scope order + valid from-state; `spam`/`delete` are in no non-admin transition.

## 7. Coverage check
Boot (dev/test) + CI (prod): enumerate every mounted `/admin-v2` + protected `/auth` route; fail if any lacks a registry entry AND a `guard()`. Unregistered → 404.

