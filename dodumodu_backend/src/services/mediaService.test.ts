import { test } from "node:test";
import assert from "node:assert/strict";
import { mediaService, safeStorageName } from "./mediaService";
import { imageConfigFrom } from "../config/imageConfig";
import {
  pngBytes, jpegBytes, gifBytes, avifBytes, webpLossyBytes,
} from "./imageSignature.test";

/* The upload gate.
 *
   These drive `prepareUpload` with real File objects over the fixtures from
   imageSignature.test, because the security property is not "does the parser read a
   header" but "does the service REFUSE to store something that is not an image". */

const config = imageConfigFrom({});

/** A File over raw bytes, with a chosen name and declared type. */
function fileOf(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes], name, { type });
}

/** The message an upload was refused with, or null if it was accepted. */
async function refuses(file: File, cfg = config): Promise<string | null> {
  try {
    await mediaService.prepareUpload(file, cfg);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/* ---- what must be accepted ---- */

test("a real PNG is accepted and measured from its own header", async () => {
  const result = await mediaService.prepareUpload(fileOf(pngBytes(1200, 900), "photo.png", "image/png"), config);
  assert.equal(result.format, "image/png");
  assert.deepEqual(result.dimensions, { width: 1200, height: 900 });
  assert.match(result.key, /^uploads\/\d+-[0-9a-f-]{36}-photo\.png$/);
});

test("each accepted format is accepted with its own declared type", async () => {
  const cases = [
    [pngBytes(800, 600), "a.png", "image/png", "image/png"],
    [jpegBytes(800, 600), "b.jpg", "image/jpeg", "image/jpeg"],
    [gifBytes(400, 300), "c.gif", "image/gif", "image/gif"],
    [avifBytes(1600, 900), "d.avif", "image/avif", "image/avif"],
    [webpLossyBytes(640, 480), "e.webp", "image/webp", "image/webp"],
  ] as const;
  for (const [bytes, name, type, expectedFormat] of cases) {
    const result = await mediaService.prepareUpload(fileOf(bytes, name, type), config);
    assert.equal(result.format, expectedFormat, `${name} should be accepted`);
  }
});

test("an animated GIF is accepted, not refused for being animated", async () => {
  // GIF89a is what an animation IS. If this fails, the sniffing has started
  // requiring a static header and real files are being dropped.
  const result = await mediaService.prepareUpload(
    fileOf(gifBytes(480, 480, "89a"), "review.gif", "image/gif"), config);
  assert.equal(result.format, "image/gif");
});

test("a file with no declared type is accepted - the bytes are what count", async () => {
  // Some drag-and-drop paths send an empty Content-Type. The old code rejected
  // those outright, which is exactly the failure mode sniffing exists to remove.
  const result = await mediaService.prepareUpload(fileOf(pngBytes(600, 600), "x.png", ""), config);
  assert.equal(result.format, "image/png");
});

/* ---- what must be refused ---- */

test("an HTML body declared as image/png is refused", async () => {
  // The attack this closes: a body of HTML sent with a believable Content-Type and
  // filename, stored under an image key on the delivery domain.
  const html = new TextEncoder().encode("<!doctype html><script>alert(document.cookie)</script>");
  const message = await refuses(fileOf(html, "evil.png", "image/png"));
  assert.ok(message, "an HTML body must never be stored");
  assert.match(message, /JPEG, PNG, WebP, AVIF and GIF/);
});

test("an SVG is refused even when declared as an image", async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  assert.ok(await refuses(fileOf(svg, "logo.png", "image/png")), "SVG is script");
});

test("a PNG named .jpg is stored under a .png key, because the bytes decide", async () => {
  const result = await mediaService.prepareUpload(fileOf(pngBytes(400, 400), "photo.jpg", "image/png"), config);
  assert.match(result.key, /\.png$/);
});

test("a real PNG declared as the wrong type is refused, and the message says what it saw", async () => {
  const message = await refuses(fileOf(pngBytes(400, 400), "x.png", "image/jpeg"));
  assert.ok(message);
  assert.match(message, /do not match its declared type/);
});

test("a truncated file is refused rather than stored with no dimensions", async () => {
  const message = await refuses(fileOf(pngBytes(800, 600).slice(0, 18), "cut.png", "image/png"));
  assert.ok(message);
  assert.match(message, /incomplete or corrupt/i);
});

test("an empty file is refused", async () => {
  assert.match(await refuses(fileOf(new Uint8Array(0), "empty.png", "image/png")) ?? "", /empty/i);
});

test("an image past the dimension ceiling is refused at upload, not at delivery", async () => {
  // Cloudflare cannot transform past 12,000px. Accepting it here would let the
  // operator believe the upload worked and fail only when a customer loaded it.
  assert.match(await refuses(fileOf(pngBytes(13000, 400), "huge.png", "image/png")) ?? "",
    /12000px per side/);
});

test("an image at exactly the ceiling is accepted", async () => {
  const result = await mediaService.prepareUpload(fileOf(pngBytes(12000, 100), "edge.png", "image/png"), config);
  assert.deepEqual(result.dimensions, { width: 12000, height: 100 });
});

test("a file over the size ceiling is refused with the limit in the message", async () => {
  const padded = new Uint8Array(11 * 1024 * 1024);
  padded.set(pngBytes(1200, 900), 0);
  assert.match(await refuses(fileOf(padded, "big.png", "image/png")) ?? "", /limit is 10MB/);
});

/* ---- the ceilings are configuration, not constants in the service ---- */

test("the upload ceiling is read from configuration", async () => {
  const padded = new Uint8Array(2048);
  padded.set(pngBytes(1200, 900), 0);
  const message = await refuses(fileOf(padded, "x.png", "image/png"), imageConfigFrom({ MAX_UPLOAD_BYTES: "1024" }));
  assert.ok(message, "a 1KB ceiling must refuse a 2KB file");
  assert.match(message, /limit is/);
});

test("the key prefix is configuration, and existing uploads/ rows are unaffected", async () => {
  const moved = await mediaService.prepareUpload(fileOf(pngBytes(400, 400), "x.png", "image/png"),
    imageConfigFrom({ IMAGE_KEY_PREFIX: "products/7/original" }));
  assert.match(moved.key, /^products\/7\/original\//);
  const unchanged = await mediaService.prepareUpload(fileOf(pngBytes(400, 400), "x.png", "image/png"), config);
  assert.match(unchanged.key, /^uploads\//, "the default must leave existing keys exactly as they were");
});

test("every generated key carries a uuid, so no two uploads can collide", async () => {
  const a = await mediaService.prepareUpload(fileOf(pngBytes(400, 400), "same.png", "image/png"), config);
  const b = await mediaService.prepareUpload(fileOf(pngBytes(400, 400), "same.png", "image/png"), config);
  assert.notEqual(a.key, b.key);
});

test("a hostile filename cannot escape the key prefix", async () => {
  const result = await mediaService.prepareUpload(
    fileOf(pngBytes(400, 400), "../../../etc/passwd.png", "image/png"), config);
  // One prefix plus one filename: the traversal became underscores, not directories.
  assert.match(result.key, /^uploads\/[^/]+$/);
  assert.ok(!safeStorageName("../../evil").includes("/"));
});