import type { Db } from "../db";
import type { Env } from "../env";
import { productsRepo } from "../data/productsRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { publishesRepo } from "../data/publishesRepo";
import { IN_FLIGHT, siteBuildsRepo } from "../data/siteBuildsRepo";
import { contentHashOf, newPublishRef } from "./publishRef";
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
/** A build that has reported nothing for this long is treated as dead, not as "still running". */
export const STALL_MS = 20 * 60 * 1000;

export function newBuildId(): string {
  const rand = new Uint8Array(4);
  crypto.getRandomValues(rand);
  return `build_${Date.now()}_${Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

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
   * Publishes a product, then asks GitHub to rebuild the storefront.
   *
   * The order is the design:
   *   1. assemble the snapshot
   *   2. IDENTICAL to the newest publish? Reuse it. A publish is a new row only when the content
   *      changed, so clicking Publish twice, or retrying after a failure, never mints a second id.
   *   3. otherwise write it with a fresh random publish ref - that is what "published" means
   *   4. only then queue a build and dispatch, and record exactly what happened
   *
   * A dispatch failure never rolls back or deletes the snapshot: GitHub being unreachable says
   * nothing about what was published. The caller gets the snapshot AND the failure, with the exact
   * reason, and retries against the SAME publish ref.
   */
  async publish(db: Db, env: Env, slug: string, publishedBy: string) {
    const payload = await publishService.assemble(db, env, slug);
    const contentHash = await contentHashOf(payload);

    const latest = await publishesRepo.latestForProduct(db, payload.product.id);
    const reused = latest !== null && latest.contentHash === contentHash;
    const record = reused
      ? latest
      : await publishesRepo.record(db, {
        productId: payload.product.id,
        payload,
        publishedBy,
        publishRef: newPublishRef(),
        contentHash,
        // "pending" not "triggered": at insert time nothing has been dispatched yet.
        buildStatus: "pending",
      });

    const run = await publishService.startBuild(db, env, record, publishedBy, { reuseRunning: reused });

    console.log(JSON.stringify({
      event: "product_published",
      slug,
      publishId: record.id,
      publishRef: record.publishRef,
      by: publishedBy,
      reused,
      outcome: run.outcome,
      buildId: run.buildId,
      deployment: run.deployment.status,
      deploymentMs: run.deployment.durationMs,
      httpStatus: run.deployment.httpStatus,
      error: run.deployment.error,
    }));

    return { record, reused, ...run };
  },

  /**
   * Queues ONE build for a publish and dispatches it.
   *
   * The build row exists BEFORE the dispatch, with its id sent to GitHub, so the run reports its
   * steps against a row that is already there, and a dispatch that fails leaves a visible, failed
   * build rather than nothing. `reuseRunning` makes a repeat publish a no-op while a build for the
   * same publish is already in flight (or has already been verified).
   */
  async startBuild(
    db: Db, env: Env,
    record: { id: number; productId: number; publishRef: string },
    by: string,
    options: { reuseRunning: boolean },
  ) {
    if (options.reuseRunning) {
      const existing = await siteBuildsRepo.latestForPublish(db, record.id, record.publishRef);
      if (existing && existing.status === "verified") {
        return {
          outcome: "unchanged" as const, buildId: existing.buildId,
          deployment: { status: "triggered" as const, error: null, httpStatus: null, durationMs: 0, retryable: true },
        };
      }
      const fresh = existing
        && (IN_FLIGHT as readonly string[]).includes(existing.status)
        && Date.now() - new Date(existing.lastEventAt).getTime() < STALL_MS;
      if (existing && fresh) {
        return {
          outcome: "already-running" as const, buildId: existing.buildId,
          deployment: { status: "triggered" as const, error: null, httpStatus: null, durationMs: 0, retryable: true },
        };
      }
    }

    const buildId = newBuildId();
    await siteBuildsRepo.record(db, {
      buildId, intendedPublications: [], triggeredBy: by, triggerPublishId: record.id, status: "queued",
    });
    await siteBuildsRepo.addEvent(db, { buildId, step: "dispatch", label: "Asking GitHub to start the build", status: "running" });

    const deployment = await triggerGitHubDispatch(env, {
      publishId: record.id, publishRef: record.publishRef, productId: record.productId, buildId,
    });
    await publishesRepo.recordDeployAttempt(db, record.id, {
      status: deployment.status, error: deployment.error, httpStatus: deployment.httpStatus,
    });

    if (deployment.status === "triggered") {
      await siteBuildsRepo.addEvent(db, {
        buildId, step: "dispatch", label: "Asking GitHub to start the build", status: "ok",
        message: "GitHub accepted the request. Waiting for the workflow run to start.",
      });
    } else {
      await siteBuildsRepo.addEvent(db, {
        buildId, step: "dispatch", label: "Asking GitHub to start the build", status: "failed", message: deployment.error,
      });
      await siteBuildsRepo.markFailed(db, buildId, deployment.error, "dispatch");
    }
    return { outcome: "dispatched" as const, buildId, deployment };
  },

  /**
   * Retries the rebuild for an EXISTING snapshot: a new build, the SAME publish ref.
   * Publishes nothing and assembles nothing, so it cannot change what customers receive.
   */
  async redeploy(db: Db, env: Env, productId: number, by = "admin") {
    const latest = await publishesRepo.latestForProduct(db, productId);
    if (!latest) return null;
    const run = await publishService.startBuild(db, env, latest, by, { reuseRunning: false });
    console.log(JSON.stringify({
      event: "product_redeploy",
      publishId: latest.id,
      publishRef: latest.publishRef,
      buildId: run.buildId,
      deployment: run.deployment.status,
      httpStatus: run.deployment.httpStatus,
      error: run.deployment.error,
    }));
    return { publishId: latest.id, publishRef: latest.publishRef, ...run };
  },
};

