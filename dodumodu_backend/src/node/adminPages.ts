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

function assetResponse(c: AC, filePath: string) {
  const buffer = readFileSync(filePath);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return c.body(bytes, 200, {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
}

/** Valid admin session? Same check the JSON APIs use (lookupSession). */
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

  const page = (dir: string, file: string, allow: "public" | "admin") => async (c: AC) => {
    if (allow === "admin" && !(await isAdminSession(c as unknown as Context<{ Bindings: Env }>))) {
      return deny(c);
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
    return c.html(html);
  });

  // Guarded console + sub-pages.
  const adminDir = resolve(join(backendRoot, "..", "dodumodu_site", "dist", "admin"));
  const consolePage = page(adminDir, "index.html", "admin");
  app.get("/admin", consolePage);
  app.get("/admin/", consolePage);
  app.get("/admin/sessions", page(uiRoot, "sessions.html", "admin"));
  app.get("/admin/sessions/", page(uiRoot, "sessions.html", "admin"));
  app.get("/admin/devices", page(uiRoot, "devices.html", "admin"));
  app.get("/admin/devices/", page(uiRoot, "devices.html", "admin"));

  // Public assets (JS/CSS only — fixed map, no traversal). Safe to expose:
  // no secrets in client code; sessions.js/devices.js render only via guarded APIs.
  for (const name of ["auth.js", "auth.css", "sessions.js", "devices.js"]) {
    app.get(`/admin/assets/${name}`, asset(name));
  }
}

