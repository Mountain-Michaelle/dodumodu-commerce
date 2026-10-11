// Shared flow helpers: stages, loader, verify secrets.
import { q1, sql } from "./sql";
import type { Db } from "../db";
import { tokenHashHex } from "./keys";

export type Stage = "otp" | "phrase" | "enroll_phrase" | "totp" | "totp_enroll" | "ready" | "done";

export interface FlowRow {
  id: string; stage: Stage; user_id: string | null; email: string;
}

export interface VerifySecrets { otpKey: Uint8Array; throttleKey: Uint8Array; }

/** Load the flow by its opaque token. Unknown/expired token = null (-> 401). */
export async function loadFlow(db: Db, flowToken: string): Promise<FlowRow | null> {
  const hashHex = await tokenHashHex(flowToken);
  return q1<FlowRow>(db,
    sql`SELECT id::text AS id, stage, user_id::text AS user_id, email
      FROM aa_auth_flows
      WHERE token_hash = decode(${hashHex}, 'hex') AND expires_at > now()`);
}
