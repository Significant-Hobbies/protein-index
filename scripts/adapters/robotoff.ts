import { createHash } from "node:crypto";
import { classifyProtein } from "../../shared/classification";
import { canonicalJson, canonicalNutritionCandidate } from "../../shared/evidence-decisions";
import { normalizeGtin } from "../../shared/gtin";
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
  nutritionBasis: "per_100g" | "per_100ml" | "per_serving" | "unknown";
  imageUrl: string | null;
  nutritionImageUrl: string | null;
}

export interface RobotoffNutritionCandidate {
  predictionId: string;
  barcode: string;
  imageId: string;
  imageUrl: string;
  modelName: string;
  modelVersion: string;
  observedAt: string;
  basis: "per_100g" | "per_serving";
  minimumConfidence: number;
  nutritionPer100g: NutritionPer100g;
  rawNutrients: Record<string, unknown>;
}

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

function completeCore(nutrition: NutritionPer100g): boolean {
  return nutrition.proteinGrams !== null && nutrition.calories !== null && nutrition.calories > 0;
}

function mergeMissingNutrition(primary: NutritionPer100g, fallback: NutritionPer100g): NutritionPer100g {
  return {
    calories: primary.calories ?? fallback.calories,
    proteinGrams: primary.proteinGrams ?? fallback.proteinGrams,
    carbohydrateGrams: primary.carbohydrateGrams ?? fallback.carbohydrateGrams,
    sugarGrams: primary.sugarGrams ?? fallback.sugarGrams,
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
  if (context.nutritionBasis === "per_100ml") {
    issues.push({
      code: "robotoff_unsupported_volume_basis",
      message: "Robotoff volume-label output cannot be represented as per-100-g nutrition without density evidence.",
      severity: "error",
      field: "nutrition",
      details: { predictionId, nutritionBasis: context.nutritionBasis, servingSizeGrams: context.servingSizeGrams },
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

  let basis: RobotoffNutritionCandidate["basis"] | null = null;
  let normalized: NutritionPer100g | null = null;
  if (completeCore(per100g)) {
    basis = "per_100g";
    normalized = per100g;
  }
  if (completeCore(perServing)) {
    const converted = normalizePerServing(perServing, context.servingSizeGrams);
    if (!converted) {
      issues.push({
        code: "robotoff_ambiguous_serving_basis",
        message: "Per-serving prediction cannot be normalized without a valid serving mass.",
        severity: "error",
        field: "servingSizeGrams",
        details: { predictionId, servingSizeGrams: context.servingSizeGrams, perServing },
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
      normalized = mergeMissingNutrition(normalized, converted);
    } else if (!normalized) {
      normalized = converted;
      basis = "per_serving";
    }
  } else if (normalized) {
    const converted = normalizePerServing(perServing, context.servingSizeGrams);
    if (converted && hasComparableCore(normalized, converted) && !differs(normalized, converted)) {
      normalized = mergeMissingNutrition(normalized, converted);
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

  return {
    candidate: {
      predictionId,
      barcode: context.code,
      imageId,
      imageUrl: evidenceImageUrl,
      modelName,
      modelVersion,
      observedAt: predictionTime(prediction),
      basis,
      minimumConfidence: confidences.length ? Math.min(...confidences) : 0,
      nutritionPer100g: normalized,
      rawNutrients,
    },
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
  const crossImageConflict = candidates.some((candidate, index) => candidates.slice(index + 1).some((other) => differs(candidate.nutritionPer100g, other.nutritionPer100g)));
  const staged = parsed.map((item) => stagedReview(context, item, crossImageConflict && item.candidate !== null));
  return { staged, candidates, issues: staged.flatMap(({ validationIssues }) => validationIssues) };
}
