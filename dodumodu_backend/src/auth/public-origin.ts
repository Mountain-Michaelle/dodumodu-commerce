// The public origin used in links we hand out (device invites). It is NEVER taken from a Host or
// X-Forwarded-* header: it is the deployment's own configured origin, or the origin of the request
// the platform handed to the Worker (set by the dispatcher, which first strips any client-sent copy).
import { adminBasePath } from "../config/adminBase";

export const PUBLIC_ORIGIN_HEADER = "x-admin-public-origin";

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/** A usable origin ("scheme://host[:port]") or null. https everywhere except localhost. */
export function cleanOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}

/** Origin to put in links: configured one wins; else the platform-reported request origin (http upgraded off-localhost). */
export function resolvePublicOrigin(configured: string | undefined, requestOrigin: string | null | undefined): string | null {
  const fixed = cleanOrigin(configured);
  if (fixed) return fixed;
  if (!requestOrigin) return null;
  try {
    const u = new URL(requestOrigin);
    if (u.protocol === "http:" && !isLocalHost(u.hostname)) u.protocol = "https:";
    return cleanOrigin(u.origin);
  } catch { return null; }
}

/** Full link for the invite page: <origin><admin base>/device/accept/#<token> (fragment: never sent to a server or logged). */
export function inviteLink(
  env: { ADMIN_PUBLIC_ORIGIN?: string; ENVIRONMENT?: string; ADMIN_BASE_PATH?: string },
  requestOrigin: string | null | undefined, token: string,
): string | null {
  const origin = resolvePublicOrigin(env.ADMIN_PUBLIC_ORIGIN, requestOrigin);
  if (!origin) return null;
  const base = adminBasePath({ ENVIRONMENT: env.ENVIRONMENT as never, ADMIN_BASE_PATH: env.ADMIN_BASE_PATH }) || "/admin";
  return `${origin}${base}/device/accept/#${token}`;
}
