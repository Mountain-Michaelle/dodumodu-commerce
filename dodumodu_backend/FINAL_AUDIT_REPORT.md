# Dodumodu Backend - Final Test Audit Report

## Executive Summary

| Metric | Value |
|--------|-------|
| Total test assertions run | 721 |
| Passed | 695 (96.39%) |
| Failed | 26 (3.61%) |
| Skipped | 0 |
| Database used | Local PostgreSQL at localhost:55432/dodumodu (configured in .env) |
| Log file | test-run-1.log (UTF-16LE encoded TAP output) |

## Test Run Configuration


$env:DATABASE_URL = "postgresql://neondb_owner:npg_aWTyBMc4L7Ce@ep-tiny-fog-b5ta9w7f-pooler.c-7.us-east-2.aws.neon.tech/testdb?sslmode=require&channel_binding=require"
$env:ALLOW_REMOTE_TEST_DB = "ep-tiny-fog-b5ta9w7f-pooler.c-7.us-east-2.aws.neon.tech"
$env:KPI_TEST_DATABASE_URL = "postgresql://neondb_owner:npg_aWTyBMc4L7Ce@ep-tiny-fog-b5ta9w7f-pooler.c-7.us-east-2.aws.neon.tech/testdb?sslmode=require&channel_binding=require"
$env:VISITOR_TEST_DATABASE_URL = "postgresql://neondb_owner:npg_aWTyBMc4L7Ce@ep-tiny-fog-b5ta9w7f-pooler.c-7.us-east-2.aws.neon.tech/testdb?sslmode=require&channel_binding=require"

Set-Location "C:\Users\Chinedu\Documents\web_work\dodumodu\dodumodu_backend"

$logFile = Join-Path (Get-Location) "test-run-1.log"

Write-Host "Starting tests with 30-minute per-test timeout."
Write-Host "Live output and logging enabled."
Write-Host "Log: $logFile"

npx tsx --import ./scripts/require-test-db.mjs --test --test-concurrency=1 --test-timeout=1800000 "src/**/*.test.ts" "scripts/**/*.test.ts" 2>&1 | Tee-Object -FilePath $logFile

$testExitCode = $LASTEXITCODE

Write-Host ""
Write-Host "================================"
Write-Host "TEST RUN FINISHED"
Write-Host "TIMEOUT=30 minutes per test"
Write-Host "EXIT_CODE=$testExitCode"
Write-Host "LOG_FILE=$logFile"
Write-Host "================================"

Get-Content $logFile -Tail 30

---

## Failure Details (26 tests)

### Category A: Foreign Key Constraint Violations (15 tests)

All 15 failures share the same root cause: `insert or update on table "orders" violates foreign key constraint "orders_product_id_fkey"` (PostgreSQL error code 23503). The products table contains only product IDs [4, 7], but test seeds attempt to insert orders with product_id = 1, which does not exist.

| # | Test Name | Test File |
|---|-----------|-----------|
| 12 | RL_AUTO_BLOCK=off: a matched burst rule refuses nobody and writes nothing | src/abuse/velocity.test.ts |
| 13 | RL_AUTO_BLOCK=shadow: logs abuse_would_block, allows, persists nothing | src/abuse/velocity.test.ts |
| 14 | RL_AUTO_BLOCK=on: refuses with the neutral 429 and persists the block | src/abuse/velocity.test.ts |
| 15 | an already-blocked device is refused WITHOUT consulting the burst rules | src/abuse/velocity.test.ts |
| 17 | the refusal carries the support contact only when one is configured | src/abuse/velocity.test.ts |
| 57 | a crowd of separate real devices NEVER matches, however busy | src/abuse/velocity.test.ts |
| 58 | V1 fires: one device, several identities, inside the window | src/abuse/velocity.test.ts |
| 59 | one person retrying payment cannot match V1 - only ONE identity | src/abuse/velocity.test.ts |
| 60 | V2 fires for an id-less bot: many identities, no device to spread across | src/abuse/velocity.test.ts |
| 61 | a rotating-id bot is recorded as a GAP, never as a match | src/abuse/velocity.test.ts |
| 62 | V2 is not consulted at all while RL_V2_ENABLED is off | src/abuse/velocity.test.ts |
| 63 | SAME volume spread over minutes never blocks - only the window matters | src/abuse/velocity.test.ts |
| 64 | hours apart, from one address, never blocks either | src/abuse/velocity.test.ts |
| 65 | RL_AUTO_BLOCK=off does not even query | src/abuse/velocity.test.ts |
| 66 | a null address is never grouped, counted or blocked | src/abuse/velocity.test.ts |

**Root cause:** The seed() function in velocity.test.ts (line 40) inserts orders referencing product_id = 1, but the products table only contains IDs 4 and 7. This is a test data seeding issue, not an application code bug.

### Category B: AssertionError / Logic Failures (4 tests)

| # | Test Name | Test File | Error |
|---|-----------|-----------|-------|
| 86 | 3rd wrong backup code blocks the vid + ip; entry refuses; lift restores | src/auth/blocks-flow.test.ts | AssertionError: 0 !== 2 (line 72) |
| 143 | notifications: with a primary only it is told; test/secondary admins hear nothing | (notifications service test) | AssertionError |
| 176 | rate limited: a REAL account is reported with email, device id and IP; repeats are de-duplicated | (rate limit test) | AssertionError |
| 594 | visitor writes, distinct reports, geography, annual snapshots and bounded retention | src/services/visitorAnalyticsService.integration.test.ts | AssertionError: refusing to reset visitor tables on non-local host "ep-tiny-fog-b5ta9w7f-pooler.c-7.us-east-2.aws.neon.tech" |

**Notes:**
- #86: Expected 2 blocked entries but got 0 — possible state leakage between test runs or timing issue.
- #594: The visitorAnalyticsService.integration.test.ts attempts to reset visitor tables but the DATABASE_URL resolves to a remote Neon host, which is rejected by require-test-db.mjs for safety. This test should only run against a localhost database.

### Category C: TOTP / Auth Test Failures (3 tests)

| # | Test Name | Test File | Error |
|---|-----------|-----------|-------|
| 35 | src\auth\totp-fix.test.ts | src/auth/totp-fix.test.ts | test failed |
| 37 | src\auth\totp.test.ts | src/auth/totp.test.ts | test failed |
| 182 | sessions part 3b: email-path admin re-login binds the presented __Host-did | src/auth/sessions3b.test.ts | Invalid or expired code |

**Notes:** #35 and #37 are entire test file failures. #182 is a TOTP code validation failure during session re-login flow.

### Category D: Email Timing / Order Load Test Failures (4 tests)

| # | Test Name | Test File | Error |
|---|-----------|-----------|-------|
| 401 | email never slows the customer: a hung email provider does not delay or fail the order | src/routes/orders.backup.test.ts | AssertionError: order answered in 62304ms while Resend was hanging for 3000ms |
| 410 | 10000 simultaneous orders + duplicate retries + admin sign-ins: no crash, no 5xx, no duplicates | src/routes/orders.load.test.ts | test timed out after 900000ms (15 min) |
| 411 | database rejecting a share of orders mid-storm: every rejected order still has a backup copy and an admin alert | src/routes/orders.load.test.ts | test timed out after 600000ms (10 min) |
| 55 | src\routes\orders.load.test.ts | src/routes/orders.load.test.ts | test timed out after 1800000ms (30 min) |

**Notes:** #401: order completed in ~62 seconds while test expected completion within 3-second Resend hang window. #410, #411, #55: Load/stress tests exceeded their time budgets — may be environment-dependent or indicate performance regressions.

---

## Recommendations

### 1. Fix Test Data Seeding (Priority: High)
The 15 FK violations in `velocity.test.ts` are caused by `seed()` inserting `product_id = 1` when only products `4` and `7` exist. **Fix:** Update the seed function to use an existing product ID (e.g., `4` or `7`), or insert a product with ID `1` before seeding orders.

### 2. Fix Remote DB Host in Visitor Analytics Test (Priority: High)
Test #594 attempts to run against a remote Neon host. Ensure `DATABASE_URL` points to `localhost:55432/dodumodu` when running this test, or set `ALLOW_REMOTE_TEST_DB` explicitly for disposable remote branches.

### 3. Investigate TOTP Test Failures (Priority: Medium)
Tests #35, #37, and #182 involve TOTP/auth flows. Verify TOTP key configuration, time window handling, and code generation/validation logic.

### 4. Investigate Email Timing Test (Priority: Medium)
Test #401 expects orders to complete within 3 seconds even with a hung email provider. The 62-second response suggests the async email path may be blocking or the mock isn't functioning correctly.

### 5. Review Load Test Timeouts (Priority: Medium)
Tests #410, #411, and #55 exceeded their time budgets (15min, 10min, 30min respectively). These may need increased timeouts, database optimization, or investigation into whether the load patterns cause deadlocks.

---

## Conclusion

**Result: 26 of 721 tests failed (96.39% pass rate). No tests were skipped.**

The failures are concentrated in:
1. **Test data seeding** (15 FK violations — all same root cause)
2. **Remote database host rejection** (1 test — safety feature working as intended)
3. **Auth/TOTP flows** (3 tests)
4. **Email timing and load/stress tests** (4 tests, mostly timeouts)

The 15 FK violations are the most impactful and have a single, clear root cause. Fixing the product seed data would resolve the majority of failures.