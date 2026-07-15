import { normalizeGtin } from "./gtin";
import { hasNutritionErrors, validateNutrition } from "./nutrition";
import type { NutritionPer100g } from "./types";

export interface NutritionCandidate {
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
}

export interface EvidenceDecisionInput {
  id: string;
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  sourceContentHash: string;
  productId: string;
  candidateHash: string;
  fieldFamily: "nutrition";
  decision: "verify" | "reject";
  payload: NutritionCandidate;
  evidenceUrl: string;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function nutritionValue(value: unknown): number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value)) ? value : Number.NaN;
}

export function nutritionCandidateFromEvidence(evidence: unknown, productGtin: string | null): NutritionCandidate | null {
  const root = record(evidence);
  if (root?.code !== "robotoff_nutrition_candidate") return null;
  const candidate = record(record(root.details)?.candidate);
  const nutrition = record(candidate?.nutritionPer100g);
  if (!candidate || !nutrition) return null;
  const nutritionPer100g: NutritionPer100g = {
    calories: nutritionValue(nutrition.calories),
    proteinGrams: nutritionValue(nutrition.proteinGrams),
    carbohydrateGrams: nutritionValue(nutrition.carbohydrateGrams),
    sugarGrams: nutritionValue(nutrition.sugarGrams),
    fatGrams: nutritionValue(nutrition.fatGrams),
    saturatedFatGrams: nutritionValue(nutrition.saturatedFatGrams),
    fibreGrams: nutritionValue(nutrition.fibreGrams),
    sodiumMg: nutritionValue(nutrition.sodiumMg),
  };
  const barcode = typeof candidate.barcode === "string" ? normalizeGtin(candidate.barcode) : null;
  const observedAt = typeof candidate.observedAt === "string" ? new Date(candidate.observedAt) : new Date(Number.NaN);
  const basis = candidate.basis === "per_100g" || candidate.basis === "per_serving" ? candidate.basis : null;
  if (
    typeof candidate.predictionId !== "string" || !candidate.predictionId ||
    !barcode || (productGtin !== null && barcode !== productGtin) ||
    typeof candidate.imageId !== "string" || !candidate.imageId ||
    !validHttpsUrl(candidate.imageUrl) ||
    typeof candidate.modelName !== "string" || !candidate.modelName.startsWith("nutrition_extractor") ||
    typeof candidate.modelVersion !== "string" || !candidate.modelVersion ||
    !Number.isFinite(observedAt.valueOf()) || !basis ||
    typeof candidate.minimumConfidence !== "number" || candidate.minimumConfidence < 0.85 || candidate.minimumConfidence > 1 ||
    nutritionPer100g.calories === null || nutritionPer100g.proteinGrams === null ||
    hasNutritionErrors(validateNutrition(nutritionPer100g))
  ) return null;
  return {
    predictionId: candidate.predictionId,
    barcode,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    observedAt: observedAt.toISOString(),
    basis,
    minimumConfidence: candidate.minimumConfidence,
    nutritionPer100g,
  };
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const objectValue = record(value);
  if (!objectValue) throw new Error("Canonical JSON contains an unsupported value");
  return Object.fromEntries(
    Object.keys(objectValue).sort().map((key) => {
      if (objectValue[key] === undefined) throw new Error("Canonical JSON cannot contain undefined values");
      return [key, canonicalValue(objectValue[key])];
    }),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function canonicalNutritionCandidate(candidate: NutritionCandidate): NutritionCandidate {
  return {
    predictionId: candidate.predictionId,
    barcode: candidate.barcode,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    observedAt: candidate.observedAt,
    basis: candidate.basis,
    minimumConfidence: candidate.minimumConfidence,
    nutritionPer100g: {
      calories: candidate.nutritionPer100g.calories,
      proteinGrams: candidate.nutritionPer100g.proteinGrams,
      carbohydrateGrams: candidate.nutritionPer100g.carbohydrateGrams,
      sugarGrams: candidate.nutritionPer100g.sugarGrams,
      fatGrams: candidate.nutritionPer100g.fatGrams,
      saturatedFatGrams: candidate.nutritionPer100g.saturatedFatGrams,
      fibreGrams: candidate.nutritionPer100g.fibreGrams,
      sodiumMg: candidate.nutritionPer100g.sodiumMg,
    },
  };
}

export async function nutritionCandidateHash(candidate: NutritionCandidate): Promise<string> {
  return sha256Hex(canonicalNutritionCandidate(candidate));
}

export async function validateEvidenceDecision(input: EvidenceDecisionInput): Promise<string[]> {
  const errors: string[] = [];
  for (const [field, value] of [
    ["id", input.id], ["sourceId", input.sourceId], ["sourceRecordKey", input.sourceRecordKey],
    ["sourceRecordId", input.sourceRecordId], ["sourceContentHash", input.sourceContentHash],
    ["productId", input.productId], ["rationale", input.rationale], ["decidedBy", input.decidedBy],
  ] as const) {
    if (!value.trim()) errors.push(`${field} is required`);
  }
  if (!(["verify", "reject"] as string[]).includes(input.decision)) errors.push("decision is not supported");
  if (input.fieldFamily !== "nutrition") errors.push("fieldFamily is not supported");
  if (!/^[a-f0-9]{64}$/.test(input.candidateHash)) errors.push("candidateHash must be a lowercase SHA-256 digest");
  if (!validHttpsUrl(input.evidenceUrl)) errors.push("evidenceUrl must use HTTPS");
  if (!Number.isFinite(Date.parse(input.decidedAt))) errors.push("decidedAt must be a valid timestamp");
  if (!nutritionCandidateFromEvidence({ code: "robotoff_nutrition_candidate", details: { candidate: input.payload } }, input.payload.barcode)) {
    errors.push("payload is not a valid nutrition candidate");
  } else if (await nutritionCandidateHash(input.payload) !== input.candidateHash) {
    errors.push("candidateHash does not match payload");
  }
  return errors;
}
