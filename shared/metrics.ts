import type { MetricResult, NutritionPer100g, ProductMetrics } from "./types";
import { hasProteinEnergyConflict } from "./nutrition";

const unavailable = (reason: string): MetricResult => ({ value: null, reason });
const available = (value: number): MetricResult => ({ value, reason: null });

function ratio(numerator: number | null, denominator: number | null, multiplier: number, reason: string): MetricResult {
  if (numerator === null || denominator === null) return unavailable(reason);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator < 0 || denominator <= 0) {
    return unavailable("invalid_input");
  }
  return available((numerator / denominator) * multiplier);
}

export function calculateMetrics(input: {
  nutrition: NutritionPer100g;
  nutritionBasis: "per_100g" | "per_100ml" | "per_serving" | "unknown";
  netQuantityGrams: number | null;
  servingSizeGrams: number | null;
  sellingPrice: number | null;
}): ProductMetrics {
  const { nutrition, nutritionBasis, netQuantityGrams, servingSizeGrams, sellingPrice } = input;
  const massNormalized = nutritionBasis === "per_100g";
  const proteinEnergyConflict = hasProteinEnergyConflict(nutrition);
  const proteinPer100Calories = proteinEnergyConflict
    ? unavailable("protein_energy_exceeds_total")
    : ratio(nutrition.proteinGrams, nutrition.calories, 100, "missing_protein_or_calories");
  const proteinCaloriePercentage = proteinEnergyConflict
    ? unavailable("protein_energy_exceeds_total")
    : ratio(
        nutrition.proteinGrams === null ? null : nutrition.proteinGrams * 4,
        nutrition.calories,
        100,
        "missing_protein_or_calories",
      );
  const totalProtein =
    massNormalized && nutrition.proteinGrams !== null && netQuantityGrams !== null && netQuantityGrams > 0
      ? available((netQuantityGrams * nutrition.proteinGrams) / 100)
      : unavailable(massNormalized ? "missing_protein_or_pack_weight" : "nutrition_basis_not_mass_normalized");
  const costPer25 = ratio(sellingPrice, totalProtein.value, 25, "missing_price_or_pack_protein");
  const proteinPerInr100 = ratio(totalProtein.value, sellingPrice, 100, "missing_price_or_pack_protein");
  const caloriesFor25 = proteinEnergyConflict
    ? unavailable("protein_energy_exceeds_total")
    : ratio(nutrition.calories, nutrition.proteinGrams, 25, "missing_protein_or_calories");
  const sugarPer25 = ratio(nutrition.sugarGrams, nutrition.proteinGrams, 25, "missing_sugar_or_protein");
  const saturatedFatPer25 = ratio(
    nutrition.saturatedFatGrams,
    nutrition.proteinGrams,
    25,
    "missing_saturated_fat_or_protein",
  );
  const fibrePer100Calories = ratio(nutrition.fibreGrams, nutrition.calories, 100, "missing_fibre_or_calories");
  const servings =
    massNormalized && netQuantityGrams !== null && servingSizeGrams !== null && servingSizeGrams > 0
      ? netQuantityGrams / servingSizeGrams
      : null;
  const pricePerServing = servings === null && !massNormalized
    ? unavailable("nutrition_basis_not_mass_normalized")
    : ratio(sellingPrice, servings, 1, "missing_price_or_serving_data");

  return {
    proteinPer100Calories,
    proteinCaloriePercentage,
    costPer25gProtein: costPer25,
    proteinPerInr100,
    caloriesFor25gProtein: caloriesFor25,
    sugarPer25gProtein: sugarPer25,
    saturatedFatPer25gProtein: saturatedFatPer25,
    fibrePer100Calories,
    pricePerServing,
    totalProteinInPack: totalProtein,
  };
}

export function calculateCompleteness(input: Record<string, unknown>): { score: number; missing: string[] } {
  const required = ["gtin", "brand", "name", "netQuantityGrams", "nutrition", "ingredients", "evidence", "offer"];
  const missing = required.filter((key) => input[key] === null || input[key] === undefined || input[key] === "");
  return { score: Math.round(((required.length - missing.length) / required.length) * 100), missing };
}
