import { describe, expect, it } from "vitest";
import { machineLabelCandidateForProduct } from "../scripts/machine-label-discovery";
import type { StagedProduct } from "../shared/types";

const product = (overrides: Partial<StagedProduct> = {}): StagedProduct => ({
  source: "open_food_facts", sourceKind: "open_data", sourceAuthority: { identity: 45, nutrition: 40, ingredients: 40 }, sourceLicenseUrl: null, sourceRetentionNotes: "", sourceRecordId: "8900000000012", sourceUrl: null, observedAt: "2026-01-01T00:00:00.000Z", contentHash: "a".repeat(64), gtinRaw: "8900000000012", gtin: "8900000000012", brand: "Acme", name: "Protein Snack", flavour: null, category: "protein_snack", categoryRaw: null, productKind: "retail_packaged", netQuantityGrams: 50, servingSizeGrams: null, imageUrl: null, nutritionImageUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/nutrition_en.3.400.jpg", ingredientImageUrl: null, offers: [], ratings: [], nutrition: { per100g: { calories: null, proteinGrams: null, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null }, servingSizeGrams: null, basis: "per_100g", preparationState: "as_sold", status: "missing", confidence: "medium", source: "open_food_facts", observedAt: "2026-01-01T00:00:00.000Z", labelVerifiedAt: null }, nutrients: [], ingredients: { raw: null, language: null, normalized: [], allergens: [], additives: [], status: "missing", confidence: "medium", source: "open_food_facts", observedAt: "2026-01-01T00:00:00.000Z" }, classification: { marketed: true, marketedReasons: ["protein"], nutritionallyDense: null, nutritionReasons: [], version: "protein-v1" }, completeness: 0, completenessMissing: [], rawEvidence: {}, validationIssues: [],
  ...overrides,
});

describe("machine label discovery", () => {
  it("queues only protein-branded macro gaps with secure source labels", () => {
    const candidate = machineLabelCandidateForProduct(product());
    expect(candidate).toMatchObject({ source: "open_food_facts", missing: ["calories", "proteinGrams"], label: { sourceImageRevision: "3" } });
  });

  it("does not queue complete macros or arbitrary foods", () => {
    expect(machineLabelCandidateForProduct(product({ nutrition: { ...product().nutrition, per100g: { ...product().nutrition.per100g, calories: 400, proteinGrams: 20 } } }))).toBeNull();
    expect(machineLabelCandidateForProduct(product({ name: "Salt", classification: { ...product().classification, marketed: false, marketedReasons: [] } }))).toBeNull();
    expect(machineLabelCandidateForProduct(product({
      name: "Maida",
      classification: { ...product().classification, marketed: true, marketedReasons: ["protein"], version: "protein-v1" },
    }))).toBeNull();
  });

  it("queues explicitly retained official-brand label evidence through the same fail-closed lane", () => {
    const candidate = machineLabelCandidateForProduct(product({
      source: "protein_chef_india",
      sourceKind: "brand",
      sourceAuthority: { identity: 70, nutrition: 40, ingredients: 40 },
      sourceRecordId: "https://proteinchef.fit/products/snack",
      sourceUrl: "https://proteinchef.fit/products/snack",
      nutritionImageUrl: "https://proteinchef.fit/cdn/shop/files/nivalues_45.png?v=1",
    }));
    expect(candidate).toMatchObject({ source: "official_brand", label: { sourceImageId: "/cdn/shop/files/nivalues_45.png", sourceImageRevision: null } });
  });
});
