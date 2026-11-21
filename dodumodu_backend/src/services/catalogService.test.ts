import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogService } from "./catalogService";
import { productsRepo } from "../data/productsRepo";
import { testimonialsRepo } from "../data/testimonialsRepo";
import { productPagesRepo } from "../data/productPagesRepo";
import { discountTiersRepo } from "../data/discountTiersRepo";
import { paymentRulesRepo } from "../data/paymentRulesRepo";
import type { Db } from "../db";
import type { Env } from "../env";

const env = (over: Record<string, string> = {}) => ({
  MAX_ORDER_QUANTITY: "20",
  ...over,
}) as unknown as Env;

const product = { id: 1, slug: "glow-serum", name: "Radiance Glow Serum", description: "A bright serum.", price: 1500000, packageOptions: [], seoTitle: null, seoDescription: null };

const stubRepos = (page: Record<string, unknown> | null) => {
  const saved = {
    findBySlug: productsRepo.findBySlug,
    imagesForProduct: productsRepo.imagesForProduct,
    listActiveForProduct: testimonialsRepo.listActiveForProduct,
    forProduct: productPagesRepo.forProduct,
    findActive: discountTiersRepo.findActive,
    get: paymentRulesRepo.get,
  };
  productsRepo.findBySlug = async () => product as never;
  productsRepo.imagesForProduct = async () => [] as never;
  testimonialsRepo.listActiveForProduct = async () => [] as never;
  productPagesRepo.forProduct = async () => page as never;
  discountTiersRepo.findActive = async () => [] as never;
  paymentRulesRepo.get = async () => ({ codStates: [], codBulkThreshold: 0 }) as never;
  return saved;
};

const restore = (saved: ReturnType<typeof stubRepos>) => {
  productsRepo.findBySlug = saved.findBySlug;
  productsRepo.imagesForProduct = saved.imagesForProduct;
  testimonialsRepo.listActiveForProduct = saved.listActiveForProduct;
  productPagesRepo.forProduct = saved.forProduct;
  discountTiersRepo.findActive = saved.findActive;
  paymentRulesRepo.get = saved.get;
};

test("catalogService page snapshot includes sectionTitles", async () => {
  const saved = stubRepos({
    summaryHtml: "",
    benefits: [],
    howToUse: [],
    faq: [],
    sectionTitles: {
      benefits: "Custom benefits",
      testimonials: "Custom testimonials",
      whatsapp: "Custom whatsapp",
      howToUse: "Custom howToUse",
      faq: "Custom faq",
      middleCta: "Custom middleCta",
      order: "Custom order",
      finalCta: "Custom finalCta",
    },
    ratingValue: "4.9",
    ratingCount: "100",
    trustBadges: [],
    deliveryBadge: "",
    ctaText: "Order now",
    heroAlt: "",
  });
  try {
    const data = await catalogService.getPageData({} as Db, env(), "glow-serum");
    const st = (data.page as Record<string, unknown> | null)?.sectionTitles as Record<string, string> | undefined;
    assert.ok(st, "page has sectionTitles");
    assert.equal(st.benefits, "Custom benefits");
    assert.equal(st.testimonials, "Custom testimonials");
    assert.equal(st.whatsapp, "Custom whatsapp");
    assert.equal(st.howToUse, "Custom howToUse");
    assert.equal(st.faq, "Custom faq");
    assert.equal(st.middleCta, "Custom middleCta");
    assert.equal(st.order, "Custom order");
    assert.equal(st.finalCta, "Custom finalCta");
  } finally {
    restore(saved);
  }
});

test("catalogService page is null when no product_pages row exists", async () => {
  const saved = stubRepos(null);
  try {
    const data = await catalogService.getPageData({} as Db, env(), "glow-serum");
    assert.equal(data.page, null);
  } finally {
    restore(saved);
  }
});