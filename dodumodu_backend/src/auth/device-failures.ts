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
 * Shared failure counter for all first-party verification methods.
 *
 * Trusted flows keep the default account/IP throttles and are NEVER device-blocked:
 *   - via = 'device'  (the first-configured, cookie-matched device path), and
 *   - trusted = true  (an email-path flow that presented a matching device cookie).
 * Any other (new/unrecognised) browser is blocked on its browser identifier
 * (__Host-vid) at the DEVICE_AUTH_MAX_FAILURES-th failure, until an admin lifts it.
 * The block is DEVICE-based: it never touches the network, so other people on the
 * same IP (shared NAT / mobile carriers) and the admin's trusted browser keep working.
 * Only when the browser carries no vid at all (nothing to key a device block on) do we
 * fall back to a time-boxed IP block so a cookie-less attacker cannot dodge the rule.
 */
export async function recordDeviceFailure(
  db: Db,
  throttleKey: Uint8Array,
  flowId: string,
  ip: string,
  increment = true,
): Promise<DeviceFailureResult> {
  type Row = { failures: number; vid_hash: string | null; via: string; trusted: boolean };
  const row = increment
    ? await q1<Row>(db,
    sql`UPDATE aa_auth_flows
       SET totp_fails = totp_fails + 1
     WHERE id = ${flowId}::uuid AND expires_at > now() AND stage IN ('otp', 'totp')
     RETURNING totp_fails AS failures, encode(vid_hash, 'hex') AS vid_hash, via, trusted`)
    : await q1<Row>(db,
    sql`SELECT totp_fails AS failures, encode(vid_hash, 'hex') AS vid_hash, via, trusted
      FROM aa_auth_flows
     WHERE id = ${flowId}::uuid AND expires_at > now() AND stage IN ('otp', 'totp')`);
  if (!row) return { failures: 0, blocked: false };

  const untrusted = row.via !== "device" && !row.trusted;
  const blocked = row.failures >= DEVICE_AUTH_MAX_FAILURES && untrusted;
  if (!blocked) return { failures: row.failures, blocked: false };

  try {
    if (row.vid_hash) {
      await createBlock(db, {
        kind: "device",
        keyHashHex: row.vid_hash,
        blockRef: randomToken(),
        reason: `auth_failures:${flowId}`, // expiresAt NULL: only an admin lifts it
      });
    } else {
      await createBlock(db, {
        kind: "ip",
        keyHashHex: await ipBlockHashHex(throttleKey, ip),
        blockRef: randomToken(),
        reason: `auth_failures:${flowId}`,
        expiresAt: new Date(Date.now() + BLOCK_IP_TTL_HOURS * 3600_000),
      });
    }
  } catch {
    // The flow/dead-state path below remains authoritative if block persistence fails.
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