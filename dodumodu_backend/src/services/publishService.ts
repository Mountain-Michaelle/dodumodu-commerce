import type { Db } from "../db";
import type { Env } from "../env";
import { productsRepo } from "../data/productsRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { publishesRepo } from "../data/publishesRepo";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo } from "../data/paymentRulesRepo";
import { triggerGitHubDispatch } from "../external/githubDeployTrigger";
import { deliveryService } from "./deliveryService";
import { codPolicyService } from "./codPolicyService";
import { ProductNotFoundError } from "./catalogService";

// A publish captures one product page as a single JSON document: everything a
// static build needs to render that page, read once, at one moment.
//
// Why a snapshot instead of a live read during the build: the build is slow - it
// fetches, renders and uploads - and an admin can save while it runs. Reading
// live tables mid-build means the page customers receive could mix a headline
// from before the save with a price list from after it. A snapshot also keeps
// the last known good page: a publish that fails half way is a publish that
// never happened, so the previous one keeps serving.
export const publishService = {
  // Every read happens before any write, so the document is one consistent
  // capture rather than a view that can straddle two admin saves.
  async assemble(db: Db, env: Env, slug: string) {
    const product = await productsRepo.findBySlug(db, slug);
    if (!product) throw new ProductNotFoundError(slug);

    // A product whose copy was never edited still has to be publishable. The
    // row is created on the spot, which means it inherits the column defaults -
    // and those defaults are exactly the copy this site shipped with before any
    // of it lived in a database.
    let page = await productPagesRepo.forProduct(db, product.id);
    if (!page) page = await productPagesRepo.save(db, product.id, {});

    const [images, testimonials, discountTiers, paymentRules] = await Promise.all([
      productsRepo.imagesForProduct(db, product.id),
      testimonialsRepo.listActiveForProduct(db, product.id),
      discountTiersRepo.findActive(db),
      paymentRulesRepo.get(db),
    ]);

    // Everything the page needs, and nothing that only the admin or the order
    // path uses. Internal row ids are left out on purpose: a published document
    // is a public artefact, and an id that means nothing to a renderer is a
    // promise it will be tempted to couple to.
    return {
      slug: product.slug,
      publishedAt: new Date().toISOString(),
      product: {
        id: product.id,
        slug: product.slug,
        name: product.name,
        description: product.description,
        price: product.price,
        packageOptions: product.packageOptions,
        seoTitle: product.seoTitle,
        seoDescription: product.seoDescription,
      },
      page: {
        summaryHtml: page.summaryHtml,
        benefits: page.benefits,
        howToUse: page.howToUse,
        faq: page.faq,
        whyLoveTitle: page.whyLoveTitle,
        howToUseTitle: page.howToUseTitle,
        ratingValue: page.ratingValue,
        ratingCount: page.ratingCount,
        trustBadges: page.trustBadges,
        deliveryBadge: page.deliveryBadge,
        ctaText: page.ctaText,
        heroAlt: page.heroAlt,
      },
      // Renditions travel with the key: the build writes the srcset from these
      // bytes and never has to ask an image pipeline what happens to exist.
      images: images.map((img) => ({
        r2Key: img.r2Key, altText: img.altText,
        width: img.width, height: img.height, variants: img.variants,
      })),
      testimonials: testimonials.map((t) => ({
        r2Key: t.r2Key, title: t.title, description: t.description, kind: t.kind,
        width: t.width, height: t.height, variants: t.variants,
      })),

      // The checkout rules travel with the page for the same reason the copy
      // does: what the form offers and what the page promises must be the ones
      // that were true when the page was built. Public numbers only - nothing in
      // here can rewrite an order that already exists.
      deliveryOptions: deliveryService.getDeliveryOptions(),
      discountTiers: discountTiers.map((t) => ({
        minQuantity: t.minQuantity, discountPercent: t.discountPercent, label: t.label,
      })),
      maxOrderQuantity: parseInt(env.MAX_ORDER_QUANTITY, 10),
      paymentRules: codPolicyService.publicRules(paymentRules),
      freeDeliveryStates: deliveryService.freeDeliveryStates(),
    };
  },

  /**
   * Publishes a product, then tries to start a rebuild.
   *
   * The order here is the whole design, and it is deliberately not the order it
   * reads like:
   *
   *   1. assemble + write the snapshot
   *   2. THAT is the definition of published
   *   3. only then fire the deploy hook, and record whatever it did
   *
   * The hook is awaited rather than handed to waitUntil, on purpose. waitUntil would
   * let the response say "triggered" before the request had been sent, which is
   * precisely the claim that would then be a lie. One round trip on an admin action
   * is a fair price for an answer the panel can actually display.
   *
   * A hook failure does NOT roll back, delete or invalidate the snapshot. The
   * snapshot is durable and correct; Cloudflare being briefly unreachable says
   * nothing about what was published, and destroying a valid publish over a
   * transient network error would be the worst possible outcome. The caller gets
   * `published: true` alongside `deployment.status: "failed"` and offers a retry.
   */
  async publish(db: Db, env: Env, slug: string, publishedBy: string) {
    const payload = await publishService.assemble(db, env, slug);
    const record = await publishesRepo.record(db, {
      productId: payload.product.id,
      payload,
      publishedBy,
      // "pending" not "triggered": at insert time the hook has not been fired yet.
      // Recording "triggered" here would assert something that has not happened.
      buildStatus: "pending",
    });

    const deployment = await triggerGitHubDispatch(env, {
      publishId: record.id,
      productId: payload.product.id,
    });
    // Only write a status when there is something to say. A local publish with no
    // hook configured stays "pending" rather than being marked "failed" for the
    // absence of something that was never expected to be there.
    if (deployment.status !== "pending") {
      await publishesRepo.markBuildStatus(db, record.id, deployment.status);
    }

    console.log(JSON.stringify({
      event: "product_published",
      slug,
      publishId: record.id,
      by: publishedBy,
      deployment: deployment.status,
      deploymentMs: deployment.durationMs,
    }));

    return { record, deployment };
  },

  /**
   * Retries the rebuild for an EXISTING snapshot.
   *
   * Publishes nothing and assembles nothing: the content is already captured, so a
   * retry is free and cannot change what customers will receive. It re-sends the
   * hook and records the new outcome against the same row.
   */
  async redeploy(db: Db, env: Env, productId: number) {
    // Reuses the repository's own "newest snapshot for this product" query rather
    // than repeating the ordering here: two places deciding which publish is
    // current is exactly how a retry ends up rebuilding the wrong content.
    const latest = await publishesRepo.latestForProduct(db, productId);
    if (!latest) return null;

    const deployment = await triggerGitHubDispatch(env, {
      publishId: latest.id,
      productId: latest.productId,
    });
    await publishesRepo.markBuildStatus(db, latest.id, deployment.status);
    console.log(JSON.stringify({
      event: "product_redeploy",
      publishId: latest.id,
      deployment: deployment.status,
    }));
    return { publishId: latest.id, deployment };
  },
};

