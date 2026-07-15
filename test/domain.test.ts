import { describe, expect, it } from "vitest";
import { identityEvidenceHash } from "../scripts/reconcile";
import { classifyProtein } from "../shared/classification";
import { resolveIdentity } from "../shared/entity-resolution";
import { hasValidGtinCheckDigit, normalizeGtin, normalizeText, parseQuantity } from "../shared/gtin";
import { parseAdditives, parseAllergens, parseIngredients } from "../shared/ingredients";
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
    expect(validateNutrition(impossible).map(({ code }) => code)).toEqual(expect.arrayContaining(["nutrient_over_100g", "macro_total_impossible", "calorie_macro_mismatch"]));
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
  it("preserves ordered compound ingredients and percentages", () => {
    const parsed = parseIngredients("Whey blend 70% (concentrate, isolate), cocoa 8%, flavour");
    expect(parsed.map(({ normalizedName }) => normalizedName)).toEqual(["whey blend", "cocoa", "flavour"]);
    expect(parsed[0]?.percentage).toBe(70);
    expect(parsed[0]?.children.map(({ normalizedName }) => normalizedName)).toEqual(["concentrate", "isolate"]);
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
