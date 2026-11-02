import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAdminBasePath,
  adminBasePath,
  isValidAdminBasePath,
  isLegacyAdminPath,
  DEFAULT_ADMIN_BASE_PATH,
} from "./adminBase";

/* Configuration validation — spec §3. */

/* ---- resolveAdminBasePath ---- */

test("local development unset defaults to /admin", () => {
  assert.equal(
    resolveAdminBasePath({ ENVIRONMENT: "sandbox", ADMIN_BASE_PATH: undefined }),
    DEFAULT_ADMIN_BASE_PATH,
  );
});

test("local development empty defaults to /admin", () => {
  assert.equal(resolveAdminBasePath({ ENVIRONMENT: "sandbox", ADMIN_BASE_PATH: "" }), "/admin");
});

test("valid custom namespace works in development", () => {
  assert.equal(
    resolveAdminBasePath({ ENVIRONMENT: "sandbox", ADMIN_BASE_PATH: "/e5he78f823523" }),
    "/e5he78f823523",
  );
});

test("explicit /admin works in development", () => {
  assert.equal(
    resolveAdminBasePath({ ENVIRONMENT: "sandbox", ADMIN_BASE_PATH: "/admin" }),
    "/admin",
  );
});

test("production missing value disables admin routes", () => {
  assert.equal(resolveAdminBasePath({ ENVIRONMENT: "production" }), null);
});

test("production empty value disables admin routes", () => {
  assert.equal(resolveAdminBasePath({ ENVIRONMENT: "production", ADMIN_BASE_PATH: "" }), null);
});

test("production invalid value disables admin routes", () => {
  assert.equal(
    resolveAdminBasePath({ ENVIRONMENT: "production", ADMIN_BASE_PATH: "no-slash" }),
    null,
  );
});

test("production valid custom namespace works", () => {
  assert.equal(
    resolveAdminBasePath({ ENVIRONMENT: "production", ADMIN_BASE_PATH: "/e5he78f823523" }),
    "/e5he78f823523",
  );
});

test("production explicit /admin works", () => {
  assert.equal(
    resolveAdminBasePath({ ENVIRONMENT: "production", ADMIN_BASE_PATH: "/admin" }),
    "/admin",
  );
});

/* ---- isValidAdminBasePath ---- */

test("validates simple opaque paths", () => {
  assert.equal(isValidAdminBasePath("/admin"), true);
  assert.equal(isValidAdminBasePath("/e5he78f823523"), true);
  assert.equal(isValidAdminBasePath("/a8f29c7d51"), true);
});

test("rejects empty values", () => {
  assert.equal(isValidAdminBasePath(""), false);
  assert.equal(isValidAdminBasePath(undefined), false);
  assert.equal(isValidAdminBasePath(null), false);
});

test("rejects missing leading slash", () => {
  assert.equal(isValidAdminBasePath("admin"), false);
  assert.equal(isValidAdminBasePath("e5he78f823523"), false);
});

test("rejects multiple segments", () => {
  assert.equal(isValidAdminBasePath("/admin/"), false);
  assert.equal(isValidAdminBasePath("/admin/orders"), false);
  assert.equal(isValidAdminBasePath("/a/b"), false);
});

test("rejects trailing slash", () => {
  assert.equal(isValidAdminBasePath("/admin/"), false);
});

test("rejects whitespace", () => {
  assert.equal(isValidAdminBasePath("/ admin"), false);
  assert.equal(isValidAdminBasePath("/admin "), false);
  assert.equal(isValidAdminBasePath("/ad min"), false);
});

test("rejects backslashes", () => {
  assert.equal(isValidAdminBasePath("/admin\\"), false);
  assert.equal(isValidAdminBasePath("/\\admin"), false);
});

test("rejects double slashes", () => {
  assert.equal(isValidAdminBasePath("//admin"), false);
  assert.equal(isValidAdminBasePath("/ad//min"), false);
});

test("rejects encoded slash or traversal", () => {
  assert.equal(isValidAdminBasePath("/%2fadmin"), false);
  assert.equal(isValidAdminBasePath("/..%2f"), false);
  assert.equal(isValidAdminBasePath("/.."), false);
});

test("rejects query strings and fragments", () => {
  assert.equal(isValidAdminBasePath("/admin?foo=bar"), false);
  assert.equal(isValidAdminBasePath("/admin#section"), false);
});

test("rejects dot segments", () => {
  assert.equal(isValidAdminBasePath("/."), false);
  assert.equal(isValidAdminBasePath("/./admin"), false);
});

test("rejects reserved public route collisions", () => {
  assert.equal(isValidAdminBasePath("/"), false);
  assert.equal(isValidAdminBasePath("/health"), false);
  assert.equal(isValidAdminBasePath("/media"), false);
  assert.equal(isValidAdminBasePath("/page-data"), false);
  assert.equal(isValidAdminBasePath("/published"), false);
  assert.equal(isValidAdminBasePath("/create-order"), false);
});

/* ---- isLegacyAdminPath ---- */

test("identifies legacy admin paths exactly", () => {
  assert.equal(isLegacyAdminPath("/admin"), true);
  assert.equal(isLegacyAdminPath("/admin-v2"), true);
  assert.equal(isLegacyAdminPath("/auth"), true);
});

test("identifies nested legacy admin paths", () => {
  assert.equal(isLegacyAdminPath("/admin/"), true);
  assert.equal(isLegacyAdminPath("/admin/orders"), true);
  assert.equal(isLegacyAdminPath("/admin-v2/devices"), true);
  assert.equal(isLegacyAdminPath("/auth/sessions"), true);
});

test("does not flag non-legacy paths", () => {
  assert.equal(isLegacyAdminPath("/"), false);
  assert.equal(isLegacyAdminPath("/e5he"), false);
  assert.equal(isLegacyAdminPath("/products"), false);
  assert.equal(isLegacyAdminPath("/administrator"), false);
});

/* ---- adminBasePath convenience wrapper ---- */

test("wrapper passes through to resolver", () => {
  assert.equal(
    adminBasePath({ ENVIRONMENT: "sandbox", ADMIN_BASE_PATH: "/custom" }),
    "/custom",
  );
  assert.equal(adminBasePath({ ENVIRONMENT: "production" }), null);
});
