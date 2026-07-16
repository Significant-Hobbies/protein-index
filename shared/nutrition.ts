import type { EvidenceStatus, NutritionPer100g, ValidationIssue } from "./types";

const CORE_MACROS = ["proteinGrams", "carbohydrateGrams", "fatGrams"] as const;

export function emptyNutrition(): NutritionPer100g {
  return {
    calories: null,
    proteinGrams: null,
    carbohydrateGrams: null,
    sugarGrams: null,
    fatGrams: null,
    saturatedFatGrams: null,
    fibreGrams: null,
    sodiumMg: null,
  };
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasProteinEnergyConflict(nutrition: NutritionPer100g): boolean {
  return nutrition.calories !== null
    && nutrition.calories > 0
    && nutrition.proteinGrams !== null
    && nutrition.proteinGrams * 4 > nutrition.calories;
}

export function validateNutrition(nutrition: NutritionPer100g): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [field, value] of Object.entries(nutrition)) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      issues.push({ code: "invalid_numeric_value", message: `${field} must be finite and non-negative`, severity: "error", field });
    }
  }

  for (const field of [
    "proteinGrams",
    "carbohydrateGrams",
    "sugarGrams",
    "fatGrams",
    "saturatedFatGrams",
    "fibreGrams",
  ] as const) {
    const value = nutrition[field];
    if (value !== null && value > 100) {
      issues.push({ code: "nutrient_over_100g", message: `${field} exceeds product mass`, severity: "error", field });
    }
  }

  if (nutrition.calories !== null && nutrition.calories <= 0) {
    issues.push({ code: "non_positive_energy", message: "Calories must be positive", severity: "error", field: "calories" });
  }
  if (
    nutrition.calories !== null &&
    nutrition.calories > 0 &&
    nutrition.proteinGrams !== null &&
    nutrition.proteinGrams * 4 > nutrition.calories * 1.1
  ) {
    issues.push({
      code: "protein_energy_exceeds_total",
      message: "Calories from protein exceed declared total calories",
      severity: "error",
      field: "calories",
    });
  }
  if (nutrition.calories !== null && nutrition.calories > 0) {
    const minimumMacroCalories = (nutrition.proteinGrams ?? 0) * 4
      + (nutrition.fatGrams ?? 0) * 9;
    if (minimumMacroCalories > nutrition.calories * 1.1) {
      issues.push({
        code: "macro_energy_exceeds_total",
        message: "Calories implied by declared protein and fat exceed total calories",
        severity: "error",
        field: "calories",
      });
    }
  }
  if (
    nutrition.saturatedFatGrams !== null &&
    nutrition.fatGrams !== null &&
    nutrition.saturatedFatGrams > nutrition.fatGrams
  ) {
    issues.push({ code: "saturated_fat_exceeds_fat", message: "Saturated fat exceeds total fat", severity: "error", field: "saturatedFatGrams" });
  }
  if (
    nutrition.sugarGrams !== null &&
    nutrition.carbohydrateGrams !== null &&
    nutrition.sugarGrams > nutrition.carbohydrateGrams
  ) {
    issues.push({ code: "sugar_exceeds_carbohydrate", message: "Sugar exceeds total carbohydrate", severity: "error", field: "sugarGrams" });
  }

  const [protein, carbohydrate, fat] = CORE_MACROS.map((field) => nutrition[field]);
  if (protein !== null && protein !== undefined && carbohydrate !== null && carbohydrate !== undefined && fat !== null && fat !== undefined) {
    const macroTotal = protein + carbohydrate + fat;
    if (macroTotal > 110) {
      issues.push({ code: "macro_total_impossible", message: "Core macros sum materially above 100 g", severity: "error", field: "nutrition" });
    }
    if (nutrition.calories !== null) {
      const estimated = protein * 4 + carbohydrate * 4 + fat * 9;
      const delta = Math.abs(estimated - nutrition.calories) / nutrition.calories;
      if (delta > 0.25) {
        issues.push({
          code: "calorie_macro_mismatch",
          message: "Declared calories materially disagree with core macros",
          severity: delta > 0.5 ? "error" : "warning",
          field: "calories",
        });
      }
    }
  }
  return issues;
}

export function normalizePerServing(
  values: NutritionPer100g,
  servingQuantity: number | null,
): NutritionPer100g | null {
  if (!servingQuantity || servingQuantity <= 0) return null;
  const factor = 100 / servingQuantity;
  const scale = (value: number | null): number | null => (value === null ? null : value * factor);
  return {
    calories: scale(values.calories),
    proteinGrams: scale(values.proteinGrams),
    carbohydrateGrams: scale(values.carbohydrateGrams),
    sugarGrams: scale(values.sugarGrams),
    fatGrams: scale(values.fatGrams),
    saturatedFatGrams: scale(values.saturatedFatGrams),
    fibreGrams: scale(values.fibreGrams),
    sodiumMg: scale(values.sodiumMg),
  };
}

export function nextEvidenceStatus(input: {
  current: EvidenceStatus;
  incomingVerified: boolean;
  conflictsWithSelected: boolean;
}): EvidenceStatus {
  if (input.conflictsWithSelected && (input.current === "verified" || input.incomingVerified)) return "conflict";
  if (input.incomingVerified) return "verified";
  if (input.current === "missing") return "unverified";
  return input.current;
}

export function hasNutritionErrors(issues: ValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}
