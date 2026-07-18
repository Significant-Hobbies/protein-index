import { mkdtemp, readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { discoverOfficialBrandCatalog, robotsAllows, stagedOfficialBrandProduct, stagedOfficialBrandProducts, validateOfficialBrandConfig, validateOfficialBrandSource, type OfficialBrandDiscoveryConfig, type OfficialBrandSource } from "../scripts/adapters/official-brand-sitemap";
import { emitImportSql } from "../scripts/reconcile";

const source: OfficialBrandSource = { id: "acme_india", name: "Acme India", allowedHosts: ["brand.example"], sitemapUrls: ["https://brand.example/sitemap.xml"], maxProductPages: 10 };
const page = `<!doctype html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Acme Protein Puffs","brand":{"@type":"Brand","name":"Acme"},"gtin13":"8900000000012","category":"Protein snacks","image":"https://cdn.example/puffs.jpg","offers":{"@type":"Offer","price":"199","priceCurrency":"INR","availability":"https://schema.org/InStock"},"nutrition":{"@type":"NutritionInformation","calories":"100 kcal","proteinContent":"12 g"}}</script>`;
const microdataPage = `<!doctype html><div itemscope itemtype="https://schema.org/Product"><meta itemprop="brand" content="Acme"><meta itemprop="name" content="Acme Whey Protein"><img itemprop="image" src="https://cdn.example/whey.jpg"><img src="//cdn.example/whey-nutrition.jpg" alt="Nutrition facts panel"><img src="https://cdn.example/whey-ingredients.jpg" data-media-alt="Ingredients label"><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="999"><meta itemprop="priceCurrency" content="INR"><link itemprop="availability" href="https://schema.org/InStock"></div></div><div class="flavour-and-tag-container"><div>Chocolate • 1 kg</div></div>`;
const sectionLabelPage = `${page}<section data-id="nutrition"><img src="//cdn.example/puffs-nutrition.jpg" alt=""></section><section data-tab="ingredients"><img src="https://cdn.example/puffs-ingredients.jpg" alt=""></section>`;
const nonSemanticNutritionContainerPage = `${page}<div data-id="nutrition"><img src="https://cdn.example/site-logo.svg" alt=""></div>`;
const productGroupPage = `<!doctype html><script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"Acme Whey","brand":{"@type":"Brand","name":"Acme"},"category":"Protein supplements","hasVariant":[{"@type":"Product","name":"Acme Whey Chocolate 1 kg","sku":"choc-1kg","url":"/products/whey?variant=choc","offers":{"@type":"Offer","price":"1999","priceCurrency":"INR"}},{"@type":"Product","name":"Acme Whey Vanilla 15g Protein","sku":"vanilla-15g","url":"/products/whey?variant=vanilla","offers":{"@type":"Offer","price":"1999","priceCurrency":"INR"}}]}</script><img src="https://cdn.example/shared-nutrition.jpg" alt="Nutrition facts">`;
const shopifyPage = `<!doctype html><script>var meta = {"product":{"id":123,"vendor":"Acme","title":"Acme Protein Rusk","url":"/products/protein-rusk","variants":[{"id":456,"price":41500,"available":true,"sku":"rusk-1"}]}};</script><img src="//cdn.example/rusk.jpg" alt="Acme Protein Rusk">`;
const shopifyVariantsPage = `<!doctype html><script>var meta = {"product":{"id":123,"vendor":"Acme","title":"Acme Protein Rusk","url":"/products/protein-rusk","variants":[{"id":456,"price":41500,"available":true,"sku":"rusk-1","name":"Acme Protein Rusk 150 g"},{"id":789,"price":69900,"available":true,"sku":"rusk-2","name":"Acme Protein Rusk 300 g"}]}};</script><img src="//cdn.example/rusk.jpg" alt="Acme Protein Rusk">`;
const nutritionTablePage = `${microdataPage}<p>Nutrition facts</p><p>| Nutrient | Per 100g | Per 40g |<br>| --- | --- | --- |<br>| Energy | 400 kcal | 160 kcal |<br>| Protein | 25 g | 10 g |<br>| Carbohydrate | 50 g | 20 g |<br>| Total Fat | 10 g | 4 g |<br>| Sodium | 120 mg | 48 mg |</p>`;
const nutritionLabelTablePage = `${microdataPage}<p>Nutrition Label | PER 100g | PER 40g<br><strong>Calories</strong> | 422kcal | 169kcal<br><strong>Protein</strong> | 27g | 11g<br>Carbohydrate | 48g | 19g<br>Total Fat | 9g | 4g</p>`;
const multipleNutritionTablesPage = `${nutritionTablePage}<p>| Nutrient | Per 100g | Per 40g |<br>| --- | --- | --- |<br>| Energy | 500 kcal | 200 kcal |<br>| Protein | 20 g | 8 g |</p>`;
const configuredNutritionImagePage = `${page}<img src="https://cdn.example/nivalues_45.png?v=1&width=100" alt="">`;

describe("official brand sitemap discovery", () => {
  it("honors specific robots rules", () => {
    expect(robotsAllows("User-agent: *\nDisallow: /", "ProteinIndexCatalogBot/1.0")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /\nAllow: /products", "ProteinIndexCatalogBot/1.0", "/products/puffs")).toBe(true);
  });

  it("preserves a direct INR offer and keeps basis-unknown structured nutrition unverified", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/puffs", html: page, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product).toMatchObject({ gtin: "08900000000012", offers: [{ sellingPrice: 199, available: true }], nutrition: { status: "unverified", basis: "unknown", per100g: { calories: 100, proteinGrams: 12 } } });
    expect(product?.rawEvidence).toHaveProperty("productJsonLd.nutrition.calories", "100 kcal");
  });

  it("normalizes only configured first-party brand aliases to the configured display name", () => {
    const product = stagedOfficialBrandProduct({
      source: { ...source, brandAliases: ["acme1"] },
      pageUrl: "https://brand.example/products/puffs",
      html: page.replace('"brand":{"@type":"Brand","name":"Acme"}', '"brand":"acme1"'),
      observedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(product?.brand).toBe("Acme India");
  });

  it("retains an explicitly declared total net weight from product metadata without mistaking a protein claim for pack size", () => {
    const product = stagedOfficialBrandProduct({
      source,
      pageUrl: "https://brand.example/products/cookie",
      html: page.replace('"name":"Acme Protein Puffs"', '"name":"Acme Protein Cookie 10g Protein"').replace('"category":"Protein snacks"', '"description":"NET WT: 40g\\nEach cookie has 10g protein", "category":"Protein snacks"'),
      observedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(product?.netQuantityGrams).toBe(40);
  });

  it("accepts one explicit, validation-passing per-100-g nutrition table as first-party evidence", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/whey", html: nutritionTablePage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product).toMatchObject({ nutrition: { status: "unverified", basis: "per_100g", per100g: { calories: 400, proteinGrams: 25, carbohydrateGrams: 50, fatGrams: 10, sodiumMg: 120 } } });
    expect(product?.rawEvidence).toHaveProperty("nutritionTable");
  });

  it("accepts an explicit non-markdown Nutrition Label table with a per-100-g column", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/chips", html: nutritionLabelTablePage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product).toMatchObject({ nutrition: { status: "unverified", basis: "per_100g", per100g: { calories: 422, proteinGrams: 27, carbohydrateGrams: 48, fatGrams: 9 } } });
  });

  it("refuses to assign one of multiple page nutrition tables to a product", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/whey", html: multipleNutritionTablesPage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product).toMatchObject({ nutrition: { status: "missing" } });
    expect(product?.rawEvidence).toHaveProperty("nutritionTable", null);
  });

  it("accepts bounded schema.org Product microdata while preserving its distinct provenance", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/whey", html: microdataPage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product).toMatchObject({ name: "Acme Whey Protein", flavour: "Chocolate • 1 kg", netQuantityGrams: 1000, nutritionImageUrl: "https://cdn.example/whey-nutrition.jpg", ingredientImageUrl: "https://cdn.example/whey-ingredients.jpg", offers: [{ sellingPrice: 999, available: true }], nutrition: { status: "missing" } });
    expect(product?.rawEvidence).toHaveProperty("productMicrodata.name", "Acme Whey Protein");
    expect(product?.rawEvidence).toHaveProperty("labels.nutritionImageUrl", "https://cdn.example/whey-nutrition.jpg");
  });

  it("accepts page-bound Shopify product metadata without using a storefront JSON endpoint", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/protein-rusk", html: shopifyPage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product).toMatchObject({
      name: "Acme Protein Rusk",
      brand: "Acme",
      imageUrl: "https://cdn.example/rusk.jpg",
      offers: [{ sellingPrice: 415, available: true }],
    });
    expect(product?.rawEvidence).toHaveProperty("productShopifyMeta.name", "Acme Protein Rusk");
  });

  it("stages Shopify pack variants separately with their direct first-party offers", () => {
    const products = stagedOfficialBrandProducts({ source, pageUrl: "https://brand.example/products/protein-rusk", html: shopifyVariantsPage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(products).toMatchObject([
      { name: "Acme Protein Rusk 150 g", netQuantityGrams: 150, sourceRecordId: "https://brand.example/products/protein-rusk?variant=456", offers: [{ sellingPrice: 415 }] },
      { name: "Acme Protein Rusk 300 g", netQuantityGrams: 300, sourceRecordId: "https://brand.example/products/protein-rusk?variant=789", offers: [{ sellingPrice: 699 }] },
    ]);
  });

  it("accepts an image only from an explicitly named label section when its alt text is empty", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/puffs", html: sectionLabelPage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product).toMatchObject({ nutritionImageUrl: "https://cdn.example/puffs-nutrition.jpg", ingredientImageUrl: "https://cdn.example/puffs-ingredients.jpg" });
  });

  it("does not treat an image from a non-semantic nutrition container as label evidence", () => {
    const product = stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/puffs", html: nonSemanticNutritionContainerPage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(product?.nutritionImageUrl).toBeNull();
  });

  it("accepts only a source-configured explicit nutrition-image filename convention", () => {
    const product = stagedOfficialBrandProduct({
      source: { ...source, nutritionImageFilenamePrefixes: ["nivalues_"] },
      pageUrl: "https://brand.example/products/puffs",
      html: configuredNutritionImagePage,
      observedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(product?.nutritionImageUrl).toBe("https://cdn.example/nivalues_45.png?v=1");
    expect(stagedOfficialBrandProduct({ source, pageUrl: "https://brand.example/products/puffs", html: configuredNutritionImagePage, observedAt: "2026-07-18T00:00:00.000Z" })?.nutritionImageUrl).toBeNull();
  });

  it("stages explicit ProductGroup variants separately without sharing a page-level label", () => {
    const products = stagedOfficialBrandProducts({ source, pageUrl: "https://brand.example/products/whey", html: productGroupPage, observedAt: "2026-07-18T00:00:00.000Z" });
    expect(products).toHaveLength(2);
    expect(products).toMatchObject([
      { name: "Acme Whey Chocolate 1 kg", brand: "Acme", netQuantityGrams: 1000, sourceRecordId: "https://brand.example/products/whey?variant=choc", nutritionImageUrl: null, offers: [{ sellingPrice: 1999 }] },
      { name: "Acme Whey Vanilla 15g Protein", brand: "Acme", netQuantityGrams: null, sourceRecordId: "https://brand.example/products/whey?variant=vanilla", nutritionImageUrl: null, offers: [{ sellingPrice: 1999 }] },
    ]);
  });

  it("keeps traversal source-incomplete at the page budget and excludes off-host locations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-sitemap-"));
    const urls = new Map<string, string>([
      ["https://brand.example/robots.txt", "User-agent: *\nAllow: /"],
      ["https://brand.example/sitemap.xml", "<urlset><url><loc>https://other.example/product</loc></url><url><loc>https://brand.example/products/puffs</loc></url><url><loc>https://brand.example/products/second</loc></url></urlset>"],
      ["https://brand.example/products/puffs", page],
      ["https://brand.example/products/second", page.replace("Puffs", "Bar")],
    ]);
    const result = await discoverOfficialBrandCatalog({ source: { ...source, maxProductPages: 1 }, outputDirectory: directory, fetcher: async (input) => new Response(urls.get(String(input)) ?? "missing", { status: urls.has(String(input)) ? 200 : 404 }) });
    expect(result.manifest).toMatchObject({ terminalEvidence: "limit", sourceComplete: false, stagedRecords: 1, invalidRecords: 1, marketComplete: false });
    expect((await readFile(result.exclusionsPath, "utf8"))).toContain("url_outside_boundary");
  });

  it("retries a bounded temporary rate limit before declaring the source complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-retry-"));
    let productRequests = 0;
    const result = await discoverOfficialBrandCatalog({
      source: { ...source, maxRetries: 1 },
      outputDirectory: directory,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /");
        if (url.endsWith("/sitemap.xml")) return new Response("<urlset><url><loc>https://brand.example/products/puffs</loc></url></urlset>");
        productRequests += 1;
        return productRequests === 1 ? new Response("slow down", { status: 429 }) : new Response(page);
      },
    });
    expect(productRequests).toBe(2);
    expect(result.manifest).toMatchObject({ sourceComplete: true, stagedRecords: 1 });
  });

  it("retries a declared transient not-found response before excluding a live product page", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-not-found-retry-"));
    let productRequests = 0;
    const result = await discoverOfficialBrandCatalog({
      source: { ...source, maxNotFoundRetries: 1 },
      outputDirectory: directory,
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /");
        if (url.endsWith("/sitemap.xml")) return new Response("<urlset><url><loc>https://brand.example/products/puffs</loc></url></urlset>");
        productRequests += 1;
        return productRequests === 1 ? new Response("missing", { status: 404 }) : new Response(page);
      },
    });
    expect(productRequests).toBe(2);
    expect(result.manifest).toMatchObject({ sourceComplete: true, stagedRecords: 1 });
  });

  it("records non-matching configured product names as exclusions without making the source partial", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-scope-"));
    const urls = new Map<string, string>([["https://brand.example/robots.txt", "User-agent: *\nAllow: /"], ["https://brand.example/sitemap.xml", "<urlset><url><loc>https://brand.example/products/salt</loc></url></urlset>"], ["https://brand.example/products/salt", microdataPage.replace("Acme Whey Protein", "Acme Salt")]]);
    const result = await discoverOfficialBrandCatalog({ source: { ...source, requiredNameTerms: ["protein", "whey"] }, outputDirectory: directory, fetcher: async (input) => new Response(urls.get(String(input)) ?? "missing", { status: urls.has(String(input)) ? 200 : 404 }) });
    expect(result.manifest).toMatchObject({ sourceComplete: true, stagedRecords: 0, invalidRecords: 1 });
    expect(await readFile(result.exclusionsPath, "utf8")).toContain("product_name_not_included");
  });

  it("uses declared URL terms to avoid fetching out-of-scope sitemap products while retaining an auditable exclusion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-url-scope-"));
    const urls = new Map<string, string>([["https://brand.example/robots.txt", "User-agent: *\nAllow: /"], ["https://brand.example/sitemap.xml", "<urlset><url><loc>https://brand.example/products/salt</loc></url><url><loc>https://brand.example/products/whey</loc></url></urlset>"], ["https://brand.example/products/whey", microdataPage]]);
    const requests: string[] = [];
    const result = await discoverOfficialBrandCatalog({ source: { ...source, candidateUrlTerms: ["whey"], requiredNameTerms: ["whey"] }, outputDirectory: directory, fetcher: async (input) => { const url = String(input); requests.push(url); return new Response(urls.get(url) ?? "missing", { status: urls.has(url) ? 200 : 404 }); } });
    expect(result.manifest).toMatchObject({ sourceComplete: true, recordsRead: 1, stagedRecords: 1 });
    expect(requests).not.toContain("https://brand.example/products/salt");
    expect(await readFile(result.exclusionsPath, "utf8")).toContain("product_url_not_included");
  });

  it("deduplicates identical official product variants without merging unknown variants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-duplicates-"));
    const urls = new Map<string, string>([["https://brand.example/robots.txt", "User-agent: *\nAllow: /"], ["https://brand.example/sitemap.xml", "<urlset><url><loc>https://brand.example/products/whey?variant=1</loc></url><url><loc>https://brand.example/products/whey?variant=2</loc></url></urlset>"], ["https://brand.example/products/whey?variant=1", microdataPage], ["https://brand.example/products/whey?variant=2", microdataPage]]);
    const result = await discoverOfficialBrandCatalog({ source, outputDirectory: directory, fetcher: async (input) => new Response(urls.get(String(input)) ?? "missing", { status: urls.has(String(input)) ? 200 : 404 }) });
    expect(result.manifest).toMatchObject({ sourceComplete: true, stagedRecords: 1, duplicateRecords: 1 });
    expect(await readFile(result.exclusionsPath, "utf8")).toContain("duplicate_product_variant");
  });

  it("rejects a source whose sitemap leaves the explicit host boundary", () => {
    expect(() => validateOfficialBrandSource({ ...source, sitemapUrls: ["https://other.example/sitemap.xml"] })).toThrow("outside the configured boundary");
  });

  it("keeps the scheduled catalog matrix aligned with every configured source", async () => {
    const config = JSON.parse(await readFile("config/official-brand-sources.json", "utf8")) as OfficialBrandDiscoveryConfig;
    validateOfficialBrandConfig(config);
    const workflow = await readFile(".github/workflows/official-brand-discovery.yml", "utf8");
    for (const configured of config.sources) expect(workflow).toContain(`- source: ${configured.id}`);
  });

  it("reconciles first-party identity and offer evidence through the normal import path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-import-"));
    const urls = new Map<string, string>([["https://brand.example/robots.txt", "User-agent: *\nAllow: /"], ["https://brand.example/sitemap.xml", "<urlset><url><loc>https://brand.example/products/puffs</loc></url></urlset>"], ["https://brand.example/products/puffs", page]]);
    const result = await discoverOfficialBrandCatalog({ source, outputDirectory: directory, fetcher: async (input) => new Response(urls.get(String(input)) ?? "missing", { status: urls.has(String(input)) ? 200 : 404 }) });
    const importPath = join(directory, "import.sql");
    await emitImportSql({ stagedPath: result.stagedPath, manifestPath: result.manifestPath, outputPath: importPath });
    const db = new DatabaseSync(":memory:");
    for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(join("migrations", migration), "utf8"));
    db.exec(await readFile(importPath, "utf8"));
    expect(db.prepare("SELECT gtin FROM products").get()).toEqual({ gtin: "08900000000012" });
    expect(db.prepare("SELECT selling_price, retailer FROM offers").get()).toEqual({ selling_price: 199, retailer: "acme_india" });
    db.close();
  });
});
