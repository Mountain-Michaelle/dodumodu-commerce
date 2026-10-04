import type { Db } from "../db";
import type { Env } from "../env";
import { mediaRepo, type MediaRow } from "../data/mediaRepo";
import { r2Client } from "../external/r2Client";
import { ConflictError, NotFoundError, ValidationError } from "../shared/httpError";
import { sniffImageFormat, readImageDimensions, EXTENSION_FOR_FORMAT } from "./imageSignature";
import { imageConfigFrom, type ImageConfig } from "../config/imageConfig";

// The media rules: what an upload may be, and when a stored object may go.
//
// The upload is validated from its BYTES (see imageSignature), the resize happens in
// the admin's browser before the bytes are sent, and the object lands in R2 under an
// immutable key. Nothing here decodes pixels: Workers get ~10ms of CPU on the free
// plan, so any pixel work would have to happen before the request is made, not
// inside it.

// The media rules: what an upload may be, and when a stored object may go.
//
// The V1 image path is client-side resize/compression then a straight PUT to R2 -
// no image pipeline, no Cloudflare Images dependency. That is a deliberate
// choice, not a missing feature: the panel compresses before upload so the object
// that lands is already a sensible size, and the delivery URL in front of R2 is
// where any future transformation belongs. Nothing in this file needs to change
// if that is added later, because nothing here knows how a byte is served.

// The accepted formats are no longer listed here. They are derived from the bytes
// by imageSignature, and an allowlist of Content-Types was exactly the thing that
// could be lied to: `file.type` is whatever the client said it was.
//
// The upload ceiling also moved to imageConfig (MAX_UPLOAD_BYTES), so the 10MB
// default can be tuned in one place without touching this file.

/**
 * Reduces a client-supplied filename to something safe to become part of a
 * storage key. `file.name` is attacker-controlled: it becomes part of a key that
 * is later normalised into a delivery URL, and locally the same key reaches a
 * real filesystem. No path separators, no "..", no leading dots, bounded length.
 */
export function safeStorageName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80) || "upload";
}

/**
 * How many bytes of an upload are read to identify it and measure it.
 *
 * Bounded on purpose. Every signature this project accepts announces itself within
 * the first few dozen bytes, and every dimension lives in a header near the front:
 * PNG's IHDR at 16, JPEG's first SOF (a few hundred bytes in at worst), WebP's
 * chunk header at 12, GIF's screen descriptor at 6, AVIF's ispe inside a handful of
 * small boxes. Reading the whole file would mean buffering a 10MB upload in memory
 * to learn what it is.
 */
const HEADER_BYTES = 64 * 1024;

/** How many bytes are actually uploaded. */
async function headerOf(file: File): Promise<Uint8Array> {
  const slice = file.slice(0, Math.min(file.size, HEADER_BYTES));
  return new Uint8Array(await slice.arrayBuffer());
}

export const mediaService = {
  /**
   * Validates an upload from its BYTES and returns the key it will be stored under.
   *
   * What changed, and why it matters: this used to trust `file.type` and the
   * filename. Both are supplied by the client, so a request carrying a body of HTML
   * with `Content-Type: image/png` and a name of `x.png` passed every check and was
   * stored under an image key on the delivery domain. If that domain ever serves
   * such an object with its own content type, it is stored XSS on the storefront's
   * own origin. The filename check narrowed the attack without closing it, because a
   * file named .png can contain anything at all.
   *
   * So the bytes decide: the format comes from a magic-byte sniff, the extension
   * comes from that format, and the declared type is only checked for agreement -
   * never trusted on its own.
   *
   * The key is `<prefix>/<time>-<uuid>-<safe name>`: the timestamp and uuid mean two
   * uploads of a file called photo.jpg are two objects rather than one silently
   * overwriting the other. That immutability is what makes a one-year immutable
   * Cache-Control on the delivered image safe.
   */
  async prepareUpload(file: File, config: ImageConfig = imageConfigFrom()) {
    if (file.size <= 0) throw new ValidationError("That file is empty", { file: ["Empty file"] });

    if (file.size > config.maxUploadBytes) {
      const mb = (config.maxUploadBytes / 1024 / 1024).toFixed(0);
      throw new ValidationError(
        `That image is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${mb}MB - resize it before uploading.`,
        { file: ["Too large"] },
      );
    }

    const header = await headerOf(file);
    const format = sniffImageFormat(header);
    if (!format) {
      throw new ValidationError(
        "Only JPEG, PNG, WebP, AVIF and GIF images can be uploaded",
        { file: ["Unsupported image type"] },
      );
    }

    // The declared type must AGREE with the bytes. It is not trusted to decide, but
    // a disagreement means one of the two is wrong and the operator should be told
    // which file to look at again rather than silently served the wrong thing.
    if (file.type && file.type !== format) {
      throw new ValidationError("That file's contents do not match its declared type", {
        file: [`Contents look like ${format}, not ${file.type}`],
      });
    }

    const dimensions = readImageDimensions(header);
    if (!dimensions) {
      throw new ValidationError("That image is incomplete or corrupt - its header could not be read", {
        file: ["Unreadable image header"],
      });
    }

    // Cloudflare cannot transform past 12,000px per side, so an image that large
    // would fail at DELIVERY time - long after the operator was told the upload
    // worked. Refusing it here names the actual problem.
    if (dimensions.width > config.maxDimension || dimensions.height > config.maxDimension) {
      throw new ValidationError(
        `That image is ${dimensions.width}×${dimensions.height}. The limit is `
        + `${config.maxDimension}px per side - resize it before uploading.`,
        { file: ["Image too large"] },
      );
    }

    // The extension comes from the BYTES, so a mislabelled upload can no longer
    // produce a key whose extension contradicts its content.
    const extension = EXTENSION_FOR_FORMAT[format];
    const base = file.name.toLowerCase().replace(/\.[^.]*$/, "") || "upload";
    return {
      key: `${config.keyPrefix}/${Date.now()}-${crypto.randomUUID()}-${safeStorageName(base)}.${extension}`,
      format,
      extension,
      dimensions,
    };
  },

  /**
   * Stores an upload and records it, so the key becomes something the admin can
   * find later.
   *
   * The registry row is what makes an orphaned object discoverable: without it,
   * an image uploaded and then never attached cannot be found by any query at
   * all, and "what is this image used for" cannot be answered without asking
   * every table what it happens to point at. The row records what the uploader
   * said they were uploading for, which is a useful filter but not the truth -
   * the truth is always read live (see mediaRepo.referencesForProduct).
   */
  async registerUpload(
    env: Env,
    db: Db,
    file: File,
    options: {
      productId: number | null;
      uploadedBy: string;
      /** Optional caller hint. The header is authoritative and wins over this. */
      width?: number | null;
      height?: number | null;
    },
    config?: ImageConfig,
  ): Promise<{ row: MediaRow; created: boolean }> {
    const { key, format, dimensions } = await mediaService.prepareUpload(file, config);
    await r2Client.putObject(env, key, await file.arrayBuffer(), format);
    return mediaRepo.register(db, {
      r2Key: key,
      // The SNIFFED type, not the declared one. Everything downstream - the object
      // metadata, the content type the delivery domain serves - follows from what
      // the bytes are, so a lying client cannot influence it.
      contentType: format,
      byteSize: file.size,
      // Measured from the header rather than trusted from the client, so every
      // <img> in the storefront can reserve the right space and CLS stays near zero.
      width: dimensions.width,
      height: dimensions.height,
      productId: options.productId,
      uploadedBy: options.uploadedBy,
    });
  },

  /**
   * Deletes a stored image, refusing while anything still points at it.
   *
   * Deleting an object a live product page still references produces a broken
   * image on a page customers are looking at, and the reference lives in several
   * tables - so the question is asked of all of them, live, rather than of a flag
   * some other code path was supposed to keep in step. The names come back with
   * the refusal so the panel can say what is using it.
   */
  async remove(db: Db, env: Env, id: number, actor: string) {
    const row = await mediaRepo.findById(db, id);
    if (!row) throw new NotFoundError("Media", id);

    // ONE query answers both halves of the question. `inUse` and the list of places
    // came from two different queries before, which is exactly how the library
    // could report an image as in use while this refusal found nothing to name.
    const references = await mediaRepo.referencesForKey(db, row.r2Key);
    if (references.length > 0) {
      const places = Array.from(new Set(references.map((r) => r.source)));
      throw new ConflictError(
        `This image is still used in ${references.length} place${references.length === 1 ? "" : "s"} `
        + `(${places.join(", ")}). Detach it first.`,
        "reload",
        { references },
      );
    }

    // Row first, then the object. The reverse order leaves an object nothing can
    // ever find again - invisible in the library, still costing storage.
    await mediaRepo.deleteById(db, id);
    await r2Client.deleteObject(env, row.r2Key);
    console.log(JSON.stringify({ event: "media_deleted", id, r2Key: row.r2Key, by: actor }));
    return { deleted: true };
  },
};
