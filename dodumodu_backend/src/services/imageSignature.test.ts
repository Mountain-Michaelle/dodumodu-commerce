import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sniffImageFormat, readImageDimensions, EXTENSION_FOR_FORMAT,
} from "./imageSignature";

/* Telling what an upload ACTUALLY is, from its bytes.
 *
   The bug this pins: `prepareUpload` trusted `file.type` and the filename. Both are
   client-supplied, so a body of HTML posted as image/png became an object stored
   under an image key on the delivery domain - stored XSS on the storefront's own
   origin. These fixtures are hand-built byte arrays rather than real files: the
   point is that a VALID header is trusted and anything else is refused, and a
   twenty-byte fixture is obviously not smuggling anything. */

// --- byte builders, one per format, correct enough to satisfy the parsers ---

/** PNG: signature, then an IHDR carrying width/height. */
export function pngBytes(width: number, height: number, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  const view = new DataView(b.buffer);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  view.setUint32(8, 13, false);           // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12);   // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return b;
}

/** JPEG: SOI, an APP0 segment (which the parser must walk past), then an SOF0. */
export function jpegBytes(width: number, height: number, size = 128): Uint8Array {
  const b = new Uint8Array(size);
  const view = new DataView(b.buffer);
  b.set([0xff, 0xd8], 0); // SOI
  // APP0 declares a 16-byte segment starting at offset 2, so the next marker is at
  // 2 + 2 + 16 = 20. Placing SOF0 anywhere earlier would put it INSIDE the APP0
  // segment, which is the mistake that made this fixture read as a broken parser.
  b.set([0xff, 0xe0, 0x00, 0x10], 2); // APP0, length 16
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20); // SOF0, length 17, 8-bit precision
  view.setUint16(25, height, false);
  view.setUint16(27, width, false);
  return b;
}

/** GIF87a/GIF89a: the logical screen descriptor sits at a fixed offset. */
export function gifBytes(width: number, height: number, revision = "89a", size = 32): Uint8Array {
  const b = new Uint8Array(size);
  b.set([..."GIF" + revision].map((c) => c.charCodeAt(0)), 0);
  const view = new DataView(b.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return b;
}

/** WebP lossy: RIFF/WEBP header, then a VP8 chunk with 14-bit dimensions. */
export function webpLossyBytes(width: number, height: number, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  const view = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0);   // "RIFF"
  view.setUint32(4, size - 8, true);
  b.set([0x57, 0x45, 0x42, 0x50], 8);   // "WEBP"
  b.set([0x56, 0x50, 0x38, 0x20], 12);  // "VP8 "
  view.setUint32(16, 12, true);
  b.set([0x9d, 0x01, 0x2a], 23);        // sync code
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return b;
}

/** WebP lossless: a 0x2F signature byte, then 14-bit width-1 / height-1. */
export function webpLosslessBytes(width: number, height: number, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  const view = new DataView(b.buffer);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, size - 8, true);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x4c], 12);  // "VP8L"
  view.setUint32(16, 12, true);
  b[20] = 0x2f;
  view.setUint32(21, ((height - 1) << 14) | (width - 1), true);
  return b;
}

/** AVIF: ftyp declaring brands, then meta > iprp > ipco > ispe. */
export function avifBytes(width: number, height: number, size = 128): Uint8Array {
  const b = new Uint8Array(size);
  const view = new DataView(b.buffer);
  // Box sizes are the whole point of a box tree: the walk advances by them, so a
  // fixture whose first box claims to be the whole file makes every parser walk
  // straight past the ispe it is supposed to find.
  view.setUint32(0, 24, false);           // ftyp: 8 header + 4 major + 4 minor + 8 brands
  b.set([0x66, 0x74, 0x79, 0x70], 4);    // "ftyp"
  b.set([0x61, 0x76, 0x69, 0x66], 8);    // major brand "avif"
  b.set([0x6d, 0x69, 0x66, 0x31], 16);   // compatible "mif1"
  b.set([0x61, 0x76, 0x69, 0x66], 20);   // compatible "avif"

  view.setUint32(24, 60, false);          // meta, which is a FullBox
  b.set([0x6d, 0x65, 0x74, 0x61], 28);   // "meta"
  // 32..36 stays zero: that is meta's version/flags, which the walk skips.
  view.setUint32(36, 36, false);
  b.set([0x69, 0x70, 0x72, 0x70], 40);   // "iprp"
  view.setUint32(44, 28, false);
  b.set([0x69, 0x70, 0x63, 0x6f], 48);   // "ipco"
  view.setUint32(52, 20, false);
  b.set([0x69, 0x73, 0x70, 0x65], 56);   // "ispe"
  view.setUint32(60, width, false);
  view.setUint32(64, height, false);
  return b;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/* ---- a valid file of each format is recognised and measured ---- */

test("every accepted format is recognised from its own signature", () => {
  assert.equal(sniffImageFormat(pngBytes(800, 600)), "image/png");
  assert.equal(sniffImageFormat(jpegBytes(1024, 768)), "image/jpeg");
  assert.equal(sniffImageFormat(gifBytes(320, 240)), "image/gif");
  assert.equal(sniffImageFormat(gifBytes(320, 240, "87a")), "image/gif");
  assert.equal(sniffImageFormat(webpLossyBytes(640, 480)), "image/webp");
  assert.equal(sniffImageFormat(webpLosslessBytes(200, 100)), "image/webp");
  assert.equal(sniffImageFormat(avifBytes(1200, 900)), "image/avif");
});

test("each accepted format reports its pixel dimensions", () => {
  assert.deepEqual(readImageDimensions(pngBytes(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(readImageDimensions(jpegBytes(1024, 768)), { width: 1024, height: 768 });
  assert.deepEqual(readImageDimensions(gifBytes(320, 240)), { width: 320, height: 240 });
  assert.deepEqual(readImageDimensions(webpLossyBytes(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(readImageDimensions(webpLosslessBytes(200, 100)), { width: 200, height: 100 });
  assert.deepEqual(readImageDimensions(avifBytes(1200, 900)), { width: 1200, height: 900 });
});

test("GIF89a is accepted as readily as GIF87a", () => {
  // An animated GIF is nearly always 89a, so refusing the newer revision would
  // refuse exactly the files worth keeping.
  assert.equal(sniffImageFormat(gifBytes(400, 400, "89a")), "image/gif");
  assert.deepEqual(readImageDimensions(gifBytes(400, 400, "89a")), { width: 400, height: 400 });
});

test("AVIF is recognised from a compatible brand, not only the major one", () => {
  const b = avifBytes(100, 100);
  b.set(ascii("mif1"), 8); // major brand rewritten; "avif" stays compatible
  assert.equal(sniffImageFormat(b), "image/avif");
});

test("the animated AVIF brand 'avis' is accepted", () => {
  const b = avifBytes(100, 100);
  b.set(ascii("avis"), 8);
  assert.equal(sniffImageFormat(b), "image/avif");
});

/* ---- everything that is not one of ours is refused ---- */

test("an HTML body renamed .png is refused", () => {
  const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
  assert.equal(sniffImageFormat(html), null);
});

test("SVG is refused - it is script, and it would sit under an image key", () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
  assert.equal(sniffImageFormat(svg), null);
});

test("an executable is refused", () => {
  const elf = new Uint8Array(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46], 0); // \x7fELF
  assert.equal(sniffImageFormat(elf), null);
});

test("a truncated file with no header is refused", () => {
  assert.equal(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), null);
  assert.equal(sniffImageFormat(new Uint8Array(0)), null);
});

test("a PNG cut off mid-IHDR reports no dimensions", () => {
  // The signature passes and the dimension check is what catches it.
  const stub = pngBytes(800, 600).slice(0, 18);
  assert.equal(sniffImageFormat(stub), "image/png");
  assert.equal(readImageDimensions(stub), null);
});

test("a JPEG with no start-of-frame reports no dimensions", () => {
  const headerOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);
  assert.equal(sniffImageFormat(headerOnly), "image/jpeg");
  assert.equal(readImageDimensions(headerOnly), null);
});

test("a zero-dimension header reads as unreadable rather than as 0x0", () => {
  // 0x0 is not an image; passing it on makes an <img> reserve no space at all.
  assert.equal(readImageDimensions(pngBytes(0, 0)), null);
  assert.equal(readImageDimensions(gifBytes(0, 0)), null);
});

test("an image past Cloudflare's 12,000px ceiling is parsed truthfully", () => {
  // Refusing an oversize image is a policy decision made by the caller, not a
  // parsing failure - so the parser must not quietly report it as unreadable.
  assert.deepEqual(readImageDimensions(pngBytes(13000, 400)), { width: 13000, height: 400 });
});

/* ---- the extension comes from the bytes, never the filename ---- */

test("the canonical extension follows the sniffed format", () => {
  for (const format of ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"] as const) {
    assert.ok(EXTENSION_FOR_FORMAT[format], `${format} needs an extension`);
  }
  assert.equal(EXTENSION_FOR_FORMAT["image/jpeg"], "jpg");
  assert.equal(EXTENSION_FOR_FORMAT["image/gif"], "gif");
});