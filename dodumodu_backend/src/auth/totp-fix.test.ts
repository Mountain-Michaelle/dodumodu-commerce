import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDbDriver } from "../db";
import type { Db } from "../db";
import { pgDriver, closePools } from "../dbDrivers/pg";
import { q, q1, sql } from "./sql";
import { requestCode } from "./entry";
import { verifyCode } from "./factors";
import { totpEnrollStart, totpEnrollConfirm, ackBackupCodes } from "./totp";
import { verifyTotp } from "./totp-verify";
import { normalizeEmail, hotp } from "./crypto";
import { AuthRejectError } from "./errors";
import { tag, secrets, cleanup, loginToTotp, CTX } from "./totp.test";

const databaseUrl = process.env.DATABASE_URL;

async function enrolled(db: Db, name: string) {
  const s = secrets();
  const email = normalizeEmail(`${tag}-${name}@example.com`)!;
  await q(db, sql`INSERT INTO aa_users (email, role, device_window_until, enroll_window_until)
    VALUES (${email}, 'admin', now() + interval '72 hours', now() + interval '72 hours')`);
  const req = await requestCode(db, s, email, CTX, null);
  await verifyCode(db, s, req.flowToken, req.sendCode!.code, CTX.ip);
  const start = await totpEnrollStart(db, s, req.flowToken, email);
  const conf = await totpEnrollConfirm(db, s, req.flowToken,
    await hotp(start.secret, Math.floor(Date.now() / 30000)), CTX.ip);
  await ackBackupCodes(db, req.flowToken);
  return { s, email, secret: start.secret, codes: conf.backupCodes };
}
const latestStage = (db: Db, email: string) =>
  q1<{ stage: string }>(db, sql`SELECT stage FROM aa_auth_flows WHERE email = ${email} ORDER BY expires_at DESC LIMIT 1`);

test("totp fix: returning user, spaced code, wrong-backup-does-not-advance, retry idempotent",
  { skip: !databaseUrl }, async (t) => {
  registerDbDriver(pgDriver);
  const db = pgDriver(databaseUrl!);
  t.after(async () => { await cleanup(db); await closePools(); });
  const u = await enrolled(db, "fix1");
  const now = Date.now() + 120_000;
  const code = await hotp(u.secret, Math.floor(now / 30000));

  // 1. returning user + code pasted as "123 456" works (secret read from aa_users)
  const f1 = await loginToTotp(db, u.s, u.email, "10.50.0.1");
  const ok = await verifyTotp(db, u.s, f1, { code: `${code.slice(0, 3)} ${code.slice(3)}` }, "10.50.0.1", true, now);
  assert.equal(ok.next, "ready");

  // 2. retry of the same code after a "lost response" returns the same result
  const again = await verifyTotp(db, u.s, f1, { code }, "10.50.0.1", true, now);
  assert.equal(again.next, "ready");

  // 3. a wrong backup code is rejected AND does not advance the flow
  const f2 = await loginToTotp(db, u.s, u.email, "10.50.0.2");
  await assert.rejects(verifyTotp(db, u.s, f2, { backupCode: "AAAAA-AAAAA" }, "10.50.0.2", true), AuthRejectError);
  assert.equal((await latestStage(db, u.email))?.stage, "totp");

  // 4. the right code, lowercase and without the dash, still works afterwards; remaining = 7
  const good = u.codes[0].toLowerCase().replace("-", "");
  const used = await verifyTotp(db, u.s, f2, { backupCode: good }, "10.50.0.2", true);
  assert.equal(used.next, "ready");
  assert.equal(used.remaining, 7);

  // 5. the same backup code cannot be reused
  const f3 = await loginToTotp(db, u.s, u.email, "10.50.0.3");
  await assert.rejects(verifyTotp(db, u.s, f3, { backupCode: u.codes[0] }, "10.50.0.3", true), AuthRejectError);
});