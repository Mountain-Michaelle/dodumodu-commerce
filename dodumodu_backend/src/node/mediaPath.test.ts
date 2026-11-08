import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentTypeFor, resolveMediaPath, resolveWithinRoot } from "./mediaPath";

// A real directory with real files: the traversal checks are only meaningful
// against a filesystem that would actually serve the file.
function withRoot<T>(build: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "dodumodu-media-"));
  try {
    mkdirSync(join(root, "uploads"));
    writeFileSync(join(root, "uploads", "bottle.jpg"), "image-bytes");
    writeFileSync(join(root, "secret.txt"), "not for serving");
    writeFileSync(join(root, "uploads", "notes.txt"), "text-bytes");
    return build(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a real file under the root is served", () => {
  withRoot((root) => {
    const file = resolveMediaPath(root, "uploads/bottle.jpg");
    assert.ok(file, "expected the file to resolve");
    assert.ok(file!.endsWith(join("uploads", "bottle.jpg")));
  });
});

test("a missing file is null, not an error", () => {
  withRoot((root) => {
    assert.equal(resolveMediaPath(root, "uploads/nope.jpg"), null);
  });
});

test("a directory is not served — no listings", () => {
  withRoot((root) => {
    assert.equal(resolveMediaPath(root, "uploads"), null);
    assert.equal(resolveMediaPath(root, ""), null);
  });
});

test("'..' cannot climb out of the root", () => {
  withRoot((root) => {
    assert.equal(resolveMediaPath(root, "../secret.txt"), null);
    assert.equal(resolveMediaPath(root, "uploads/../../secret.txt"), null);
    assert.equal(resolveMediaPath(root, "a/b/../../../secret.txt"), null);
  });
});

test("percent-encoded traversal is decoded first, then rejected", () => {
  withRoot((root) => {
    // A filter that only looks for a literal ".." never sees this one.
    assert.equal(resolveMediaPath(root, "..%2f..%2fsecret.txt"), null);
    assert.equal(resolveMediaPath(root, "%2e%2e%2fsecret.txt"), null);
    assert.equal(resolveMediaPath(root, "uploads%2f..%2f..%2fsecret.txt"), null);
  });
});

test("absolute paths, drive letters and backslashes are refused", () => {
  withRoot((root) => {
    assert.equal(resolveMediaPath(root, "/etc/passwd"), null);
    assert.equal(resolveMediaPath(root, "C:/Windows/win.ini"), null);
    assert.equal(resolveMediaPath(root, "..\\secret.txt"), null);
    assert.equal(resolveMediaPath(root, "uploads\\..\\..\\secret.txt"), null);
  });
});

test("null bytes and malformed encodings are refused", () => {
  withRoot((root) => {
    assert.equal(resolveMediaPath(root, "uploads/bottle.jpg%00.txt"), null);
    assert.equal(resolveMediaPath(root, "%zz"), null);
  });
});

test("a symlink pointing outside the root is refused", () => {
  // The link target must really be OUTSIDE the root (a sibling temp dir). Pointing it
  // at a file inside the root is a legitimate in-root link and is correctly served.
  const outside = mkdtempSync(join(tmpdir(), "dodumodu-outside-"));
  try {
    writeFileSync(join(outside, "secret.txt"), "not for serving");
    withRoot((root) => {
      try {
        symlinkSync(join(outside, "secret.txt"), join(root, "uploads", "escape.txt"));
      } catch {
        return; // symlinks unavailable here (Windows without Developer Mode)
      }
      // The path is inside the root, so only the realpath check can catch this.
      assert.equal(resolveMediaPath(root, "uploads/escape.txt"), null);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the write path resolves too — a key that does not exist yet is fine", () => {
  withRoot((root) => {
    // localBucket() writes through this: the file is created afterwards, so a
    // check that demanded an existing file would break every upload.
    const target = resolveWithinRoot(root, "uploads/new-photo.jpg");
    assert.ok(target);
    assert.ok(target!.endsWith(join("uploads", "new-photo.jpg")));
  });
});

test("the write path refuses keys that escape the root", () => {
  withRoot((root) => {
    assert.equal(resolveWithinRoot(root, "../evil.jpg"), null);
    assert.equal(resolveWithinRoot(root, "uploads/../../evil.jpg"), null);
    assert.equal(resolveWithinRoot(root, "/absolute/evil.jpg"), null);
    assert.equal(resolveWithinRoot(root, "C:/evil.jpg"), null);
  });
});

test("content types come from a known extension, never from the bytes", () => {
  assert.equal(contentTypeFor("a/b/c.JPG"), "image/jpeg");
  assert.equal(contentTypeFor("x.webp"), "image/webp");
  assert.equal(contentTypeFor("x.svg"), "image/svg+xml");
  assert.equal(contentTypeFor("x.exe"), "application/octet-stream");
  assert.equal(contentTypeFor("noextension"), "application/octet-stream");
});