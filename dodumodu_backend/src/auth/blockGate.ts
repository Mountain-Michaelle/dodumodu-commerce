// The one rule for anything that BLOCKS or FLAGS: an administrator, freshly confirmed with the authenticator.
//
// Every blocking surface in the legacy admin router calls this before doing any work. Three separate layers back it up:
// the route-access table is default-deny (a non-admin session never reaches these paths), the registry marks the keys
// admin-only, and this function re-checks the role and the step-up on the session itself - so a mistake in one layer
// does not open the others.
//
//  * session principal : must be an administrator AND hold a fresh step-up window (POST /auth/stepup {code}). The
//                        console already reacts to the 403 below by asking for the authenticator code and retrying.
//  * Access-header principal (the owner behind Cloudflare Access): has no authenticator to ask, so it is accepted only
//                        in sandbox/local runs; in production it is refused here and the owner signs in with a session.
//  * CI / anything else: never.
import type { Context } from "hono";
import { ForbiddenError, PERMISSIONS, type Principal } from "./adminAuth";
import { loadSession } from "./middleware";
import { isNonProduction } from "../config/environment";
import type { Env } from "../env";

type GateContext = Context<{ Bindings: Env; Variables: { principal: Principal; authType?: string } }>;

export async function requireBlockAuthority(c: GateContext): Promise<void> {
  const deny = () => new ForbiddenError(PERMISSIONS.ordersWrite);
  const principal = c.get("principal");
  const authType = c.get("authType");
  if (!principal) throw deny();

  if (authType === "session") {
    if (principal.role !== "admin") throw deny();
    const sess = await loadSession(c as never);
    if (!sess || sess.role !== "admin" || !sess.stepupOk) throw deny();
    return;
  }
  if (authType === "access" && principal.role === undefined && isNonProduction(c.env.ENVIRONMENT)) return;
  throw deny();
}
