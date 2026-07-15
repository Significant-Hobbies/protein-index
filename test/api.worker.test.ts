import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CatalogResponse, CoverageResponse, HealthResponse, ProductDetailResponse, ReviewResponse } from "../shared/api";

const worker = exports.default;

async function json<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json() as Promise<T>;
}

async function replaySeed(): Promise<void> {
  for (let index = 0; index < env.TEST_SEED_QUERIES.length; index += 50) {
    await env.DB.batch(env.TEST_SEED_QUERIES.slice(index, index + 50).map((query) => env.DB.prepare(query)));
  }
}

async function identityReview(sourceRecordId: string): Promise<ReviewResponse["items"][number]> {
  const source = await env.DB.prepare("SELECT id FROM source_records WHERE source_record_id = ?")
    .bind(sourceRecordId).first<{ id: string }>();
  if (!source) throw new Error(`Expected source record ${sourceRecordId}`);
  const response = await worker.fetch("http://localhost/api/reviews?status=open");
  const reviews = await json<ReviewResponse>(response);
  const review = reviews.items.find((item) => item.type === "identity" && item.sourceRecordId === source.id);
  if (!review?.productId) throw new Error("Expected an identity review with an incoming product");
  return review;
}

describe("Worker catalog API", () => {
  it("reports seeded health and configured-source coverage", async () => {
    const healthResponse = await worker.fetch("http://localhost/api/health");
    expect(healthResponse.status).toBe(200);
    expect(await json<HealthResponse>(healthResponse)).toMatchObject({
      status: "ok",
      products: 5,
      runtime: "local",
      sourceComplete: true,
      mutations: "local_only",
    });

    const coverageResponse = await worker.fetch("http://localhost/api/coverage");
    expect(coverageResponse.status).toBe(200);
    const coverage = await json<CoverageResponse>(coverageResponse);
    expect(coverage.claim).toBe("configured_sources_only");
    expect(coverage.catalog).toMatchObject({ products: 5, validGtin: 5, structuredNutrition: 5, nutritionLabelImages: 0, extractionCandidates: 0 });
    expect(coverage.completion).toMatchObject({ status: "incomplete", sourceCoverageComplete: true, outstandingIdentity: 5 });
    expect(coverage.completion.outstandingNutrition).toBeGreaterThan(0);
    expect(coverage.sources[0]).toMatchObject({ id: "label_fixture", sourceComplete: true, marketComplete: false });
    expect(coverage.disconnectedSources).toContain("gs1_india_datakart");
  });

  it("reports production runtime and rejects anonymous production mutations", async () => {
    const health = await worker.fetch("https://protein-index.example/api/health");
    expect(await json<HealthResponse>(health)).toMatchObject({ runtime: "production", mutations: "local_only" });

    const mutation = await worker.fetch("https://protein-index.example/api/reviews/anything/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "dismiss", rationale: "should remain read only" }),
    });
    expect(mutation.status).toBe(403);
    expect(await json<{ error: { code: string } }>(mutation)).toMatchObject({ error: { code: "mutations_disabled" } });
  });

  it("uses evidence-aware protein-density defaults and returns evidence-rich detail", async () => {
    const catalogResponse = await worker.fetch("http://localhost/api/products");
    expect(catalogResponse.status).toBe(200);
    const catalog = await json<CatalogResponse>(catalogResponse);
    expect(catalog.trustedDefault).toBe(false);
    expect(catalog.filters).toMatchObject({ verification: "all", scope: "all", sort: "protein_density" });
    expect(catalog.products.length).toBeGreaterThan(0);
    expect(catalog.products.some((product) => product.nutritionStatus === "verified")).toBe(true);
    expect(catalog.products.filter((product) => product.nutritionStatus === "conflict").every((product) => product.metrics.proteinPer100Calories.value === null)).toBe(true);
    const densityValues = catalog.products.map((product) => product.metrics.proteinPer100Calories.value).filter((value): value is number => value !== null);
    expect(densityValues).toEqual([...densityValues].sort((left, right) => right - left));
    const firstUnavailable = catalog.products.findIndex((product) => product.metrics.proteinPer100Calories.value === null);
    if (firstUnavailable >= 0) {
      expect(catalog.products.slice(firstUnavailable).every((product) => product.metrics.proteinPer100Calories.value === null)).toBe(true);
    }
    const first = catalog.products[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("Expected a catalog product");

    const detailResponse = await worker.fetch(`http://localhost/api/products/${first.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = await json<ProductDetailResponse>(detailResponse);
    expect(detail.id).toBe(first.id);
    expect(detail.sourceRecords[0]?.source).toBe("label_fixture");
    expect(detail.ingredientStatement).toBeTruthy();
    expect(detail.ingredients.length).toBeGreaterThan(0);
    expect(detail.nutrients.length).toBeGreaterThan(0);
    expect(detail.offers[0]?.retailer).toBe("fixture_retailer");
    expect(detail.ratings[0]?.ratingCount).toBeGreaterThan(0);
    expect(detail.provenance.some((observation) => observation.field.startsWith("nutrition."))).toBe(true);

    await env.DB.prepare("UPDATE nutrition_facts SET status = 'unverified' WHERE product_id = ?").bind(first.id).run();
    const discoveryResponse = await worker.fetch("http://localhost/api/products?verification=all&scope=all&sort=completeness");
    const discovery = await json<CatalogResponse>(discoveryResponse);
    const unverified = discovery.products.find((product) => product.id === first.id);
    expect(unverified).toBeDefined();
    expect(unverified?.metrics.proteinPer100Calories.value).toBeGreaterThan(0);
    const trustedResponse = await worker.fetch("http://localhost/api/products?verification=verified&scope=protein&sort=protein_density");
    const trusted = await json<CatalogResponse>(trustedResponse);
    expect(trusted.trustedDefault).toBe(true);
    expect(trusted.products.some((product) => product.id === first.id)).toBe(false);
    await env.DB.prepare("UPDATE nutrition_facts SET status = 'unverified', calories = 33, protein_grams = 8.59, carbohydrate_grams = 28.1, fat_grams = 1.2 WHERE product_id = ?").bind(first.id).run();
    const invalidNutritionResponse = await worker.fetch("http://localhost/api/products");
    const invalidNutritionCatalog = await json<CatalogResponse>(invalidNutritionResponse);
    const invalidNutrition = invalidNutritionCatalog.products.find((product) => product.id === first.id);
    expect(invalidNutrition?.metrics.proteinPer100Calories).toEqual({ value: null, reason: "nutrition_validation_error" });
    expect(invalidNutritionCatalog.products[0]?.id).not.toBe(first.id);
    await env.DB.prepare("UPDATE nutrition_facts SET status = 'verified', calories = ?, protein_grams = ?, carbohydrate_grams = ?, fat_grams = ? WHERE product_id = ?")
      .bind(first.nutrition.calories, first.nutrition.proteinGrams, first.nutrition.carbohydrateGrams, first.nutrition.fatGrams, first.id).run();
  });

  it("validates bounded search and missing records", async () => {
    const invalid = await worker.fetch("http://localhost/api/products?pageSize=101");
    expect(invalid.status).toBe(400);
    expect(await json<{ error: { code: string } }>(invalid)).toMatchObject({ error: { code: "validation_error" } });

    const missing = await worker.fetch("http://localhost/api/products/not-a-product");
    expect(missing.status).toBe(404);
    expect(await json<{ error: { code: string } }>(missing)).toMatchObject({ error: { code: "not_found" } });
  });

  it("resolves a local review once and preserves conflict semantics", async () => {
    const listResponse = await worker.fetch("http://localhost/api/reviews?status=open");
    expect(listResponse.status).toBe(200);
    const reviews = await json<ReviewResponse>(listResponse);
    const review = reviews.items.find((item) => item.type === "coverage_gap");
    expect(review).toBeDefined();
    if (!review) throw new Error("Expected an open review fixture");

    const unsupportedVerification = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "No evidence supplied" }),
    });
    expect(unsupportedVerification.status).toBe(400);
    expect(await json<{ error: { code: string } }>(unsupportedVerification)).toMatchObject({ error: { code: "validation_error" } });

    const resolve = () => worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "Synthetic integration-test decision", evidenceUrl: "https://example.invalid/label-proof" }),
    });
    const resolved = await resolve();
    expect(resolved.status).toBe(200);
    expect(await json<{ status: string }>(resolved)).toMatchObject({ status: "resolved" });

    const conflict = await resolve();
    expect(conflict.status).toBe(409);
    expect(await json<{ error: { code: string } }>(conflict)).toMatchObject({ error: { code: "conflict" } });

    const resolvedList = await worker.fetch("http://localhost/api/reviews?status=resolved");
    const resolvedReviews = await json<ReviewResponse>(resolvedList);
    expect(resolvedReviews.items[0]).toMatchObject({
      id: review.id,
      decision: "verify_nutrition",
      decisionEvidenceUrl: "https://example.invalid/label-proof",
      decidedBy: "local_operator",
    });
  });

  it("persists a manual identity match and reuses it on replay", async () => {
    const review = await identityReview("fixture-ambiguous-whey-listing");
    expect(review.candidates).toHaveLength(1);
    const candidate = review.candidates[0];
    if (!candidate) throw new Error("Expected an identity candidate");
    expect(candidate).toMatchObject({ brand: "Atlas Test Foods", name: "High Protein Whey Blend", netQuantityGrams: 1000 });

    const invalidCandidate = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "match", rationale: "Wrong candidate proof", candidateProductId: "not-a-candidate" }),
    });
    expect(invalidCandidate.status).toBe(400);

    const resolved = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "match", rationale: "Same label identity; missing retailer pack metadata", candidateProductId: candidate.id }),
    });
    expect(resolved.status).toBe(200);

    await replaySeed();

    const source = await env.DB.prepare(`SELECT product_id, resolution_rule FROM source_records
      WHERE source_id = 'label_fixture' AND source_record_id = 'fixture-ambiguous-whey-listing'`).first<{ product_id: string | null; resolution_rule: string }>();
    expect(source).toEqual({ product_id: candidate.id, resolution_rule: "manual_match" });
    const decision = await env.DB.prepare("SELECT decision, target_product_id, active FROM identity_decisions WHERE source_record_key = ?")
      .bind("fixture-ambiguous-whey-listing").first<{ decision: string; target_product_id: string; active: number }>();
    expect(decision).toEqual({ decision: "match", target_product_id: candidate.id, active: 1 });
    const incoming = await env.DB.prepare("SELECT is_active FROM products WHERE id = ?").bind(review.productId).first<{ is_active: number }>();
    expect(incoming?.is_active).toBe(0);
    const openIdentity = await env.DB.prepare("SELECT COUNT(*) AS count FROM review_items WHERE type = 'identity' AND status = 'open' AND source_record_id = ?")
      .bind(review.sourceRecordId).first<{ count: number }>();
    expect(openIdentity?.count).toBe(0);
    const activeProducts = await env.DB.prepare("SELECT COUNT(*) AS count FROM products WHERE is_active = 1").first<{ count: number }>();
    expect(activeProducts?.count).toBe(5);
    const candidateDetail = await worker.fetch(`http://localhost/api/products/${candidate.id}`);
    const detail = await json<ProductDetailResponse>(candidateDetail);
    expect(detail.sourceRecords.some((record) => record.sourceRecordId === "fixture-ambiguous-whey-listing" && record.resolutionRule === "manual_match")).toBe(true);
    expect(detail.gtin).toBe("08900000000012");
    expect(detail.netQuantityGrams).toBe(1000);
  });

  it("persists a create-new identity decision across replay", async () => {
    const review = await identityReview("fixture-distinct-whey-listing");
    const resolved = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "create_new", rationale: "Packaging evidence establishes a distinct product" }),
    });
    expect(resolved.status).toBe(200);

    await replaySeed();

    const source = await env.DB.prepare("SELECT product_id, resolution_rule FROM source_records WHERE source_record_id = ?")
      .bind("fixture-distinct-whey-listing").first<{ product_id: string; resolution_rule: string }>();
    expect(source).toEqual({ product_id: review.productId, resolution_rule: "manual_create_new" });
    const decision = await env.DB.prepare("SELECT decision, target_product_id FROM identity_decisions WHERE source_record_key = ?")
      .bind("fixture-distinct-whey-listing").first<{ decision: string; target_product_id: string }>();
    expect(decision).toEqual({ decision: "create_new", target_product_id: review.productId });
    const incoming = await env.DB.prepare("SELECT is_active FROM products WHERE id = ?").bind(review.productId).first<{ is_active: number }>();
    expect(incoming?.is_active).toBe(1);
  });

  it("persists a keep-unmatched identity decision across replay", async () => {
    const review = await identityReview("fixture-unmatched-whey-listing");
    const resolved = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "no_match", rationale: "Evidence is insufficient to publish or merge this listing" }),
    });
    expect(resolved.status).toBe(200);

    await replaySeed();

    const source = await env.DB.prepare("SELECT product_id, resolution_rule FROM source_records WHERE source_record_id = ?")
      .bind("fixture-unmatched-whey-listing").first<{ product_id: string | null; resolution_rule: string }>();
    expect(source).toEqual({ product_id: null, resolution_rule: "manual_no_match" });
    const decision = await env.DB.prepare("SELECT decision, target_product_id FROM identity_decisions WHERE source_record_key = ?")
      .bind("fixture-unmatched-whey-listing").first<{ decision: string; target_product_id: string | null }>();
    expect(decision).toEqual({ decision: "no_match", target_product_id: null });
    const incoming = await env.DB.prepare("SELECT is_active FROM products WHERE id = ?").bind(review.productId).first<{ is_active: number }>();
    expect(incoming?.is_active).toBe(0);
    const stillLinked = await env.DB.prepare("SELECT COUNT(*) AS count FROM source_records WHERE product_id = ?")
      .bind(review.productId).first<{ count: number }>();
    expect(stillLinked?.count).toBe(0);
  });
});
