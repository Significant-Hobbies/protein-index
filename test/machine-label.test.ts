import { describe, expect, it } from "vitest";
import { decideMachineLabelEvidence, parseVisionNutrition, type ModelResult, type VisionResult } from "../scripts/machine-label";

const vision = (lines: string[]): VisionResult => ({
  engine: "macos_vision",
  version: "test",
  lines: lines.map((text) => ({ text, confidence: 0.99, boundingBox: { x: 0.05, y: 0.1, width: 0.8, height: 0.04 } })),
});

const model = (overrides: Partial<ModelResult> = {}): ModelResult => ({
  model: "qwen3-vl:32b-instruct",
  digest: "sha256:test",
  promptHash: "a".repeat(64),
  raw: "{}",
  basis: "per_100g",
  servingSizeGrams: null,
  nutrition: { calories: 173, proteinGrams: 1.9, carbohydrateGrams: 40.1, sugarGrams: 35.3, fatGrams: 0.5, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null },
  ingredientsRaw: null,
  unreadableFields: [],
  ...overrides,
});

describe("machine label extraction acceptance", () => {
  it("parses a visible per-100g nutrition table without treating kJ as kcal", () => {
    const parsed = parseVisionNutrition(vision([
      "NUTRITION Typical values per 100g:",
      "Energy 733kJ/173kcal • Fat 0.5g",
      "Carbohydrate 40.1g, of which sugars 35.3g",
      "Protein 1.9g",
    ]).lines);
    expect(parsed).toEqual(expect.objectContaining({
      basis: "per_100g",
      nutrition: expect.objectContaining({ calories: 173, proteinGrams: 1.9, carbohydrateGrams: 40.1, sugarGrams: 35.3, fatGrams: 0.5 }),
    }));
  });

  it("parses a vertically laid out nutrition table only when the next value is adjacent", () => {
    const parsed = parseVisionNutrition(vision([
      "APPROXIMATE COMPOSITION (per 100 g)", "Protein (mainly Casein)", "30.00 g", "Total Fat", "14.00 g",
      "Carbohydrate", "48.00", "Total Sugar", "30.00", "Energy Value", "438.00 kcal",
    ]).lines);
    expect(parsed).toEqual(expect.objectContaining({
      basis: "per_100g",
      nutrition: expect.objectContaining({ calories: 438, proteinGrams: 30, carbohydrateGrams: 48, sugarGrams: 30, fatGrams: 14 }),
    }));
  });

  it("uses label-row geometry instead of OCR reading order for multi-column tables", () => {
    const parsed = parseVisionNutrition({
      engine: "macos_vision", version: "test", lines: [
        { text: "Amount Per 100 g Amount Per Serving", confidence: 1, boundingBox: { x: 0.2, y: 0.8, width: 0.7, height: 0.04 } },
        { text: "Energy", confidence: 1, boundingBox: { x: 0.02, y: 0.75, width: 0.1, height: 0.03 } },
        { text: "359.34 kcal", confidence: 1, boundingBox: { x: 0.26, y: 0.745, width: 0.18, height: 0.04 } },
        { text: "125.77 kcal", confidence: 1, boundingBox: { x: 0.59, y: 0.745, width: 0.18, height: 0.04 } },
        { text: "Protein", confidence: 1, boundingBox: { x: 0.03, y: 0.32, width: 0.1, height: 0.035 } },
        { text: "1.37 g", confidence: 1, boundingBox: { x: 0.35, y: 0.355, width: 0.1, height: 0.04 } },
        { text: "68.57 g", confidence: 1, boundingBox: { x: 0.325, y: 0.312, width: 0.13, height: 0.04 } },
      ],
    }.lines);
    expect(parsed).toEqual(expect.objectContaining({
      basis: "per_100g",
      nutrition: expect.objectContaining({ calories: 359.34, proteinGrams: 68.57 }),
    }));
  });

  it("recognizes a split per-100g column header only when its words are spatially adjacent", () => {
    const parsed = parseVisionNutrition({
      engine: "macos_vision", version: "test", lines: [
        { text: "Per", confidence: 1, boundingBox: { x: 0.45, y: 0.72, width: 0.05, height: 0.03 } },
        { text: "100 g", confidence: 1, boundingBox: { x: 0.45, y: 0.68, width: 0.08, height: 0.04 } },
        { text: "Energy (kcal)", confidence: 1, boundingBox: { x: 0.16, y: 0.64, width: 0.18, height: 0.03 } },
        { text: "378", confidence: 1, boundingBox: { x: 0.46, y: 0.64, width: 0.05, height: 0.03 } },
        { text: "Protein (g)", confidence: 1, boundingBox: { x: 0.16, y: 0.59, width: 0.14, height: 0.03 } },
        { text: "26.1", confidence: 1, boundingBox: { x: 0.46, y: 0.59, width: 0.06, height: 0.03 } },
      ],
    }.lines);
    expect(parsed).toMatchObject({ basis: "per_100g", nutrition: { calories: 378, proteinGrams: 26.1 } });
  });

  it("accepts matching, physically valid core nutrition while preserving missing optional fields", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["NUTRITION Typical values per 100g:", "Energy 733kJ/173kcal • Fat 0.5g", "Carbohydrate 40.1g, of which sugars 35.3g", "Protein 1.9g"]),
      model: model(),
    });
    expect(result.nutrition).toMatchObject({ accepted: true, reasons: [], nutrition: expect.objectContaining({ calories: 173, proteinGrams: 1.9 }) });
  });

  it("normalizes matching per-serving values only when both extractors declare the same serving mass", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["Serving Size: 20g, Nutritional Facts (per serve): Energy (kcal) 93, Protein (g) 5.0, Total Fat (g) 5.1"]),
      model: model({ basis: "per_serving", servingSizeGrams: 20, nutrition: { calories: 93, proteinGrams: 5, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null } }),
    });
    expect(result.nutrition.reasons).toEqual([]);
    expect(result.nutrition).toMatchObject({ accepted: true, basis: "per_100g", nutrition: { calories: 465, proteinGrams: 25 } });
  });

  it("accepts matching per-100g and per-serving columns after normalization", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["Nutritional information per 100 g: Energy 359.34 kcal, Protein 68.57 g"]),
      model: model({ basis: "per_serving", servingSizeGrams: 35, nutrition: { calories: 125.77, proteinGrams: 24, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null } }),
    });
    expect(result.nutrition).toMatchObject({ accepted: true, reasons: [], basis: "per_100g", nutrition: { calories: expect.closeTo(359.34), proteinGrams: expect.closeTo(68.57) } });
  });

  it("accepts a multi-column panel when the visible protein row corroborates the normalized model value", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["Nutritional values per 100 g", "Energy", "366.17 kcal", "128.16 kcal", "Protein", "0.00 g", "68.57 g", "24.00 g"]),
      model: model({ basis: "per_serving", servingSizeGrams: 35, nutrition: { calories: 128.16, proteinGrams: 24, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null } }),
    });
    expect(result.nutrition).toMatchObject({ accepted: true, reasons: [], basis: "per_100g", nutrition: { calories: expect.closeTo(366.17), proteinGrams: expect.closeTo(68.57) } });
  });

  it("recovers the common OCR typo in a per-serving size declaration", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["Serving sioe: 40 g", "Nutrients per serving: Energy 146 kcal, Protein 10.0 g"]),
      model: model({ basis: "per_serving", servingSizeGrams: 40, nutrition: { calories: 146, proteinGrams: 10, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null } }),
    });
    expect(result.nutrition).toMatchObject({ accepted: true, reasons: [], basis: "per_100g", nutrition: { calories: 365, proteinGrams: 25 } });
  });

  it("recovers a parenthesized serving mass split below the serving-size heading", () => {
    const parsed = parseVisionNutrition(vision(["Serving size 1 bar", "Serving size per pack", "(45)", "1", "Nutrients per serving: Energy 198 kcal, Protein 10.1 g"]).lines);
    expect(parsed).toMatchObject({ basis: "per_serving", servingSizeGrams: 45, nutrition: { calories: 198, proteinGrams: 10.1 } });
  });

  it("recovers the gram suffix from a parenthesized serving mass", () => {
    const parsed = parseVisionNutrition(vision(["Serving Size: 1 heaping scoop (34g)", "Nutrients per serving: Energy 126 kcal, Protein 30.15 g"]).lines);
    expect(parsed).toMatchObject({ basis: "per_serving", servingSizeGrams: 34, nutrition: { calories: 126, proteinGrams: 30.15 } });
  });

  it("does not publish an optional field unless both extractors agree", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["NUTRITION Typical values per 100g:", "Energy 733kJ/173kcal • Fat 0.5g", "Protein 1.9g", "Saturated fat <0.1g"]),
      model: model({ nutrition: { ...model().nutrition, saturatedFatGrams: 0.1 } }),
    });
    expect(result.nutrition).toMatchObject({ accepted: true, nutrition: { calories: 173, proteinGrams: 1.9, saturatedFatGrams: null } });
  });

  it("rejects a model that confuses kJ with kcal", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["NUTRITION Typical values per 100g:", "Energy 733kJ/173kcal", "Protein 1.9g"]),
      model: model({ nutrition: { ...model().nutrition, calories: 733 } }),
    });
    expect(result.nutrition).toMatchObject({ accepted: false });
    expect(result.nutrition.reasons).toContain("core_calories_disagreement");
  });

  it("rejects incomplete or conflicting ingredients instead of publishing inferred wording", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["INGREDIENTS: Casein, Sucrose, Edible Vegetable", "Solids, Bengal Gram", "CONTAINS: Soy"]),
      model: model({ ingredientsRaw: "Casein, Sucrose, Edible Vegetable Fat Solids, Bengal Gram." }),
    });
    expect(result.ingredients).toMatchObject({ accepted: false, ingredientsRaw: null });
    expect(result.ingredients.reasons).toContain("ingredient_extractor_disagreement");
  });

  it("accepts a complete visible ingredient declaration bounded by a disclaimer heading", () => {
    const result = decideMachineLabelEvidence({
      vision: vision(["INGREDIENTS: Chamomile Flowers", "Disclaimer: This product is not medicine."]),
      model: model({ ingredientsRaw: "Chamomile Flowers" }),
    });
    expect(result.ingredients).toMatchObject({ accepted: true, ingredientsRaw: "Chamomile Flowers" });
  });
});
