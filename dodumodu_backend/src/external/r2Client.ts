import type { Env } from "../env";

export const r2Client = {
  /**
   * Objects are written ONCE under a key containing a uuid, and never overwritten.
   * That is what makes a one-year immutable Cache-Control honest: the bytes behind a
   * given URL can never change, so a browser (or a shared cache) that keeps it for a
   * year cannot ever be wrong.
   *
   * Without this header R2 sends its own defaults, and the default is to let
   * caches revalidate - which means every product page view re-asks for the hero,
   * exactly the round trip this project is trying to remove for a customer on a
   * weak Nigerian connection.
   */
  async putObject(env: Env, key: string, body: ReadableStream | ArrayBuffer, contentType: string) {
    await env.MEDIA_BUCKET.put(key, body, {
      httpMetadata: {
        contentType,
        // `immutable` is the load-bearing word: it tells caches not to revalidate
        // even on reload, which is safe only because the key is unique per upload.
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
    return key;
  },

  async deleteObject(env: Env, key: string) {
    await env.MEDIA_BUCKET.delete(key);
  },

  // Actual delivery to the browser goes through Cloudflare Image Transformations
  // in front of the public R2/custom domain — the Worker only manages the objects.
  publicUrlFor(key: string, imageDeliveryBase: string) {
    return `${imageDeliveryBase}/${key}`;
  },
};
