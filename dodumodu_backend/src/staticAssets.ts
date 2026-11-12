// Storefront static assets served directly by the Worker in production.
// Production has no Cloudflare Pages/static middleware, so the Worker must
// serve the customer JS bundle, robots.txt, sitemap.xml, and
// media. These are inlined here rather than read from disk at request time.

export function robotsTxt(siteUrl: string): string {
  const base = siteUrl ? siteUrl.replace(/\/+$/, "") : "";
  const lines = [
    "User-agent: *",
    "Allow: /products/",
    "Disallow: /admin/",
    "Disallow: /thank-you.html",
    "",
  ];
  if (base) lines.push(`Sitemap: ${base}/sitemap.xml`);
  return lines.join("\n") + "\n";
}

export function sitemapXml(siteUrl: string, products: Record<string, unknown>): string {
  const base = siteUrl ? siteUrl.replace(/\/+$/, "") : "";
  const urls = [
    `  <url><loc>${base === "" ? "/" : base + "/"}</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
  ];
  for (const slug of Object.keys(products)) {
    const loc = base === "" ? `/${slug}/` : `${base}/${slug}/`;
    urls.push(`  <url><loc>${loc}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>
`;
}
