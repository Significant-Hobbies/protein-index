import { createHash } from "node:crypto";
import { classifyProtein } from "../../shared/classification";
import {
  canonicalJson,
  canonicalNutritionCandidate,
  nutritionCandidateNormalizedBasis,
  nutritionCandidateValues,
  type MassNutritionCandidate,
  type VolumeNutritionCandidate,
} from "../../shared/evidence-decisions";
import { normalizeGtin, parseQuantity } from "../../shared/gtin";
import { calculateCompleteness } from "../../shared/metrics";
import { emptyNutrition, normalizePerServing, validateNutrition } from "../../shared/nutrition";
import type { NutritionPer100g, ProductCategory, StagedProduct, ValidationIssue } from "../../shared/types";

type RawRecord = Record<string, unknown>;

export interface RobotoffProductContext {
  code: string;
  brand: string;
  name: string;
  flavour: string | null;
  category: ProductCategory;
  categoryRaw: string | null;
  netQuantityGrams: number | null;
  servingSizeGrams: number | null;
  servingSizeMillilitres?: number | null;
  nutritionBasis: "per_100g" | "per_100ml" | "per_serving" | "unknown";
  sourceNutritionPer100g?: NutritionPer100g | null;
  sourceNutritionPer100ml?: NutritionPer100g | null;
  imageUrl: string | null;
  nutritionImageUrl: string | null;
}

export type RobotoffNutritionCandidate = (MassNutritionCandidate | VolumeNutritionCandidate) & {
  rawNutrients: Record<string, unknown>;
};

export interface RobotoffParseResult {
  staged: StagedProduct[];
  candidates: RobotoffNutritionCandidate[];
  issues: ValidationIssue[];
}

interface ParsedPrediction {
  candidate: RobotoffNutritionCandidate | null;
  issues: ValidationIssue[];
  prediction: RawRecord;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function predictionTime(prediction: RawRecord): string {
  for (const value of [isRecord(prediction.image) ? prediction.image.uploaded_at : null, prediction.timestamp]) {
    const raw = text(value);
    if (!raw) continue;
    const parsed = new Date(raw.endsWith("Z") ? raw : `${raw}Z`);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function imageUrl(image: RawRecord): string | null {
  const source = text(image.source_image);
  if (!source) return null;
  return new URL(source.replace(/^\//, ""), "https://images.openfoodfacts.org/images/products/").toString();
}

function toSodiumMg(value: number, unit: string | null): number | null {
  if (unit === "mg") return value;
  if (unit === "g") return value * 1000;
  return null;
}

function setNutritionValue(nutrition: NutritionPer100g, nutrient: string, value: number, unit: string | null): boolean {
  if (nutrient === "energy-kcal") { nutrition.calories = unit === "kj" ? value / 4.184 : value; return true; }
  if (nutrient === "energy-kj") { nutrition.calories = value / 4.184; return true; }
  if (nutrient === "proteins") { nutrition.proteinGrams = value; return true; }
  if (nutrient === "carbohydrates") { nutrition.carbohydrateGrams = value; return true; }
  if (nutrient === "sugars") { nutrition.sugarGrams = value; return true; }
  if (nutrient === "fat") { nutrition.fatGrams = value; return true; }
  if (nutrient === "saturated-fat") { nutrition.saturatedFatGrams = value; return true; }
  if (nutrient === "fiber" || nutrient === "fibre") { nutrition.fibreGrams = value; return true; }
  if (nutrient === "sodium") { nutrition.sodiumMg = toSodiumMg(value, unit); return nutrition.sodiumMg !== null; }
  return false;
}

function correctMisclassifiedPer100gKj(
  rawNutrients: RawRecord,
  nutrition: NutritionPer100g,
  confidenceThreshold: number,
): { rawValue: number; convertedCalories: number; macroCalorieFloor: number; score: number } | null {
  if ("energy-kcal_100g" in rawNutrients) return null;
  const raw = rawNutrients["energy-kj_100g"];
  if (!isRecord(raw)) return null;
  const rawValue = number(raw.value);
  const score = number(raw.score);
  const unit = text(raw.unit)?.toLowerCase() ?? null;
  if (rawValue === null || score === null || score < confidenceThreshold || unit !== "kj") return null;
  if (nutrition.proteinGrams === null || nutrition.carbohydrateGrams === null) return null;

  const macroCalorieFloor = (nutrition.proteinGrams + nutrition.carbohydrateGrams) * 4
    + (nutrition.fatGrams ?? 0) * 9;
  const convertedCalories = rawValue / 4.184;
  const convertedIsImpossible = convertedCalories < macroCalorieFloor * 0.85;
  const rawValueIsPlausibleKcal = rawValue <= 1_000
    && rawValue >= macroCalorieFloor * 0.85
    && rawValue <= macroCalorieFloor * 1.5;
  if (!convertedIsImpossible || !rawValueIsPlausibleKcal) return null;

  nutrition.calories = rawValue;
  return { rawValue, convertedCalories, macroCalorieFloor, score };
}

function completeCore(nutrition: NutritionPer100g): boolean {
  return nutrition.proteinGrams !== null && nutrition.calories !== null && nutrition.calories > 0;
}

function mergeSupplementaryServingNutrition(primary: NutritionPer100g, fallback: NutritionPer100g): NutritionPer100g {
  return {
    calories: primary.calories ?? fallback.calories,
    proteinGrams: primary.proteinGrams ?? fallback.proteinGrams,
    carbohydrateGrams: primary.carbohydrateGrams ?? fallback.carbohydrateGrams,
    sugarGrams: primary.sugarGrams,
    fatGrams: primary.fatGrams ?? fallback.fatGrams,
    saturatedFatGrams: primary.saturatedFatGrams ?? fallback.saturatedFatGrams,
    fibreGrams: primary.fibreGrams ?? fallback.fibreGrams,
    sodiumMg: primary.sodiumMg ?? fallback.sodiumMg,
  };
}

function differs(left: NutritionPer100g, right: NutritionPer100g, tolerance = 0.15): boolean {
  for (const field of ["calories", "proteinGrams"] as const) {
    const a = left[field];
    const b = right[field];
    if (a === null || b === null) continue;
    if (Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) > tolerance) return true;
  }
  return false;
}

function hasComparableCore(left: NutritionPer100g, right: NutritionPer100g): boolean {
  return (["calories", "proteinGrams"] as const).some((field) => left[field] !== null && right[field] !== null);
}

function labelServingQuantity(
  rawNutrients: RawRecord,
  volumeBased: boolean,
  confidenceThreshold: number,
): { quantity: number; rawValue: string; score: number } | null {
  const raw = rawNutrients.serving_size;
  if (!isRecord(raw)) return null;
  const score = number(raw.score);
  const rawValue = text(raw.value) ?? text(raw.text);
  if (score === null || score < confidenceThreshold || !rawValue) return null;
  const unit = text(raw.unit);
  const parsed = parseQuantity(rawValue) ?? parseQuantity(unit ? `${rawValue} ${unit}` : null);
  const quantity = volumeBased ? parsed?.millilitres : parsed?.grams;
  return quantity !== null && quantity !== undefined ? { quantity, rawValue, score } : null;
}

function parsePrediction(
  prediction: RawRecord,
  context: RobotoffProductContext,
  confidenceThreshold: number,
): ParsedPrediction {
  const issues: ValidationIssue[] = [];
  const predictionId = text(prediction.id) ?? "unknown";
  const modelName = text(prediction.model_name);
  const modelVersion = text(prediction.model_version);
  const image = isRecord(prediction.image) ? prediction.image : null;
  const imageId = image ? text(image.image_id) : null;
  const evidenceImageUrl = image ? imageUrl(image) : null;
  const data = isRecord(prediction.data) ? prediction.data : null;
  const rawNutrients = data && isRecord(data.nutrients) ? data.nutrients : null;
  if (!modelName || !modelVersion || !imageId || !evidenceImageUrl || !rawNutrients) {
    issues.push({
      code: "robotoff_incomplete_evidence",
      message: "Robotoff prediction lacks model, image, or nutrient evidence.",
      severity: "error",
      field: "nutrition",
      details: { predictionId, modelName, modelVersion, imageId, evidenceImageUrl },
    });
    return { candidate: null, issues, prediction };
  }
  const per100g = emptyNutrition();
  const perServing = emptyNutrition();
  const confidences: number[] = [];
  for (const [key, raw] of Object.entries(rawNutrients)) {
    const match = /^(energy-kcal|energy-kj|proteins|carbohydrates|sugars|fat|saturated-fat|fib(?:er|re)|sodium)_(100g|serving)$/.exec(key);
    if (!match?.[1] || !match[2] || !isRecord(raw)) continue;
    const value = number(raw.value);
    const score = number(raw.score);
    const unit = text(raw.unit)?.toLowerCase() ?? null;
    if (value === null || score === null || score < confidenceThreshold) {
      issues.push({
        code: "robotoff_low_confidence_nutrient",
        message: `Robotoff ${key} is missing a value or falls below the confidence threshold.`,
        severity: "warning",
        field: key,
        details: { predictionId, score, value, threshold: confidenceThreshold, unit },
      });
      continue;
    }
    const target = match[2] === "100g" ? per100g : perServing;
    if (setNutritionValue(target, match[1], value, unit)) {
      confidences.push(score);
    } else {
      issues.push({
        code: "robotoff_unsupported_nutrient_unit",
        message: `Robotoff ${key} does not include a supported unit.`,
        severity: "warning",
        field: key,
        details: { predictionId, score, value, unit },
      });
    }
  }
  const correctedEnergy = correctMisclassifiedPer100gKj(rawNutrients, per100g, confidenceThreshold);
  if (correctedEnergy) {
    issues.push({
      code: "robotoff_energy_kj_entity_corrected_to_kcal",
      message: "Robotoff labeled a physically plausible kcal value as kJ; the converted value conflicts with the declared protein and carbohydrate floor.",
      severity: "warning",
      field: "energy-kj_100g",
      details: { predictionId, ...correctedEnergy },
    });
  }

  const volumeBased = context.nutritionBasis === "per_100ml";
  const normalizedBasis = volumeBased ? "per_100ml" as const : "per_100g" as const;
  const servingField = volumeBased ? "servingSizeMillilitres" : "servingSizeGrams";
  const contextServingQuantity = volumeBased ? context.servingSizeMillilitres ?? null : context.servingSizeGrams;
  const labelServing = labelServingQuantity(rawNutrients, volumeBased, confidenceThreshold);
  const servingQuantity = labelServing?.quantity ?? contextServingQuantity;
  if (
    labelServing && contextServingQuantity !== null
    && Math.abs(labelServing.quantity - contextServingQuantity) > 0.01
  ) {
    issues.push({
      code: "robotoff_label_serving_size_overrides_context",
      message: `A confident serving ${volumeBased ? "volume" : "mass"} from the same label image overrides the conflicting catalog value.`,
      severity: "warning",
      field: servingField,
      details: {
        predictionId,
        labelServingQuantity: labelServing.quantity,
        contextServingQuantity,
        rawValue: labelServing.rawValue,
        score: labelServing.score,
      },
    });
  }
  let basis: "per_100g" | "per_100ml" | "per_serving" | null = null;
  let normalized: NutritionPer100g | null = null;
  if (completeCore(per100g)) {
    basis = normalizedBasis;
    normalized = per100g;
  }
  if (completeCore(perServing)) {
    const converted = normalizePerServing(perServing, servingQuantity);
    if (!converted) {
      issues.push({
        code: "robotoff_ambiguous_serving_basis",
        message: `Per-serving prediction cannot be normalized without a valid serving ${volumeBased ? "volume" : "mass"}.`,
        severity: "error",
        field: servingField,
        details: {
          predictionId,
          servingSizeGrams: context.servingSizeGrams,
          servingSizeMillilitres: context.servingSizeMillilitres,
          nutritionBasis: context.nutritionBasis,
          perServing,
        },
      });
    } else if (normalized && differs(normalized, converted)) {
      issues.push({
        code: "robotoff_basis_conflict",
        message: "Per-100-g and per-serving label predictions materially disagree.",
        severity: "error",
        field: "nutrition",
        details: { predictionId, per100g: normalized, convertedServing: converted },
      });
      normalized = null;
      basis = null;
    } else if (normalized) {
      if (normalized.sugarGrams === null && converted.sugarGrams !== null) {
        issues.push({
          code: "robotoff_ambiguous_total_sugar_basis",
          message: "A serving-column sugar value cannot safely backfill a missing per-100-g total-sugar field.",
          severity: "warning",
          field: "sugarGrams",
          details: { predictionId, servingSugarGrams: converted.sugarGrams },
        });
      }
      normalized = mergeSupplementaryServingNutrition(normalized, converted);
      if (!correctedEnergy && !("energy-kcal_100g" in rawNutrients) && "energy-kcal_serving" in rawNutrients && converted.calories !== null) {
        normalized.calories = converted.calories;
      }
    } else if (!normalized) {
      const sourceAnchor = volumeBased
        ? context.sourceNutritionPer100ml ?? null
        : context.sourceNutritionPer100g ?? null;
      if (sourceAnchor && !differs(perServing, sourceAnchor, 0.05) && differs(converted, sourceAnchor, 0.15)) {
        issues.push({
          code: "robotoff_serving_basis_conflicts_source_anchor",
          message: `Values labeled as serving data match the source ${normalizedBasis === "per_100ml" ? "per-100-mL" : "per-100-g"} row before conversion and materially disagree after conversion.`,
          severity: "error",
          field: "nutrition",
          details: { predictionId, perServing, convertedServing: converted, sourceNutrition: sourceAnchor, normalizedBasis },
        });
      } else {
        normalized = converted;
        basis = "per_serving";
      }
    }
  } else if (normalized) {
    const converted = normalizePerServing(perServing, servingQuantity);
    if (converted && hasComparableCore(normalized, converted) && !differs(normalized, converted)) {
      if (normalized.sugarGrams === null && converted.sugarGrams !== null) {
        issues.push({
          code: "robotoff_ambiguous_total_sugar_basis",
          message: "A serving-column sugar value cannot safely backfill a missing per-100-g total-sugar field.",
          severity: "warning",
          field: "sugarGrams",
          details: { predictionId, servingSugarGrams: converted.sugarGrams },
        });
      }
      normalized = mergeSupplementaryServingNutrition(normalized, converted);
      if (!correctedEnergy && !("energy-kcal_100g" in rawNutrients) && "energy-kcal_serving" in rawNutrients && converted.calories !== null) {
        normalized.calories = converted.calories;
      }
    }
  }
  if (!normalized || !basis) {
    if (!issues.some(({ severity }) => severity === "error")) {
      issues.push({
        code: "robotoff_missing_core_nutrients",
        message: "Robotoff prediction does not contain confident protein and calorie values on a usable basis.",
        severity: "error",
        field: "nutrition",
        details: { predictionId, per100g, perServing },
      });
    }
    return { candidate: null, issues, prediction };
  }
  const validation = validateNutrition(normalized);
  issues.push(...validation.map((issue) => ({ ...issue, code: `robotoff_${issue.code}`, details: { predictionId } })));
  if (validation.some(({ severity }) => severity === "error")) return { candidate: null, issues, prediction };

  const candidateBase = {
      predictionId,
      barcode: context.code,
      imageId,
      imageUrl: evidenceImageUrl,
      modelName,
      modelVersion,
      observedAt: predictionTime(prediction),
      basis,
      minimumConfidence: confidences.length ? Math.min(...confidences) : 0,
      rawNutrients,
  };
  const candidate: RobotoffNutritionCandidate = normalizedBasis === "per_100ml"
    ? { ...candidateBase, basis: basis as VolumeNutritionCandidate["basis"], nutritionPer100ml: normalized }
    : { ...candidateBase, basis: basis as MassNutritionCandidate["basis"], nutritionPer100g: normalized };
  return {
    candidate,
    issues,
    prediction,
  };
}

function stagedReview(
  context: RobotoffProductContext,
  parsed: ParsedPrediction,
  crossImageConflict: boolean,
): StagedProduct {
  const predictionId = text(parsed.prediction.id) ?? createHash("sha256").update(JSON.stringify(parsed.prediction)).digest("hex").slice(0, 16);
  const observedAt = parsed.candidate?.observedAt ?? predictionTime(parsed.prediction);
  const sourceUrl = `https://robotoff.openfoodfacts.org/api/v1/image_predictions?barcode=${encodeURIComponent(context.code)}&model_name=nutrition_extractor`;
  const candidateHash = parsed.candidate
    ? createHash("sha256").update(canonicalJson(canonicalNutritionCandidate(parsed.candidate))).digest("hex")
    : null;
  const candidateIssue: ValidationIssue[] = parsed.candidate ? [{
    code: crossImageConflict ? "robotoff_image_conflict" : "robotoff_nutrition_candidate",
    message: crossImageConflict
      ? "Multiple label images produce materially different nutrition candidates."
      : "Robotoff produced a plausible nutrition candidate that requires label verification.",
    severity: crossImageConflict ? "error" : "warning",
    field: "nutrition",
    details: { candidate: parsed.candidate, candidateHash },
  }] : [];
  const issues = [...parsed.issues, ...candidateIssue];
  const nutrition = {
    per100g: emptyNutrition(),
    servingSizeGrams: context.servingSizeGrams,
    basis: "unknown" as const,
    preparationState: "unknown" as const,
    status: "missing" as const,
    confidence: "low" as const,
    source: "open_food_facts_robotoff",
    observedAt,
    labelVerifiedAt: null,
  };
  const classification = classifyProtein({ name: context.name, categories: context.categoryRaw ?? context.category, labels: "", nutrition });
  const rawEvidence = { prediction: parsed.prediction, candidate: parsed.candidate, candidateHash, crossImageConflict };
  const completeness = calculateCompleteness({
    gtin: normalizeGtin(context.code),
    brand: context.brand,
    name: context.name,
    netQuantityGrams: context.netQuantityGrams,
    nutrition: null,
    ingredients: null,
    evidence: sourceUrl,
    offer: null,
  });
  return {
    source: "open_food_facts_robotoff",
    sourceKind: "open_data",
    sourceAuthority: { identity: 0, nutrition: 20, ingredients: 0 },
    sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    sourceRetentionNotes: "Robotoff model output is review evidence, not verified nutrition.",
    sourceRecordId: `${context.code}:${predictionId}`,
    sourceUrl,
    observedAt,
    contentHash: createHash("sha256").update(JSON.stringify(rawEvidence)).digest("hex"),
    gtinRaw: context.code,
    gtin: normalizeGtin(context.code),
    brand: context.brand,
    name: context.name,
    flavour: context.flavour,
    category: context.category,
    categoryRaw: context.categoryRaw,
    productKind: "retail_packaged",
    netQuantityGrams: context.netQuantityGrams,
    servingSizeGrams: context.servingSizeGrams,
    imageUrl: context.imageUrl,
    nutritionImageUrl: parsed.candidate?.imageUrl ?? context.nutritionImageUrl,
    ingredientImageUrl: null,
    offers: [],
    ratings: [],
    nutrition,
    nutrients: [],
    ingredients: {
      raw: null,
      language: null,
      normalized: [],
      allergens: [],
      additives: [],
      status: "missing",
      confidence: "low",
      source: "open_food_facts_robotoff",
      observedAt,
    },
    classification,
    completeness: completeness.score,
    completenessMissing: completeness.missing,
    rawEvidence,
    validationIssues: issues,
  };
}

export function parseRobotoffNutritionEvidence(
  response: unknown,
  context: RobotoffProductContext,
  confidenceThreshold = 0.85,
): RobotoffParseResult {
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("Robotoff confidence threshold must be between 0 and 1.");
  }
  if (!isRecord(response) || !Array.isArray(response.image_predictions)) {
    throw new Error("Robotoff response must contain image_predictions.");
  }
  const predictions = response.image_predictions.filter((prediction): prediction is RawRecord => (
    isRecord(prediction) && prediction.type === "nutrition_extraction"
  ));
  const parsed = predictions.map((prediction) => parsePrediction(prediction, context, confidenceThreshold));
  const candidates = parsed.flatMap(({ candidate }) => candidate ? [candidate] : []);
  const crossImageConflict = candidates.some((candidate, index) => candidates.slice(index + 1).some((other) => (
    nutritionCandidateNormalizedBasis(candidate) !== nutritionCandidateNormalizedBasis(other) ||
    differs(nutritionCandidateValues(candidate), nutritionCandidateValues(other))
  )));
  const staged = parsed.map((item) => stagedReview(context, item, crossImageConflict && item.candidate !== null));
  return { staged, candidates, issues: staged.flatMap(({ validationIssues }) => validationIssues) };
}
