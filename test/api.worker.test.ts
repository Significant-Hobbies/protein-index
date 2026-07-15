import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CatalogResponse, CoverageResponse, HealthResponse, ProductDetailResponse, ReviewResponse } from "../shared/api";
import { canonicalJson, nutritionCandidateFromEvidence, nutritionCandidateHash } from "../shared/evidence-decisions";

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

async function applyQueries(queries: string[]): Promise<void> {
  for (let index = 0; index < queries.length; index += 50) {
    await env.DB.batch(queries.slice(index, index + 50).map((query) => env.DB.prepare(query)));
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

async function insertRobotoffReview(input: {
  suffix: string;
  evidence: unknown;
}): Promise<{ reviewId: string; productId: string; sourceRecordId: string }> {
  const product = await env.DB.prepare("SELECT id, gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
    .first<{ id: string; gtin: string }>();
  const run = await env.DB.prepare("SELECT id FROM ingestion_runs ORDER BY started_at LIMIT 1").first<{ id: string }>();
  if (!product || !run) throw new Error("Expected seeded product and ingestion run");
  const sourceRecordId = `src_robotoff_${input.suffix}`;
  const reviewId = `rev_robotoff_${input.suffix}`;
  const observedAt = "2026-07-15T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO sources
      (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
        license_url, retention_notes, credential_requirement, created_at)
      VALUES ('open_food_facts_robotoff', 'Open Food Facts Robotoff', 'open_data', 0, 20, 0,
        'https://opendatacommons.org/licenses/odbl/1-0/', 'Review evidence only', NULL, ?)`)
      .bind(observedAt),
    env.DB.prepare(`INSERT INTO source_records
      (id, source_id, source_record_id, product_id, source_url, content_hash, identity_hash,
        observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
      VALUES (?, 'open_food_facts_robotoff', ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'exact_gtin')`)
      .bind(sourceRecordId, `${product.gtin}:${input.suffix}`, product.id,
        `https://robotoff.openfoodfacts.org/api/v1/image_predictions?barcode=${product.gtin}`,
        `hash_${input.suffix}`, `identity_${input.suffix}`, observedAt, run.id, run.id),
    env.DB.prepare(`INSERT INTO review_items
      (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json,
        evidence_json, created_at)
      VALUES (?, 'nutrition_validation', 50, 'open', ?, ?, '[]', ?, ?)`)
      .bind(reviewId, sourceRecordId, product.id, JSON.stringify(input.evidence), observedAt),
  ]);
  return { reviewId, productId: product.id, sourceRecordId };
}

function robotoffEvidence(barcode: string, nutritionPer100g: Record<string, number | null>): unknown {
  return {
    code: "robotoff_nutrition_candidate",
    severity: "warning",
    field: "nutrition",
    details: {
      candidate: {
        predictionId: "prediction-1",
        barcode,
        imageId: "image-1",
        imageUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
        modelName: "nutrition_extractor",
        modelVersion: "nutrition_extractor-2.0",
        observedAt: "2026-07-14T00:00:00.000Z",
        basis: "per_100g",
        minimumConfidence: 0.93,
        nutritionPer100g,
      },
    },
  };
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

  it("applies the exact reviewed Robotoff candidate and records its evidence atomically", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const nutrition = {
      calories: 400,
      proteinGrams: 40,
      carbohydrateGrams: 30,
      sugarGrams: 5,
      fatGrams: 10,
      saturatedFatGrams: 3,
      fibreGrams: 4,
      sodiumMg: 250,
    };
    const review = await insertRobotoffReview({ suffix: "verify", evidence: robotoffEvidence(product.gtin, nutrition) });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Reviewed against the current package label",
        evidenceUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
      }),
    });
    expect(response.status).toBe(200);
    const fact = await env.DB.prepare(`SELECT source_record_id, status, confidence, authority, basis,
      preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams,
      saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at
      FROM nutrition_facts WHERE product_id = ?`).bind(review.productId).first<Record<string, unknown>>();
    expect(fact).toMatchObject({
      source_record_id: review.sourceRecordId,
      status: "verified",
      confidence: "high",
      authority: 100,
      basis: "per_100g",
      preparation_state: "as_sold",
      calories: 400,
      protein_grams: 40,
      carbohydrate_grams: 30,
      sugar_grams: 5,
      fat_grams: 10,
      saturated_fat_grams: 3,
      fibre_grams: 4,
      sodium_mg: 250,
      observed_at: "2026-07-14T00:00:00.000Z",
    });
    expect(fact?.label_verified_at).toEqual(expect.any(String));
    const outcome = await env.DB.prepare("SELECT outcome, source_record_id, evidence_url, decided_by FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition'")
      .bind(review.productId).first<Record<string, unknown>>();
    expect(outcome).toEqual({
      outcome: "verified",
      source_record_id: review.sourceRecordId,
      evidence_url: "https://images.openfoodfacts.org/images/products/label.jpg",
      decided_by: "local_operator",
    });
    const selected = await env.DB.prepare("SELECT COUNT(*) AS count FROM field_observations WHERE product_id = ? AND field_path LIKE 'nutrition.%' AND selected = 1")
      .bind(review.productId).first<{ count: number }>();
    expect(selected?.count).toBe(8);
    const decision = await env.DB.prepare(`SELECT source_record_id, source_content_hash, product_id,
      candidate_hash, field_family, decision, payload_json, evidence_url, rationale, decided_by, active
      FROM evidence_decisions WHERE id = ?`).bind(`evd_${review.reviewId}`).first<Record<string, unknown>>();
    expect(decision).toMatchObject({
      source_record_id: review.sourceRecordId,
      source_content_hash: "hash_verify",
      product_id: review.productId,
      field_family: "nutrition",
      decision: "verify",
      evidence_url: "https://images.openfoodfacts.org/images/products/label.jpg",
      rationale: "Reviewed against the current package label",
      decided_by: "local_operator",
      active: 1,
    });
    expect(decision?.candidate_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(String(decision?.payload_json))).toMatchObject({ nutritionPer100g: nutrition });
  });

  it("rejects a Robotoff candidate without clearing independently sourced nutrition", async () => {
    const product = await env.DB.prepare(`SELECT p.gtin, nf.calories, nf.protein_grams
      FROM products p JOIN nutrition_facts nf ON nf.product_id = p.id
      WHERE p.is_active = 1 AND p.gtin IS NOT NULL ORDER BY p.id LIMIT 1`)
      .first<{ gtin: string; calories: number; protein_grams: number }>();
    if (!product) throw new Error("Expected seeded nutrition");
    const review = await insertRobotoffReview({ suffix: "reject", evidence: robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    }) });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject_nutrition", rationale: "Label values do not match the current pack" }),
    });
    expect(response.status).toBe(200);
    const unchanged = await env.DB.prepare("SELECT calories, protein_grams FROM nutrition_facts WHERE product_id = ?")
      .bind(review.productId).first<{ calories: number; protein_grams: number }>();
    expect(unchanged).toEqual({ calories: product.calories, protein_grams: product.protein_grams });
    const decision = await env.DB.prepare("SELECT decision, evidence_url, active FROM evidence_decisions WHERE id = ?")
      .bind(`evd_${review.reviewId}`).first<{ decision: string; evidence_url: string; active: number }>();
    expect(decision).toEqual({
      decision: "reject",
      evidence_url: "https://images.openfoodfacts.org/images/products/label.jpg",
      active: 1,
    });
  });

  it("fails atomically when an evidence decision id conflicts", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    });
    const review = await insertRobotoffReview({ suffix: "decision-id-conflict", evidence });
    await env.DB.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      SELECT ?, source_id, source_record_id, id, content_hash, product_id,
        ?, 'nutrition', 'reject', '{}', ?, ?, 'test_operator', ?, 1
      FROM source_records WHERE id = ?`)
      .bind(`evd_${review.reviewId}`, "0".repeat(64), "https://example.invalid/old-label", "Conflicting historical decision", "2026-07-14T00:00:00.000Z", review.sourceRecordId)
      .run();
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "Current label review", evidenceUrl: "https://images.openfoodfacts.org/images/products/label.jpg" }),
    });
    expect(response.status).toBe(409);
    const row = await env.DB.prepare("SELECT status FROM review_items WHERE id = ?").bind(review.reviewId).first<{ status: string }>();
    expect(row?.status).toBe("open");
  });

  it("refuses to reuse a matching candidate decision after source-content drift", async () => {
    const product = await env.DB.prepare("SELECT gtin FROM products WHERE is_active = 1 AND gtin IS NOT NULL ORDER BY id LIMIT 1")
      .first<{ gtin: string }>();
    if (!product) throw new Error("Expected a seeded GTIN");
    const evidence = robotoffEvidence(product.gtin, {
      calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
      fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
    });
    const candidate = nutritionCandidateFromEvidence(evidence, product.gtin);
    if (!candidate) throw new Error("Expected valid candidate evidence");
    const candidateHash = await nutritionCandidateHash(candidate);
    const review = await insertRobotoffReview({ suffix: "source-drift", evidence });
    await env.DB.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      SELECT 'evd_old_source', source_id, source_record_id, id, 'superseded_source_hash', product_id,
        ?, 'nutrition', 'verify', ?, ?, ?, 'test_operator', ?, 1
      FROM source_records WHERE id = ?`)
      .bind(candidateHash, canonicalJson(candidate), candidate.imageUrl, "Reviewed before source changed", "2026-07-14T00:00:00.000Z", review.sourceRecordId)
      .run();
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "Review after source changed", evidenceUrl: candidate.imageUrl }),
    });
    expect(response.status).toBe(409);
    const durable = await env.DB.prepare("SELECT source_content_hash FROM evidence_decisions WHERE id = 'evd_old_source'")
      .first<{ source_content_hash: string }>();
    expect(durable?.source_content_hash).toBe("superseded_source_hash");
    const current = await env.DB.prepare("SELECT COUNT(*) AS count FROM evidence_decisions WHERE id = ?")
      .bind(`evd_${review.reviewId}`).first<{ count: number }>();
    expect(current?.count).toBe(0);
  });

  it("replays unchanged verify/reject decisions and reopens changed candidate evidence", async () => {
    await applyQueries(env.TEST_ROBOTOFF_REPLAY_QUERIES);
    const reviews = await env.DB.prepare(`SELECT r.id, s.source_record_id
      FROM review_items r JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_id = 'open_food_facts_robotoff' AND s.source_record_id IN ('8900000000012:901', '8900000000012:902')
      AND r.status = 'open' ORDER BY s.source_record_id`).all<{ id: string; source_record_id: string }>();
    expect(reviews.results).toHaveLength(2);
    const verifyReview = reviews.results.find(({ source_record_id }) => source_record_id.endsWith(":901"));
    const rejectReview = reviews.results.find(({ source_record_id }) => source_record_id.endsWith(":902"));
    if (!verifyReview || !rejectReview) throw new Error("Expected both replay candidate reviews");
    const verifyResponse = await worker.fetch(`http://localhost/api/reviews/${verifyReview.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Synthetic current-label replay verification",
        evidenceUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/901.jpg",
      }),
    });
    expect(verifyResponse.status).toBe(200);
    const rejectResponse = await worker.fetch(`http://localhost/api/reviews/${rejectReview.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject_nutrition", rationale: "Synthetic candidate rejection" }),
    });
    expect(rejectResponse.status).toBe(200);

    const source = await env.DB.prepare("SELECT product_id FROM source_records WHERE source_record_id = '8900000000012:901'")
      .first<{ product_id: string }>();
    if (!source?.product_id) throw new Error("Expected replay source product");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM nutrition_facts WHERE product_id = ?").bind(source.product_id),
      env.DB.prepare("DELETE FROM nutrient_values WHERE product_id = ? AND source_record_id IN (SELECT id FROM source_records WHERE source_id = 'open_food_facts_robotoff')").bind(source.product_id),
      env.DB.prepare("DELETE FROM field_observations WHERE product_id = ? AND field_path LIKE 'nutrition.%'").bind(source.product_id),
      env.DB.prepare("DELETE FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition'").bind(source.product_id),
    ]);
    await applyQueries(env.TEST_ROBOTOFF_REPLAY_QUERIES);

    const reconstructed = await env.DB.prepare(`SELECT status, confidence, authority, calories, protein_grams,
      carbohydrate_grams, fat_grams, label_verified_at FROM nutrition_facts WHERE product_id = ?`)
      .bind(source.product_id).first<Record<string, unknown>>();
    expect(reconstructed).toMatchObject({
      status: "verified",
      confidence: "high",
      authority: 100,
      calories: 365,
      protein_grams: 25,
      carbohydrate_grams: 46.5,
      fat_grams: 8.9,
    });
    expect(reconstructed?.label_verified_at).toEqual(expect.any(String));
    const unresolved = await env.DB.prepare(`SELECT COUNT(*) AS count FROM review_items r
      JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_record_id IN ('8900000000012:901', '8900000000012:902') AND r.status = 'open'`)
      .first<{ count: number }>();
    expect(unresolved?.count).toBe(0);
    const decisions = await env.DB.prepare(`SELECT decision, COUNT(*) AS count FROM evidence_decisions
      WHERE source_record_key IN ('8900000000012:901', '8900000000012:902') GROUP BY decision ORDER BY decision`)
      .all<{ decision: string; count: number }>();
    expect(decisions.results).toEqual([{ decision: "reject", count: 1 }, { decision: "verify", count: 1 }]);

    await applyQueries(env.TEST_ROBOTOFF_DRIFT_QUERIES);
    const drifted = await env.DB.prepare(`SELECT r.status, r.evidence_json FROM review_items r
      JOIN source_records s ON s.id = r.source_record_id
      WHERE s.source_record_id = '8900000000012:901' AND r.status = 'open' ORDER BY r.created_at DESC LIMIT 1`)
      .first<{ status: string; evidence_json: string }>();
    expect(drifted?.status).toBe("open");
    const driftEvidence = JSON.parse(drifted?.evidence_json ?? "null") as { details?: { candidateHash?: string } };
    const oldHash = await env.DB.prepare("SELECT candidate_hash FROM evidence_decisions WHERE source_record_key = '8900000000012:901'")
      .first<{ candidate_hash: string }>();
    expect(driftEvidence.details?.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(driftEvidence.details?.candidateHash).not.toBe(oldHash?.candidate_hash);
    const staleFact = await env.DB.prepare("SELECT status, label_verified_at FROM nutrition_facts WHERE product_id = ?")
      .bind(source.product_id).first<{ status: string; label_verified_at: string | null }>();
    expect(staleFact).toEqual({ status: "conflict", label_verified_at: null });
    const staleOutcome = await env.DB.prepare("SELECT COUNT(*) AS count FROM evidence_outcomes WHERE product_id = ? AND field_family = 'nutrition'")
      .bind(source.product_id).first<{ count: number }>();
    expect(staleOutcome?.count).toBe(0);
  });

  it("fails closed when Robotoff review evidence is incomplete", async () => {
    const review = await insertRobotoffReview({
      suffix: "invalid",
      evidence: { code: "robotoff_nutrition_candidate", details: { candidate: { minimumConfidence: 0.99 } } },
    });
    const response = await worker.fetch(`http://localhost/api/reviews/${review.reviewId}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "verify_nutrition",
        rationale: "Attempted verification",
        evidenceUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
      }),
    });
    expect(response.status).toBe(400);
    const stillOpen = await env.DB.prepare("SELECT status FROM review_items WHERE id = ?").bind(review.reviewId).first<{ status: string }>();
    expect(stillOpen?.status).toBe("open");
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
