// Device + IP blocks (spec §4.5). Checked at the very start of every /auth/*
// request via an indexed lookup; a blocked client gets the uniform response and
// no real OTP. key_hash is the HMAC (vid for device, ip network for ip); ip_enc
// is the encrypted IP for admin display (NULL for device blocks). All writes are
// single guarded statements; lifting only sets lifted_at (never resets counters,
// never trusts the device).
import { q, q1, sql } from "./sql";
import type { Db } from "../db";
import { toHex } from "./crypto";
import { blockPrefix } from "./ip";

export type BlockKind = "device" | "ip";

/**
 * HMAC-SHA256(key, msg) as HEX. Block keys must be bytea-friendly hex — the
 * throttle-key emailTag returns base64url, which decode($n,'hex') rejects, so
 * the block helpers carry their own tiny HMAC with distinct domain labels.
 */
async function hmacHex(key: Uint8Array, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC", k as CryptoKey, new TextEncoder().encode(msg) as BufferSource);
  return toHex(new Uint8Array(sig));
}

/**
 * HMAC of the __Host-vid token (domain-separated). Stored on the flow as
 * vid_hash at creation and looked up as a 'device' block on every entry.
 */
export async function vidHashHex(throttleKey: Uint8Array, vid: string): Promise<string> {
  return hmacHex(throttleKey, `aa-vid:${vid}`);
}

/**
 * HMAC of the block network (/32 v4, /64 v6) for 'ip' blocks. Unparseable
 * input hashes the literal "invalid" so a bad IP still gets a stable key
 * instead of skipping the check (spec §4.13).
 */
export async function ipBlockHashHex(throttleKey: Uint8Array, ip: string): Promise<string> {
  return hmacHex(throttleKey, `aa-blockip:${blockPrefix(ip) ?? "invalid"}`);
}

export interface ActiveBlock {
  id: string;
  kind: BlockKind;
  blockRef: string;
  reason: string | null;
  expiresAt: Date | null;
}

/** Is this key currently blocked? Indexed (kind, key_hash) WHERE lifted_at IS NULL. */
export async function isBlocked(db: Db, kind: BlockKind, keyHashHex: string): Promise<ActiveBlock | null> {
  return q1<ActiveBlock>(db,
    sql`SELECT id::text AS id, kind, block_ref AS "blockRef", reason,
               expires_at AS "expiresAt"
          FROM aa_blocks
         WHERE kind = ${kind} AND key_hash = decode(${keyHashHex}, 'hex')
           AND lifted_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         LIMIT 1`);
}

export interface NewBlock {
  kind: BlockKind;
  keyHashHex: string;
  blockRef: string;
  ipEnc?: string | null;
  userId?: string | null;
  reason?: string | null;
  eventRef?: number | null;
  expiresAt?: Date | null; // NULL = until an admin lifts (device)
}

export async function createBlock(db: Db, n: NewBlock): Promise<string> {
  const row = await q1<{ id: string }>(db,
    sql`INSERT INTO aa_blocks
          (kind, key_hash, ip_enc, user_id, block_ref, reason, event_ref, expires_at)
        VALUES (
          ${n.kind}, decode(${n.keyHashHex}, 'hex'), ${n.ipEnc ?? null},
          ${n.userId ?? null}::uuid, ${n.blockRef}, ${n.reason ?? null},
          ${n.eventRef ?? null}, ${n.expiresAt ?? null})
        RETURNING id::text AS id`);
  if (!row) throw new Error("block insert returned no row");
  return row.id;
}

/** Lift a block (step-up, logged, emailed by the caller). Only sets lifted_at. */
export async function liftBlock(db: Db, blockId: string, actorId: string): Promise<boolean> {
  const rows = await q<{ id: string }>(db,
    sql`UPDATE aa_blocks SET lifted_at = now(), lifted_by = ${actorId}::uuid
         WHERE id = ${blockId}::uuid AND lifted_at IS NULL
         RETURNING id::text AS id`);
  return rows.length === 1;
}
