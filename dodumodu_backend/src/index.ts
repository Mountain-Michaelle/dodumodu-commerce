// Cloudflare Workers composition root — this file is `main` in wrangler.toml
// and the only thing the production bundle is built from.
//
// It registers the Neon driver, mounts the admin UI pages (login, console,
// sessions, devices + their JS/CSS assets) ahead of the legacy /admin router,
// then hands over the shared app.
//
// Nothing local lives here on purpose: src/node.ts and src/dbDrivers/pg.ts are
// never imported from this file, which is what keeps `pg` and the local shims
// out of the Worker bundle. src/isolation.test.ts enforces that.
import { registerDbDriver } from "./db";
import { neonDriver } from "./dbDrivers/neon";
import { app } from "./app";
import type { Context } from "hono";
import { loadSession } from "./auth/middleware";
import {
  ADMIN_LOGIN_HTML,
  ADMIN_AUTH_CSS,
  ADMIN_AUTH_JS,
  ADMIN_CONSOLE_HTML,
  ADMIN_SESSIONS_HTML,
  ADMIN_SESSIONS_JS,
  ADMIN_DEVICES_HTML,
  ADMIN_DEVICES_JS,
  ADMIN_QR_JS,
  ADMIN_QR_LOGO_MJS,
} from "./generated/adminPages";

registerDbDriver(neonDriver);

const LOGIN_PATH = "/admin/sign-in/";

// Security headers shared by every admin UI response.
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self'; connect-src 'self'; form-action 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};

function htmlResponse(c: Context, html: string) {
  return c.html(html, 200, SECURITY_HEADERS);
}

function assetResponse(c: Context, body: string, contentType: string) {
  return c.body(body, 200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
  });
}

/** Any valid session (admin OR staff)? Same lookupSession the JSON APIs use. */
async function isSession(c: Context): Promise<boolean> {
  try {
    const s = await loadSession(c as never);
    return !!s;
  } catch {
    return false;
  }
}

/** Valid admin session? Staff are not admins. */
async function isAdminSession(c: Context): Promise<boolean> {
  try {
    const s = await loadSession(c as never);
    return !!s && s.role === "admin";
  } catch {
    return false;
  }
}

function deny(c: Context) {
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("text/html")) return c.redirect(LOGIN_PATH, 302);
  return c.json({ error: "Sign in to use the admin" }, 401);
}

// Guarded page helper: public routes skip the session check; session/admin
// routes redirect unauthenticated visitors to the login page.
const page =
  (html: string, allow: "public" | "session" | "admin") =>
  async (c: Context) => {
    if (allow !== "public") {
      const ok =
        allow === "admin"
          ? await isAdminSession(c as never)
          : await isSession(c as never);
      if (!ok) return deny(c);
    }
    return htmlResponse(c, html);
  };

// Public sign-in (strict admin entry). Serves login HTML. Redirects to /admin/
// if already signed in so there's no redirect loop.
app.get("/admin/sign-in/", async (c) => {
  const ok = await isSession(c as never);
  if (ok) return c.redirect("/admin/", 302);
  return htmlResponse(c, ADMIN_LOGIN_HTML);
});

// Public static assets — no secrets in client code; the login page MUST load
// its own CSS/JS while unauthenticated. sessions.js/devices.js only render via
// guarded APIs, so exposure is safe.
app.get("/admin/assets/auth.css", (c) =>
  assetResponse(c, ADMIN_AUTH_CSS, "text/css; charset=utf-8")
);
app.get("/admin/assets/auth.js", (c) =>
  assetResponse(c, ADMIN_AUTH_JS, "text/javascript; charset=utf-8")
);
app.get("/admin/assets/sessions.js", (c) =>
  assetResponse(c, ADMIN_SESSIONS_JS, "text/javascript; charset=utf-8")
);
app.get("/admin/assets/devices.js", (c) =>
  assetResponse(c, ADMIN_DEVICES_JS, "text/javascript; charset=utf-8")
);
app.get("/admin/assets/qr.js", (c) =>
  assetResponse(c, ADMIN_QR_JS, "text/javascript; charset=utf-8")
);
app.get("/admin/assets/qr-logo.mjs", (c) =>
  assetResponse(c, ADMIN_QR_LOGO_MJS, "text/javascript; charset=utf-8")
);

// Guarded console + sub-pages.
app.get("/admin", page(ADMIN_CONSOLE_HTML, "session"));
app.get("/admin/", page(ADMIN_CONSOLE_HTML, "session"));
app.get("/admin/sessions", page(ADMIN_SESSIONS_HTML, "session"));
app.get("/admin/sessions/", page(ADMIN_SESSIONS_HTML, "session"));
app.get("/admin/devices", page(ADMIN_DEVICES_HTML, "admin"));
app.get("/admin/devices/", page(ADMIN_DEVICES_HTML, "admin"));

export default app;
