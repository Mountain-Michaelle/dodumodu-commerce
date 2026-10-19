// Guarded admin pages (currentwork.md step B) — LOCAL NODE ONLY.
// Maps clean URLs to dist files and gates them on a valid admin session:
//   GET /admin/sign-in/            public  -> login HTML (no redirect loop)
//   GET /admin, /admin/            guarded -> dist/admin/index.html else 302
//   GET /admin/sessions[/]         guarded -> sessions HTML else 302
//   GET /admin/devices[/]          guarded -> devices HTML else 302
//   GET /admin/assets/*            public  -> login JS/CSS (external files only, CSP)
// Guard fail => 302 to /admin/sign-in/ for documents, 401 JSON for XHR/fetch.
// Server-side, so disabling JS cannot bypass it.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Context, Hono } from "hono";
import type { Env } from "../env";
import { contentTypeFor, resolveWithinRoot } from "./mediaPath";
import { loadSession } from "../auth/middleware";

type AC = Context<{ Bindings: Env }>;

const LOGIN_PATH = "/admin/sign-in/";

// Security headers shared by every admin UI response. Login has no inline
// scripts or styles (all external), so a strict CSP is safe.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self'; connect-src 'self'; form-action 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};

function assetResponse(c: AC, filePath: string) {
  const buffer = readFileSync(filePath);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return c.body(bytes, 200, {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-cache",
    ...SECURITY_HEADERS,
  });
}

/** Any valid session (admin OR staff)? Same lookupSession the JSON APIs use. */
async function isSession(c: Context<{ Bindings: Env }>): Promise<boolean> {
  try {
    const s = await loadSession(c as never);
    return !!s;
  } catch {
    return false;
  }
}

/** Valid admin session? Staff are not admins. */
async function isAdminSession(c: Context<{ Bindings: Env }>): Promise<boolean> {
  try {
    const s = await loadSession(c as never);
    return !!s && s.role === "admin";
  } catch {
    return false;
  }
}

function deny(c: AC) {
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("text/html")) return c.redirect(LOGIN_PATH, 302);
  return c.json({ error: "Sign in to use the admin" }, 401);
}

export function mountAdminPages(app: Hono<{ Bindings: Env }>, backendRoot: string): void {
  const uiRoot = resolve(join(backendRoot, "src", "auth-ui"));

  // allow: "public"  = anyone (sign-in page + assets)
  //        "session" = any authenticated user (admin OR staff) — the console
  //                    shell and the user's own sessions page. The shell holds
  //                    no secrets; the JSON APIs enforce per-user permissions,
  //                    so staff may load it and see only what they're allowed.
  //        "admin"   = admin only (trusted-device management).
  const page = (dir: string, file: string, allow: "public" | "session" | "admin") => async (c: AC) => {
    if (allow !== "public") {
      const ok = allow === "admin"
        ? await isAdminSession(c as unknown as Context<{ Bindings: Env }>)
        : await isSession(c as unknown as Context<{ Bindings: Env }>);
      if (!ok) return deny(c);
    }
    const resolved = resolveWithinRoot(resolve(dir), file);
    if (!resolved) return c.text("Not found", 404);
    return assetResponse(c, resolved);
  };

  // Public static assets (JS/CSS). These contain no secrets — the security
  // boundary is the guarded pages + APIs, not client code. The login page MUST
  // load its own CSS/JS while unauthenticated, so these are served publicly.
  // sessions.js / devices.js only render data via guarded APIs, so exposure is safe.
  const asset = (name: string) => async (c: AC) => {
    const root = resolve(uiRoot);
    const resolved = resolveWithinRoot(root, name);
    if (!resolved) return c.text("Not found", 404);
    return assetResponse(c, resolved);
  };

  // Public sign-in (strict admin entry). Serves login HTML with asset paths
  // rewritten from /auth-ui/* to the guarded /admin/assets/* prefix.
  app.get("/admin/sign-in/", async (c) => {
    const resolved = resolveWithinRoot(uiRoot, "login.html");
    if (!resolved) return c.text("Not found", 404);
    const html = readFileSync(resolved, "utf8").replaceAll("/auth-ui/", "/admin/assets/");
    return c.html(html, 200, SECURITY_HEADERS);
  });

  // Guarded console + sub-pages.
  const adminDir = resolve(join(backendRoot, "..", "dodumodu_site", "dist", "admin"));
  const consolePage = page(adminDir, "index.html", "session");
  app.get("/admin", consolePage);
  app.get("/admin/", consolePage);
  app.get("/admin/sessions", page(uiRoot, "sessions.html", "session"));
  app.get("/admin/sessions/", page(uiRoot, "sessions.html", "session"));
  app.get("/admin/devices", page(uiRoot, "devices.html", "admin"));
  app.get("/admin/devices/", page(uiRoot, "devices.html", "admin"));

  // Public assets (JS/CSS only — fixed map, no traversal). Safe to expose:
  // no secrets in client code; sessions.js/devices.js render only via guarded APIs.
  for (const name of ["auth.js", "auth.css", "qr.js", "qr-logo.mjs", "sessions.js", "devices.js"]) {
    app.get(`/admin/assets/${name}`, asset(name));
  }
}

