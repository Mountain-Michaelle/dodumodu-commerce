import { q1, sql } from "./sql";
import type { Db } from "../db";
import { randomToken } from "./crypto";
import { BLOCK_IP_TTL_HOURS, DEVICE_AUTH_MAX_FAILURES } from "./config";
import { createBlock, ipBlockHashHex } from "./blocks";

export interface DeviceFailureResult {
  failures: number;
  blocked: boolean;
}

/**
 * Shared failure counter for all first-party verification methods. Trusted
 * device flows keep their existing account/IP throttles, while an untrusted
 * browser is blocked on the browser identifier after the configured threshold.
 */
export async function recordDeviceFailure(
  db: Db,
  throttleKey: Uint8Array,
  flowId: string,
  ip: string,
  increment = true,
): Promise<DeviceFailureResult> {
  const row = increment
    ? await q1<{ failures: number; vid_hash: string | null; via: string }>(db,
    sql`UPDATE aa_auth_flows
       SET totp_fails = totp_fails + 1
     WHERE id = ${flowId}::uuid AND expires_at > now() AND stage IN ('otp', 'totp')
     RETURNING totp_fails AS failures, encode(vid_hash, 'hex') AS vid_hash, via`)
    : await q1<{ failures: number; vid_hash: string | null; via: string }>(db,
    sql`SELECT totp_fails AS failures, encode(vid_hash, 'hex') AS vid_hash, via
      FROM aa_auth_flows
     WHERE id = ${flowId}::uuid AND expires_at > now() AND stage IN ('otp', 'totp')`);
  if (!row) return { failures: 0, blocked: false };

  const blocked = row.failures >= DEVICE_AUTH_MAX_FAILURES && row.via !== "device";
  if (!blocked) return { failures: row.failures, blocked: false };

  const ipRef = randomToken();
  try {
    await createBlock(db, {
      kind: "ip",
      keyHashHex: await ipBlockHashHex(throttleKey, ip),
      blockRef: ipRef,
      reason: `auth_failures:${flowId}`,
      expiresAt: new Date(Date.now() + BLOCK_IP_TTL_HOURS * 3600_000),
    });
    if (row.vid_hash) {
      await createBlock(db, {
        kind: "device",
        keyHashHex: row.vid_hash,
        blockRef: randomToken(),
        reason: `auth_failures:${flowId}`,
      });
    }
  } catch {
    // The flow/dead-state path remains authoritative if block persistence fails.
  }
  await q1(db,
    sql`UPDATE aa_auth_flows SET stage = 'dead'
     WHERE id = ${flowId}::uuid AND totp_fails >= ${DEVICE_AUTH_MAX_FAILURES}`);
  return { failures: row.failures, blocked: true };
}

export async function clearDeviceFailures(db: Db, flowId: string): Promise<void> {
  await q1(db,
    sql`UPDATE aa_auth_flows SET totp_fails = 0
     WHERE id = ${flowId}::uuid AND expires_at > now()`);
}
