import type { Db } from "../db";
import type { Env } from "../env";
import { productsRepo } from "../data/productsRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { publishesRepo } from "../data/publishesRepo";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo } from "../data/paymentRulesRepo";
import { deliveryService } from "./deliveryService";
import { codPolicyService } from "./codPolicyService";


export class ProductNotFoundError extends Error {}

export const catalogService = {
  /**
   * §5.2 — the single combined payload a product page needs. No admin-only
   * fields (internal image ids the frontend doesn't need, unpublished
   * products, inactive discount tiers). The frontend must never hardcode
   * discount percentages or the quantity ceiling — both come from here, so
   * an admin change is live without a frontend deploy.
   *
   * This is the LIVE view: it reads the rows as they are right now, drafts
   * included. The admin panel previews through it and a publish is assembled
   * from it. Customers never read it — they read a published snapshot — which
   * is exactly what makes saving here safe.
   */
  async getPageData(db: Db, env: Env, slug: string) {
    const product = await productsRepo.findBySlug(db, slug);
    if (!product) throw new ProductNotFoundError(slug);

    const images = await productsRepo.imagesForProduct(db, product.id);
    const testimonials = await testimonialsRepo.listActiveForProduct(db, product.id);
    const page = await productPagesRepo.forProduct(db, product.id);
    const discountTiers = await discountTiersRepo.findActive(db);
    // The exact COD gate this order would be held to, published to the page so
    // the form can present the choice honestly before a round trip.
    const paymentRules = await paymentRulesRepo.get(db);

    return {
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
      // Null until someone first saves the copy. The renderer falls back to the
      // column defaults rather than this inventing a row: the defaults are the
      // single place today's copy lives, and duplicating them here is how two
      // versions of one sentence start existing.
      page: page ? {
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
      } : null,
      images: images.map((img) => ({
        r2Key: img.r2Key, altText: img.altText,
        width: img.width, height: img.height, variants: img.variants,
      })),
      testimonials: testimonials.map((t) => ({
        r2Key: t.r2Key, title: t.title, description: t.description, kind: t.kind,
        width: t.width, height: t.height, variants: t.variants,
      })),
      deliveryOptions: deliveryService.getDeliveryOptions(),
      discountTiers: discountTiers.map((t) => ({
        minQuantity: t.minQuantity, discountPercent: t.discountPercent, label: t.label,
      })),
      maxOrderQuantity: parseInt(env.MAX_ORDER_QUANTITY, 10),
      // COD eligibility plus the free-delivery promise, both straight from the
      // server, so the form and the page copy can never drift from what this
      // order would actually be allowed / charged (§8.8's "must agree" rule).
      paymentRules: codPolicyService.publicRules(paymentRules),
      freeDeliveryStates: deliveryService.freeDeliveryStates(),
    };
  },

  /**
   * The newest published snapshot for a slug, or null when the product has never
   * been published. This is the only content read a customer is ever served:
   * immutable rows keyed by publish id, so a draft sitting in product_pages
   * cannot reach a browser and a build cannot straddle two admin saves.
   */
  async getPublished(db: Db, slug: string) {
    const product = await productsRepo.findBySlug(db, slug);
    if (!product) throw new ProductNotFoundError(slug);
    return publishesRepo.latestForProduct(db, product.id);
  },
};
