// Telling what an upload ACTUALLY is, from its bytes.
//
// The problem this replaces: `prepareUpload` used to trust `file.type` and the
// filename. Both are supplied by the client. An attacker posting `Content-Type:
// image/png` with an HTML body gets an object stored under an image key on the
// delivery domain, and if that domain ever serves the object with a sniffed or
// reflected content type, it is stored XSS on the same origin as the storefront.
// The filename check made that harder but never closed it, because a file named
// `.png` can contain anything.
//
// So: sniff the signature. Every one of these formats announces itself in its first
// bytes, and the announcement cannot be changed without changing the file.
//
// This module DECODES NOTHING. It reads a bounded prefix (the first few KB is
// enough for every header below) and returns numbers. Workers on the free plan get
// ~10ms of CPU per request; a pixel-decoding pipeline does not fit there, which is
// why the resize stays in the admin's browser.

export type ImageFormat = "image/jpeg" | "image/png" | "image/webp" | "image/avif" | "image/gif";

/** Canonical extension per format. Derived from the bytes, never from the name. */
export const EXTENSION_FOR_FORMAT: Record<ImageFormat, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  signature.every((byte, i) => bytes[offset + i] === byte);

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.slice(offset, offset + length));

/** True when the file begins with this format's signature. */
function isJpeg(b: Uint8Array) {
  return startsWith(b, [0xff, 0xd8, 0xff]);
}

function isPng(b: Uint8Array) {
  return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function isWebp(b: Uint8Array) {
  // RIFF .... WEBP: a 4-byte size sits between the two magic words, which is why
  // this cannot be a single contiguous comparison.
  return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && ascii(b, 8, 4) === "WEBP";
}

function isGif(b: Uint8Array) {
  // Both revisions are accepted: GIF87a is the original, GIF89a added extensions.
  const header = ascii(b, 0, 6);
  return header === "GIF87a" || header === "GIF89a";
}

function isAvif(b: Uint8Array) {
  // ISO base media file format: bytes 4..8 are "ftyp", and the major or one of the
  // compatible brands is an AVIF brand. `avis` is the image-sequence variant (which
  // is what an animated AVIF is), so both count.
  if (ascii(b, 4, 4) !== "ftyp") return false;
  const brands = new Set<string>();
  brands.add(ascii(b, 8, 4));
  const boxSize = readUint32(b, 0, true);
  for (let offset = 16; offset + 4 <= Math.min(boxSize, b.length); offset += 4) {
    brands.add(ascii(b, offset, 4));
  }
  return brands.has("avif") || brands.has("avis");
}

/**
 * The format these bytes actually are, or null.
 *
 * Null means "not one of ours" - which covers SVG, executables, MP4, PDF and a
 * truncated file whose header never arrived. The caller refuses all of them alike,
 * because the only safe response to an unrecognised upload is to decline it.
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | null {
  // Three bytes is the shortest signature here (JPEG's FF D8 FF), so anything under
  // four cannot be one of ours. A higher floor would reject short-but-valid files
  // for no gain: each reader already bounds-checks its own offsets.
  if (bytes.length < 4) return null;
  if (isPng(bytes)) return "image/png";
  if (isJpeg(bytes)) return "image/jpeg";
  if (isWebp(bytes)) return "image/webp";
  if (isGif(bytes)) return "image/gif";
  if (isAvif(bytes)) return "image/avif";
  return null;
}

function readUint32(b: Uint8Array, offset: number, littleEndian: boolean): number {
  if (offset + 4 > b.length) return 0;
  // Big-endian puts the MOST significant byte FIRST, little-endian last. PNG and
  // every ISO-BMFF box are big-endian; WebP, GIF and VP8L are little-endian.
  //
  // Getting this pair backwards is silent rather than loud: it yields a plausible
  // large number (800px becoming 537,067,520) instead of an error, so a broken
  // version can survive a long time before anything notices. The bytes are named
  // by the weight they actually carry rather than by an index.
  const [msb, next, third, lsb] = littleEndian
    ? [b[offset + 3], b[offset + 2], b[offset + 1], b[offset]]
    : [b[offset], b[offset + 1], b[offset + 2], b[offset + 3]];
  return ((msb << 24) | (next << 16) | (third << 8) | lsb) >>> 0;
}

/**
 * A 16-bit read. `littleEndian` defaults to false because the two formats that use
 * this for dimensions - JPEG's SOF and WebP's VP8 - disagree: JPEG is big-endian,
 * VP8 is little-endian. Getting it wrong is silent (640 arrives as 16384), so it is
 * a parameter rather than a fixed convention.
 */
function readUint16(b: Uint8Array, offset: number, littleEndian = false): number {
  if (offset + 2 > b.length) return 0;
  return littleEndian
    ? b[offset] | (b[offset + 1] << 8)
    : (b[offset] << 8) | b[offset + 1];
}

function readUint24(b: Uint8Array, offset: number): number {
  if (offset + 3 > b.length) return 0;
  return (b[offset] << 16) | (b[offset + 1] << 8) | b[offset + 2];
}

export type Dimensions = { width: number; height: number };

/**
 * A header can parse cleanly and still say 0x0, which is what a truncated or
 * deliberately malformed file produces. A zero dimension is not a real image, so it
 * is treated as "cannot say" rather than passed on to a layout that would then
 * reserve no space at all.
 */
function valid(dimensions: Dimensions): Dimensions | null {
  return dimensions.width > 0 && dimensions.height > 0 ? dimensions : null;
}

/**
 * Pixel dimensions from the header, or null when the header cannot say.
 *
 * These feed the `width`/`height` attributes on every <img>. That matters for more
 * than tidiness: without them the browser cannot reserve space, the page shifts when
 * the image arrives, and CLS climbs - which is the metric that decides whether a
 * customer sees a stable product page or a jumping one on a slow connection.
 *
 * Returning null rather than a guess is deliberate. A wrong dimension is worse than
 * a missing one: it reserves the wrong space and shifts anyway, while null lets the
 * caller fall back to the CSS aspect-ratio the layout already declares.
 */

/** PNG: width and height are the first two fields of IHDR, big-endian. */
function pngDimensions(b: Uint8Array): Dimensions | null {
  if (b.length < 24) return null;
  // Offset 8 is the chunk length, 12 the "IHDR" tag, 16 the width.
  if (ascii(b, 12, 4) !== "IHDR") return null;
  return valid({ width: readUint32(b, 16, false), height: readUint32(b, 20, false) });
}

/** GIF: the logical screen descriptor sits right after the 6-byte header. */
function gifDimensions(b: Uint8Array): Dimensions | null {
  if (b.length < 10) return null;
  return valid({ width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) });
}

/**
 * JPEG: there is no fixed offset, so the marker segments are walked.
 *
 * Each segment is FF Cx then a 2-byte length. Start-of-frame markers carry the
 * dimensions. Three markers look like SOFn and are explicitly skipped: DHT (C4),
 * JPG (C8) and DAC (CC) - misreading one reserves nonsense space.
 */
function jpegDimensions(b: Uint8Array): Dimensions | null {
  let offset = 2;
  while (offset + 4 <= b.length) {
    if (b[offset] !== 0xff) { offset++; continue; }
    const marker = b[offset + 1];
    // A run of 0xFF padding bytes is legal before a marker.
    if (marker === 0xff) { offset++; continue; }
    const isFrame = (marker >= 0xc0 && marker <= 0xcf)
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // FF Cx | length(2) | precision(1) | height(2) | width(2)
      return valid({ width: readUint16(b, offset + 7), height: readUint16(b, offset + 5) });
    }
    // Standalone markers carry no length: SOI, EOI, TEM and the RSTn run.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    const length = readUint16(b, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** WebP: three chunk layouts, distinguished by the four-character chunk tag. */
function webpDimensions(b: Uint8Array): Dimensions | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);

  if (chunk === "VP8 ") {
    // Lossy: a 3-byte frame tag then a 3-byte sync code (9D 01 2A), after which the
    // width and height are 14 bits each, little-endian.
    const width = readUint16(b, 26, true) & 0x3fff;
    const height = readUint16(b, 28, true) & 0x3fff;
    return valid({ width, height });
  }

  if (chunk === "VP8L") {
    // Lossless: a 0x2F signature byte, then 14 bits of width-1 and 14 of height-1.
    if (b[20] !== 0x2f) return null;
    const bits = readUint32(b, 21, true);
    return valid({ width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 });
  }

  if (chunk === "VP8X") {
    // Extended: 4 flag bytes, then two 24-bit little-endian canvas dimensions.
    return valid({
      width: readUint24(b, 24) + 1,
      height: readUint24(b, 27) + 1,
    });
  }

  return null;
}

/**
 * AVIF: dimensions live in an `ispe` box, reached by walking the box tree rather
 * than at a fixed offset, because `meta` > `iprp` > `ipco` are each variable length.
 *
 * `meta` is a FullBox: 4 bytes of version/flags before its children, which is why
 * that one offset skips 4 extra bytes and the others do not.
 */
function avifDimensions(b: Uint8Array): Dimensions | null {
  const walk = (start: number, end: number, depth: number): Dimensions | null => {
    // The depth bound is a guard against a hand-crafted file nesting boxes deeply
    // enough to turn this linear walk into a stack overflow.
    if (depth > 6) return null;
    let offset = start;
    while (offset + 8 <= end) {
      const size = readUint32(b, offset, false);
      const type = ascii(b, offset + 4, 4);
      if (size < 8 || offset + size > end) return null;

      if (type === "ispe") {
        // version/flags(4) | width(4) | height(4)
        return valid({
          width: readUint32(b, offset + 8, false),
          height: readUint32(b, offset + 12, false),
        });
      }
      if (type === "meta") {
        const found = walk(offset + 12, offset + size, depth + 1);
        if (found) return found;
      }
      if (type === "iprp" || type === "ipco") {
        const found = walk(offset + 8, offset + size, depth + 1);
        if (found) return found;
      }
      offset += size;
    }
    return null;
  };

  // The top level is the FILE, not the first box. ISO-BMFF is a flat sequence of
  // boxes, so the first box's declared size is that box's length and nothing more;
  // treating it as the extent of the walk makes the loop stop one box in and never
  // reach meta > iprp > ipco > ispe at all.
  return walk(0, b.length, 0);
}

const READERS: Record<ImageFormat, (b: Uint8Array) => Dimensions | null> = {
  "image/png": pngDimensions,
  "image/jpeg": jpegDimensions,
  "image/webp": webpDimensions,
  "image/gif": gifDimensions,
  "image/avif": avifDimensions,
};

export function readImageDimensions(bytes: Uint8Array): Dimensions | null {
  const format = sniffImageFormat(bytes);
  return format ? READERS[format](bytes) : null;
}