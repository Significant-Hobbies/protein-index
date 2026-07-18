import { describe, expect, it } from "vitest";
import { reclassifyStagedProduct } from "../scripts/reclassify-staged";
import type { StagedProduct } from "../shared/types";

const staged = (overrides: Partial<StagedProduct> = {}): StagedProduct => ({
  source: "open_food_facts", sourceKind: "open_data", sourceAuthority: { identity: 45, nutrition: 40, ingredients: 40 }, sourceLicenseUrl: null, sourceRetentionNotes: "", sourceRecordId: "8900000000012", sourceUrl: null, observedAt: "2026-07-18T00:00:00.000Z", contentHash: "a".repeat(64), gtinRaw: "8900000000012", gtin: "8900000000012", brand: "Acme", name: "Maida", flavour: null, category: "other", categoryRaw: "protein, high protein", productKind: "retail_packaged", netQuantityGrams: null, servingSizeGrams: null, imageUrl: null, nutritionImageUrl: null, ingredientImageUrl: null, offers: [], ratings: [], nutrition: { per100g: { calories: null, proteinGrams: null, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null }, servingSizeGrams: null, basis: "per_100g", preparationState: "as_sold", status: "missing", confidence: "medium", source: "open_food_facts", observedAt: "2026-07-18T00:00:00.000Z", labelVerifiedAt: null }, nutrients: [], ingredients: { raw: null, language: null, normalized: [], allergens: [], additives: [], status: "missing", confidence: "medium", source: "open_food_facts", observedAt: "2026-07-18T00:00:00.000Z" }, classification: { marketed: true, marketedReasons: ["protein"], nutritionallyDense: null, nutritionReasons: [], version: "protein-v1" }, completeness: 0, completenessMissing: [], rawEvidence: { categories: "protein, high protein" }, validationIssues: [],
  ...overrides,
});

describe("staged snapshot reclassification", () => {
  it("retains explicit label marketing while removing category-only marketing", () => {
    expect(reclassifyStagedProduct(staged()).classification).toMatchObject({ marketed: false, version: "protein-v3" });
    expect(reclassifyStagedProduct(staged({ rawEvidence: { categories: "flours", labels: "high protein" } })).classification).toMatchObject({ marketed: true, marketedReasons: ["protein", "high protein"] });
    expect(reclassifyStagedProduct(staged({ brand: "Max Protein", name: "Granola" })).classification).toMatchObject({ marketed: true, marketedReasons: ["protein"] });
  });
});
