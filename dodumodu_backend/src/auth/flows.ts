// Shared flow helpers: stages, loader, verify secrets.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { tokenHashHex } from "./keys";

export type Stage =
  | "otp" | "totp" | "totp_enroll"
  | "backup_codes" | "recovery" | "ready" | "done" | "dead";

export interface FlowRow {
  id: string; stage: Stage; user_id: string | null; email: string;
  via: string; vid_hash: string | null; // hex HMAC of the __Host-vid, set at creation
}

export interface VerifySecrets { otpKey: Uint8Array; throttleKey: Uint8Array; }

/** Load the flow by its opaque token. Unknown/expired token = null (-> 401). */
export async function loadFlow(db: Db, flowToken: string): Promise<FlowRow | null> {
  const hashHex = await tokenHashHex(flowToken);
  return q1<FlowRow>(db,
    sql`SELECT id::text AS id, stage, user_id::text AS user_id, email, via,
          encode(vid_hash, 'hex') AS vid_hash
      FROM aa_auth_flows
      WHERE token_hash = decode(${hashHex}, 'hex') AND expires_at > now()`);
}
