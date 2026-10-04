import { Hono } from "hono";
import type { Env } from "../../env";
import { z } from "zod";
import { createDb } from "../../db";
import { mediaRepo, MEDIA_SORT_FIELDS } from "../../data/mediaRepo";
import { mediaService } from "../../services/mediaService";
import { parseListQuery, pageMeta, normalizeSearch, likePattern } from "../../shared/listQuery";
import { PERMISSIONS } from "../../auth/adminAuth";
import { requirePermissionOf, actorOf } from "./helpers";
import type { Principal } from "../../auth/adminAuth";

// The media library: what has been uploaded, and what is still using it.
//
// The upload path is client-side resize/compression then a straight PUT. That is a
// deliberate V1 choice (no image pipeline dependency), and it is why the bytes
// that land are already a sensible size. The delivery URL in front of R2 is where
// any future transformation belongs; nothing here needs to change for that.

export const mediaListFiltersSchema = z.object({
  filter: z.enum(["all", "unattached", "unused"]).default("all"),
  productId: z.coerce.number().int().positive().optional(),
});

export function mediaRoutes() {
  const route = new Hono<{ Bindings: Env; Variables: { principal: Principal } }>();

  route.get("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.mediaRead);
    const query = parseListQuery(c.req.query(), {
      filters: mediaListFiltersSchema,
      sortable: MEDIA_SORT_FIELDS,
      defaultSort: "createdAt",
      defaultOrder: "desc",
    });
    if (!query) return c.json({ error: { code: "INVALID_QUERY", message: "Unsupported filter" } }, 400);

    const db = createDb(c.env.DATABASE_URL);
    const search = normalizeSearch(query.search);
    const { rows, total } = await mediaRepo.list(db, {
      search: search ? likePattern(search) : null,
      filter: query.filters.filter ?? "all",
      productId: query.filters.productId ?? null,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });

    // The reference inventory is ONE query for the whole page, not one per row -
    // which is the difference between opening the library and it being slow. It is
    // also the same query the delete guard reads, so this column and that refusal
    // cannot tell an operator different stories about the same image.
    const byKey = await mediaRepo.referencesByKey(db);
    return c.json({
      media: rows.map((row) => {
        const references = byKey.get(row.r2Key) ?? [];
        return {
          ...row,
          inUse: references.length > 0,
          // WHO uses it, not just that something does. An operator deciding
          // whether an image is safe to delete needs to know which product or
          // category holds it, and that is the same fact the refusal reports.
          usedBy: references.map((ref) => ({
            source: ref.source,
            ownerId: ref.ownerId,
            ownerKind: ref.ownerKind,
          })),
        };
      }),
      page: pageMeta(query, total),
    });
  });

  route.post("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.mediaWrite);
    const db = createDb(c.env.DATABASE_URL);
    // multipart, not JSON: the bytes have to travel with the metadata rather than
    // as a base64 string inside a body that the platform will size-limit first.
    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return c.json({ error: { code: "VALIDATION_ERROR", message: "Send a multipart upload" } }, 400);
    }
    // `File` is a runtime global on Workers and in Node 20+, but referencing it as
    // a type alone is not enough to prove the value came from the upload rather
    // than being a string field the form happened to name "file". The check below
    // therefore tests for the shape that only a real File has.
    const file = form.get("file");
    if (!file || typeof file === "string" || typeof (file as File).arrayBuffer !== "function") {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "No file was uploaded", fields: { file: ["Choose an image"] } },
      }, 400);
    }
    const productIdRaw = form.get("productId");
    const productId = typeof productIdRaw === "string" && productIdRaw !== ""
      ? Number(productIdRaw)
      : null;

    const { row, created } = await mediaService.registerUpload(c.env, db, file, {
      productId: Number.isInteger(productId) ? productId : null,
      uploadedBy: actorOf(c),
    });
    console.log(JSON.stringify({ event: "media_uploaded", r2Key: row.r2Key, by: actorOf(c) }));
    return c.json({ media: row, created }, created ? 201 : 200);
  });

  route.delete("/:id", async (c) => {
    requirePermissionOf(c, PERMISSIONS.mediaWrite);
    // Refused while anything still points at the key; the service says what, so
    // the panel can show the operator why rather than just "cannot delete".
    const result = await mediaService.remove(
      createDb(c.env.DATABASE_URL), c.env, Number(c.req.param("id")), actorOf(c),
    );
    return c.json(result);
  });

  /**
   * `DELETE /media?key=...` - the form the specification names, and the one a
   * client holding only a key has. The service resolves a key to its row first, so
   * both spellings obey exactly the same reference check and produce exactly the
   * same refusal.
   */
  route.delete("/", async (c) => {
    requirePermissionOf(c, PERMISSIONS.mediaWrite);
    const key = c.req.query("key")?.trim();
    if (!key) {
      return c.json({
        error: { code: "VALIDATION_ERROR", message: "Say which image: pass ?key=… or use /media/:id" },
      }, 400);
    }

    const db = createDb(c.env.DATABASE_URL);
    const row = await mediaRepo.findByKey(db, key);
    if (!row) return c.json({ error: { code: "NOT_FOUND", message: "No such image" } }, 404);

    return c.json(await mediaService.remove(db, c.env, row.id, actorOf(c)));
  });

  return route;
}
