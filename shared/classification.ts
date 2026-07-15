import type { NutritionEvidence, ProteinClassification } from "./types";
import { normalizeText } from "./gtin";

export const CLASSIFIER_VERSION = "protein-v1";
const MARKETED_TERMS = [
  "protein",
  "high protein",
  "whey",
  "casein",
  "protein bar",
  "protein chips",
  "protein cereal",
  "protein shake",
  "protein yogurt",
] as const;

export function classifyProtein(input: {
  name: string;
  categories: string;
  labels: string;
  nutrition: NutritionEvidence;
}): ProteinClassification {
  const text = normalizeText(`${input.name} ${input.categories} ${input.labels}`);
  const marketedReasons = MARKETED_TERMS.filter((term) => text.includes(normalizeText(term)));
  const nutritionReasons: string[] = [];
  let nutritionallyDense: boolean | null = null;

  if (input.nutrition.status === "verified") {
    const { calories, proteinGrams } = input.nutrition.per100g;
    if (proteinGrams !== null && calories !== null && calories > 0) {
      const per100Calories = (proteinGrams / calories) * 100;
      const caloriePercentage = ((proteinGrams * 4) / calories) * 100;
      if (per100Calories >= 10) nutritionReasons.push("protein_at_least_10g_per_100kcal");
      if (caloriePercentage >= 20) nutritionReasons.push("protein_at_least_20_percent_calories");
    }
    if (
      proteinGrams !== null &&
      input.nutrition.servingSizeGrams !== null &&
      (proteinGrams * input.nutrition.servingSizeGrams) / 100 >= 10
    ) {
      nutritionReasons.push("protein_at_least_10g_per_serving");
    }
    const sufficient = proteinGrams !== null && calories !== null;
    nutritionallyDense = nutritionReasons.length > 0 ? true : sufficient ? false : null;
  }

  return {
    marketed: marketedReasons.length > 0,
    marketedReasons,
    nutritionallyDense,
    nutritionReasons,
    version: CLASSIFIER_VERSION,
  };
}
