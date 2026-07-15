import { describe, expect, it } from "vitest";
import { initialFilters, metricEvidenceLabel, reviewIngredientCandidate, reviewNutritionCandidate } from "../src/App";
import {
  canonicalJson,
  nutritionCandidateFromEvidence,
  nutritionCandidateHash,
  validateEvidenceDecision,
} from "../shared/evidence-decisions";
import { identityEvidenceHash } from "../scripts/reconcile";
import { classifyProtein } from "../shared/classification";
import { resolveIdentity } from "../shared/entity-resolution";
import {
  ingredientCandidateHash,
  ingredientCandidateFromEvidence,
  ingredientCandidatesConflict,
  ingredientCandidateWarnings,
  validateIngredientEvidenceDecision,
  validateIngredientCandidate,
  type IngredientCandidate,
} from "../shared/ingredient-evidence";
import { hasValidGtinCheckDigit, normalizeGtin, normalizeText, parseQuantity } from "../shared/gtin";
import { invalidIngredientPercentages, parseAdditives, parseAllergens, parseIngredients } from "../shared/ingredients";
import { calculateCompleteness, calculateMetrics } from "../shared/metrics";
import { emptyNutrition, nextEvidenceStatus, normalizePerServing, validateNutrition } from "../shared/nutrition";
import type { NutritionEvidence } from "../shared/types";

const verifiedNutrition: NutritionEvidence = {
  per100g: {
    calories: 360,
    proteinGrams: 52,
    carbohydrateGrams: 20,
    sugarGrams: 4,
    fatGrams: 8,
    saturatedFatGrams: 3,
    fibreGrams: 6,
    sodiumMg: 250,
  },
  servingSizeGrams: 50,
  basis: "per_100g",
  preparationState: "as_sold",
  status: "verified",
  confidence: "high",
  source: "label",
  observedAt: "2026-07-15T00:00:00.000Z",
  labelVerifiedAt: "2026-07-15T00:00:00.000Z",
};

describe("GTIN and identity normalization", () => {
  it("invalidates durable decisions only when normalized identity evidence changes", () => {
    const identity = { gtin: null, brand: "Atlas Test Foods", name: "High Protein Whey Blend", flavour: null, netQuantityGrams: null };
    expect(identityEvidenceHash(identity)).toBe(identityEvidenceHash({ ...identity, brand: "  ATLAS test foods " }));
    expect(identityEvidenceHash(identity)).not.toBe(identityEvidenceHash({ ...identity, netQuantityGrams: 500 }));
    expect(identityEvidenceHash(identity)).not.toBe(identityEvidenceHash({ ...identity, name: "High Protein Whey Isolate" }));
  });

  it("validates and normalizes supported GTIN representations", () => {
    expect(hasValidGtinCheckDigit("8900000000012")).toBe(true);
    expect(normalizeGtin("8900-0000-0001-2")).toBe("08900000000012");
    expect(normalizeGtin("8900000000013")).toBeNull();
  });

  it("normalizes text and mass without confusing liquid volume", () => {
    expect(normalizeText("  Café & Whey™  ")).toBe("cafe and whey");
    expect(parseQuantity("Net wt. 1.5 kg")?.grams).toBe(1500);
    expect(parseQuantity("250 ml")?.grams).toBeNull();
  });

  it("resolves exact GTIN before conservative composite identity", () => {
    const candidates = [
      { id: "a", gtin: "08900000000012", brand: "Atlas", name: "Whey", flavour: "Cocoa", netQuantityGrams: 1000 },
      { id: "b", gtin: null, brand: "Atlas", name: "Whey", flavour: "Vanilla", netQuantityGrams: 1000 },
    ];
    expect(resolveIdentity({ ...candidates[0]!, id: "incoming" }, candidates)).toEqual({ kind: "match", productId: "a", rule: "exact_gtin" });
    expect(resolveIdentity({ id: "incoming", gtin: null, brand: "Atlas", name: "Whey", flavour: null, netQuantityGrams: 1000 }, candidates)).toEqual({ kind: "new", reason: "insufficient_exact_identity" });
  });
});

describe("nutrition accuracy and classification", () => {
  it("rejects impossible nutrition and flags calorie disagreement", () => {
    const impossible = { ...emptyNutrition(), calories: 100, proteinGrams: 120, carbohydrateGrams: 20, fatGrams: 5 };
    expect(validateNutrition(impossible).map(({ code }) => code)).toEqual(expect.arrayContaining(["nutrient_over_100g", "protein_energy_exceeds_total", "macro_total_impossible", "calorie_macro_mismatch"]));
    expect(validateNutrition({ ...emptyNutrition(), calories: 0.25, proteinGrams: 10.8 })).toContainEqual(expect.objectContaining({ code: "protein_energy_exceeds_total", severity: "error" }));
    expect(validateNutrition({ ...emptyNutrition(), calories: 274, proteinGrams: 15.9, fatGrams: 69.1 })).toContainEqual(expect.objectContaining({ code: "macro_energy_exceeds_total", severity: "error" }));
    expect(validateNutrition({ ...emptyNutrition(), calories: 33, proteinGrams: 8.59, carbohydrateGrams: 28.1, fatGrams: 1.2 })).toContainEqual(expect.objectContaining({ code: "calorie_macro_mismatch", severity: "error" }));
  });

  it("normalizes a per-serving label only when serving mass exists", () => {
    const perServing = { ...emptyNutrition(), calories: 180, proteinGrams: 26 };
    expect(normalizePerServing(perServing, null)).toBeNull();
    expect(normalizePerServing(perServing, 50)?.proteinGrams).toBe(52);
  });

  it("does not treat successfully parsed community nutrition as verified", () => {
    expect(nextEvidenceStatus({ current: "missing", incomingVerified: false, conflictsWithSelected: false })).toBe("unverified");
    expect(nextEvidenceStatus({ current: "verified", incomingVerified: false, conflictsWithSelected: true })).toBe("conflict");
  });

  it("keeps marketing and nutritional cohorts independent", () => {
    const denseSoy = classifyProtein({ name: "Soya Chunks", categories: "soy foods", labels: "", nutrition: verifiedNutrition });
    expect(denseSoy.marketed).toBe(false);
    expect(denseSoy.nutritionallyDense).toBe(true);
    const unverified = classifyProtein({ name: "High Protein Cereal", categories: "cereal", labels: "high protein", nutrition: { ...verifiedNutrition, status: "unverified" } });
    expect(unverified.marketed).toBe(true);
    expect(unverified.nutritionallyDense).toBeNull();
  });
});

describe("metrics and completeness", () => {
  it("defaults the dashboard to evidence-aware protein density", () => {
    expect(initialFilters).toEqual({ q: "", category: "all", verification: "all", scope: "all", sort: "protein_density" });
    expect(metricEvidenceLabel("unverified")).toBe("unverified nutrition");
    expect(metricEvidenceLabel("verified")).toBe("verified nutrition");
  });

  it("parses only complete Robotoff nutrition review evidence for the operator UI", () => {
    const candidate = reviewNutritionCandidate({
      code: "robotoff_nutrition_candidate",
      details: {
        candidate: {
          predictionId: "prediction-1",
          imageId: "image-1",
          imageUrl: "https://images.openfoodfacts.org/label.jpg",
          modelName: "nutrition_extractor",
          modelVersion: "nutrition_extractor-2.0",
          observedAt: "2026-07-15T00:00:00.000Z",
          basis: "per_100g",
          minimumConfidence: 0.94,
          nutritionPer100g: {
            calories: 400,
            proteinGrams: 40,
            carbohydrateGrams: 30,
            sugarGrams: 5,
            fatGrams: 10,
            saturatedFatGrams: 3,
            fibreGrams: 4,
            sodiumMg: 250,
          },
        },
      },
    });
    expect(candidate).toMatchObject({
      imageUrl: "https://images.openfoodfacts.org/label.jpg",
      minimumConfidence: 0.94,
      nutritionPer100g: { calories: 400, proteinGrams: 40 },
    });
    expect(reviewNutritionCandidate({ code: "robotoff_nutrition_candidate", details: { candidate: { imageUrl: "javascript:alert(1)" } } })).toBeNull();
    expect(reviewNutritionCandidate({ code: "robotoff_image_conflict" })).toBeNull();
  });

  it("parses complete ingredient evidence for side-by-side review and rejects unsafe images", () => {
    const evidence = {
      code: "robotoff_ingredient_candidate",
      details: {
        candidateHash: "a".repeat(64),
        hasConflict: true,
        warnings: [{ code: "low_language_confidence", message: "Check the detected language." }],
        candidate: {
          predictionId: "ingredient-1",
          entityIndex: 0,
          imageId: "label-1",
          imageUrl: "https://images.openfoodfacts.org/ingredient.jpg",
          modelName: "ingredient_detection",
          modelVersion: "ingredient-detection-1.0",
          predictedAt: "2026-07-15T01:00:00.000Z",
          observedAt: "2026-07-15T00:00:00.000Z",
          entityText: "Defatted soy flour 100%",
          entityConfidence: 0.99,
          language: { code: "en", confidence: 0.8 },
          boundingBox: [1, 2, 300, 900],
          parsedIngredients: [{ text: "Defatted soy flour", in_taxonomy: true }],
          ingredientCount: 1,
          knownIngredientCount: 1,
          unknownIngredientCount: 0,
        },
      },
    };
    expect(reviewIngredientCandidate(evidence)).toMatchObject({
      entityText: "Defatted soy flour 100%",
      candidateHash: "a".repeat(64),
      hasConflict: true,
      warnings: [{ code: "low_language_confidence" }],
    });
    const unsafe = structuredClone(evidence);
    unsafe.details.candidate.imageUrl = "javascript:alert(1)";
    expect(reviewIngredientCandidate(unsafe)).toBeNull();
    expect(reviewIngredientCandidate({ code: "robotoff_ingredient_candidate", details: { candidateHash: "bad" } })).toBeNull();
  });

  it("hashes the exact canonical candidate and rejects decision drift", async () => {
    const evidence = {
      code: "robotoff_nutrition_candidate",
      details: { candidate: {
        predictionId: "prediction-1",
        barcode: "8900000000012",
        imageId: "image-1",
        imageUrl: "https://images.openfoodfacts.org/label.jpg",
        modelName: "nutrition_extractor",
        modelVersion: "nutrition_extractor-2.0",
        observedAt: "2026-07-15T00:00:00.000Z",
        basis: "per_100g",
        minimumConfidence: 0.94,
        nutritionPer100g: {
          calories: 400, proteinGrams: 40, carbohydrateGrams: 30, sugarGrams: 5,
          fatGrams: 10, saturatedFatGrams: 3, fibreGrams: 4, sodiumMg: 250,
        },
      } },
    };
    const candidate = nutritionCandidateFromEvidence(evidence, "08900000000012");
    expect(candidate).not.toBeNull();
    if (!candidate) throw new Error("Expected a candidate");
    const candidateHash = await nutritionCandidateHash(candidate);
    expect(candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    const decision = {
      id: "evd_test",
      sourceId: "open_food_facts_robotoff",
      sourceRecordKey: "08900000000012:prediction-1",
      sourceRecordId: "src_test",
      sourceContentHash: "source_hash",
      productId: "prd_test",
      candidateHash,
      fieldFamily: "nutrition" as const,
      decision: "verify" as const,
      payload: candidate,
      evidenceUrl: candidate.imageUrl,
      rationale: "Exact current label reviewed",
      decidedBy: "local_operator",
      decidedAt: "2026-07-15T01:00:00.000Z",
    };
    expect(await validateEvidenceDecision(decision)).toEqual([]);
    expect(await validateEvidenceDecision({ ...decision, candidateHash: "0".repeat(64) }))
      .toContain("candidateHash does not match payload");
  });

  it("calculates the named protein formulas independently", () => {
    const result = calculateMetrics({
      nutrition: verifiedNutrition.per100g,
      netQuantityGrams: 500,
      servingSizeGrams: 50,
      sellingPrice: 250,
    });
    expect(result.proteinPer100Calories.value).toBeCloseTo(14.444, 3);
    expect(result.proteinCaloriePercentage.value).toBeCloseTo(57.778, 3);
    expect(result.totalProteinInPack.value).toBe(260);
    expect(result.costPer25gProtein.value).toBeCloseTo(24.038, 3);
  });

  it("returns explicit unavailable reasons instead of infinity", () => {
    const result = calculateMetrics({
      nutrition: { ...emptyNutrition(), calories: 100, proteinGrams: 0 },
      netQuantityGrams: 100,
      servingSizeGrams: null,
      sellingPrice: 50,
    });
    expect(result.caloriesFor25gProtein).toEqual({ value: null, reason: "invalid_input" });
    expect(result.pricePerServing.reason).toBe("missing_price_or_serving_data");
  });

  it("names completeness gaps", () => {
    expect(calculateCompleteness({ gtin: "x", brand: "b", name: "n" })).toEqual({
      score: 38,
      missing: ["netQuantityGrams", "nutrition", "ingredients", "evidence", "offer"],
    });
  });
});

describe("ingredient intelligence", () => {
  const ingredientCandidate: IngredientCandidate = {
    predictionId: "10477207",
    entityIndex: 0,
    barcode: "0001241000224",
    imageId: "2",
    imageUrl: "https://images.openfoodfacts.org/images/products/000/124/100/0224/2.jpg",
    modelName: "ingredient_detection",
    modelVersion: "ingredient-detection-1.0",
    predictedAt: "2024-08-12T15:45:02.473405Z",
    observedAt: "2024-08-10T04:07:50.000Z",
    entityText: "Casein, Sucrose, Precooked Rice Flour, Bengal Gram.",
    entityConfidence: 0.99999,
    language: { code: "en", confidence: 0.61748207 },
    boundingBox: [52, 79, 305, 1568],
    parsedIngredients: [
      { id: "en:casein", text: "Casein", in_taxonomy: true },
      { id: "en:bengal-gram", text: "Bengal Gram", in_taxonomy: false },
    ],
    ingredientCount: 4,
    knownIngredientCount: 2,
    unknownIngredientCount: 2,
  };

  it("validates and hashes immutable ingredient candidates", async () => {
    expect(validateIngredientCandidate(ingredientCandidate, { expectedGtin: "00001241000224" })).toEqual([]);
    const hash = await ingredientCandidateHash(ingredientCandidate);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await ingredientCandidateHash({ ...ingredientCandidate, barcode: "00001241000224" })).toBe(hash);
    expect(await ingredientCandidateHash({ ...ingredientCandidate, entityText: `${ingredientCandidate.entityText} Salt.` })).not.toBe(hash);
  });

  it("parses only complete ingredient candidates from review evidence", () => {
    const evidence = { code: "robotoff_ingredient_candidate", details: { candidate: ingredientCandidate } };
    expect(ingredientCandidateFromEvidence(evidence, "00001241000224")).toMatchObject({
      predictionId: "10477207",
      entityText: ingredientCandidate.entityText,
    });
    expect(ingredientCandidateFromEvidence({ code: "robotoff_ingredient_candidate", details: { candidate: { ...ingredientCandidate, imageUrl: "javascript:alert(1)" } } }, "00001241000224")).toBeNull();
    expect(ingredientCandidateFromEvidence({ code: "robotoff_nutrition_candidate", details: { candidate: ingredientCandidate } }, "00001241000224")).toBeNull();
  });

  it("validates exact, corrected, and rejected ingredient decisions", async () => {
    const candidateHash = await ingredientCandidateHash(ingredientCandidate);
    const decision = {
      id: "evd_ingredient",
      sourceId: "open_food_facts_robotoff_ingredients",
      sourceRecordKey: "00001241000224:10477207:0",
      sourceRecordId: "src_ingredient",
      sourceContentHash: "source_hash",
      productId: "prd_ingredient",
      candidateHash,
      fieldFamily: "ingredients" as const,
      decision: "verify" as const,
      payload: {
        candidate: ingredientCandidate,
        reviewedText: ingredientCandidate.entityText,
        normalizedIngredients: parseIngredients(ingredientCandidate.entityText),
      },
      evidenceUrl: ingredientCandidate.imageUrl,
      rationale: "Exact current ingredient label reviewed",
      decidedBy: "local_operator",
      decidedAt: "2026-07-16T00:00:00.000Z",
    };
    expect(await validateIngredientEvidenceDecision(decision)).toEqual([]);
    expect(await validateIngredientEvidenceDecision({
      ...decision,
      payload: {
        ...decision.payload,
        reviewedText: "Casein, Sucrose, Precooked Rice Flour, Edible Vegetable Fat Solids, Bengal Gram.",
        normalizedIngredients: parseIngredients("Casein, Sucrose, Precooked Rice Flour, Edible Vegetable Fat Solids, Bengal Gram."),
      },
      rationale: "Corrected visible OCR errors against the current label",
    })).toEqual([]);
    expect(await validateIngredientEvidenceDecision({
      ...decision,
      decision: "reject",
      payload: { ...decision.payload, reviewedText: null, normalizedIngredients: [] },
    })).toEqual([]);
    expect(await validateIngredientEvidenceDecision({ ...decision, candidateHash: "0".repeat(64) }))
      .toContain("candidateHash does not match payload");
    expect(await validateIngredientEvidenceDecision({ ...decision, evidenceUrl: "https://example.com/label.jpg" }))
      .toContain("evidenceUrl must match the candidate label image");
    expect(await validateIngredientEvidenceDecision({ ...decision, payload: { ...decision.payload, reviewedText: null, normalizedIngredients: [] } }))
      .toContain("verify decisions require bounded reviewer-confirmed text");
    expect(await validateIngredientEvidenceDecision({
      ...decision,
      payload: { ...decision.payload, reviewedText: "Milk solids 500%", normalizedIngredients: parseIngredients("Milk solids 500%") },
      rationale: "Corrected invalid text against the label",
    })).toContain("reviewedText contains an invalid ingredient percentage");
  });

  it("rejects malformed, low-confidence, and identity-mismatched candidates", () => {
    expect(validateIngredientCandidate(
      { ...ingredientCandidate, imageUrl: "https://example.com/label.jpg" },
      { expectedGtin: "00001241000224" },
    )).toContain("imageUrl must be an official Open Food Facts HTTPS image");
    expect(validateIngredientCandidate(
      { ...ingredientCandidate, entityConfidence: 0.84 },
      { expectedGtin: "00001241000224", confidenceThreshold: 0.85 },
    )).toContain("entityConfidence is outside the admitted range");
    expect(validateIngredientCandidate(
      { ...ingredientCandidate, barcode: "8900000000012" },
      { expectedGtin: "00001241000224" },
    )).toContain("barcode does not match expectedGtin");
    expect(validateIngredientCandidate(
      { ...ingredientCandidate, ingredientCount: 5 },
      { expectedGtin: "00001241000224" },
    )).toContain("ingredient counts do not reconcile");
  });

  it("keeps duplicate text stable and flags materially conflicting text", () => {
    expect(ingredientCandidatesConflict([
      ingredientCandidate,
      { ...ingredientCandidate, imageId: "3", entityText: `  ${ingredientCandidate.entityText.toUpperCase()}  ` },
    ])).toBe(false);
    expect(ingredientCandidatesConflict([
      ingredientCandidate,
      { ...ingredientCandidate, imageId: "3", entityText: "Casein, Sucrose, Peanut Flour." },
    ])).toBe(true);
  });

  it("surfaces low taxonomy and language confidence as review warnings", () => {
    expect(ingredientCandidateWarnings({
      ...ingredientCandidate,
      language: { code: "en", confidence: 0.4 },
      ingredientCount: 8,
      knownIngredientCount: 3,
      unknownIngredientCount: 5,
    }).map(({ code }) => code)).toEqual(["low_language_confidence", "low_taxonomy_recognition"]);
  });

  it("preserves ordered compound ingredients and percentages", () => {
    const parsed = parseIngredients("Whey blend 70% (concentrate, isolate), cocoa 8%, flavour");
    expect(parsed.map(({ normalizedName }) => normalizedName)).toEqual(["whey blend", "cocoa", "flavour"]);
    expect(parsed[0]?.percentage).toBe(70);
    expect(parsed[0]?.children.map(({ normalizedName }) => normalizedName)).toEqual(["concentrate", "isolate"]);
  });

  it("keeps impossible percentages in raw evidence but not normalized values", () => {
    const parsed = parseIngredients("Milk solids, raising agents (500%)");
    expect(parsed[1]?.percentage).toBeNull();
    expect(parsed[1]?.children[0]?.raw).toBe("500%");
    expect(invalidIngredientPercentages("Milk solids, raising agents (500%)")).toEqual([500]);
  });

  it("keeps contains, may-contain, and source tags distinct", () => {
    expect(parseAllergens({ contains: "milk", traces: "soy", tags: ["en:peanuts"] })).toEqual([
      { name: "milk", declaration: "contains" },
      { name: "soy", declaration: "may_contain" },
      { name: "peanuts", declaration: "source_tag" },
    ]);
  });

  it("maps declared INS and additive tags without duplicates", () => {
    expect(parseAdditives("Emulsifier INS 322, sweetener 955", ["en:e322"])).toEqual(["INS 322", "INS 955"]);
  });
});
