import {
  ingredientCandidatesConflict,
  ingredientCandidateWarnings,
  validateIngredientCandidate,
  type IngredientCandidate,
  type IngredientJsonValue,
} from "../../shared/ingredient-evidence";
import type { ValidationIssue } from "../../shared/types";

type RawRecord = Record<string, unknown>;

export interface RobotoffIngredientContext {
  code: string;
  ingredientImageUrl: string;
}

export interface ParsedIngredientEvidence {
  prediction: RawRecord;
  entityIndex: number;
  candidate: IngredientCandidate | null;
  issues: ValidationIssue[];
}

export interface RobotoffIngredientParseResult {
  evidence: ParsedIngredientEvidence[];
  candidates: IngredientCandidate[];
  issues: ValidationIssue[];
  predictionCount: number;
  entityCount: number;
  hasConflict: boolean;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function timestampValue(value: unknown): string {
  const raw = stringValue(value).trim();
  if (!raw) return "";
  const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : "";
}

function officialImageUrl(value: unknown): string {
  const path = stringValue(value).trim();
  if (!path) return "";
  try {
    return new URL(path.replace(/^\//, ""), "https://images.openfoodfacts.org/images/products/").toString();
  } catch {
    return "";
  }
}

function candidateIssueCode(errors: string[]): string {
  if (errors.includes("barcode does not match expectedGtin")) return "robotoff_ingredient_identity_mismatch";
  if (errors.includes("entityConfidence is outside the admitted range")) return "robotoff_ingredient_low_confidence";
  return "robotoff_ingredient_invalid_candidate";
}

function parseEntity(
  prediction: RawRecord,
  entity: RawRecord,
  entityIndex: number,
  context: RobotoffIngredientContext,
  confidenceThreshold: number,
): ParsedIngredientEvidence {
  const image = isRecord(prediction.image) ? prediction.image : {};
  const language = isRecord(entity.lang) ? entity.lang : {};
  const boundingBox = Array.isArray(entity.bounding_box)
    ? entity.bounding_box.map(numberValue)
    : [];
  const candidate: IngredientCandidate = {
    predictionId: stringValue(prediction.id).trim(),
    entityIndex,
    barcode: stringValue(image.barcode).trim(),
    imageId: stringValue(image.image_id).trim(),
    imageUrl: officialImageUrl(image.source_image),
    modelName: "ingredient_detection",
    modelVersion: stringValue(prediction.model_version).trim(),
    predictedAt: timestampValue(prediction.timestamp),
    observedAt: timestampValue(image.uploaded_at),
    entityText: typeof entity.text === "string" ? entity.text : "",
    entityConfidence: numberValue(entity.score),
    language: {
      code: stringValue(language.lang).trim(),
      confidence: numberValue(language.confidence),
    },
    boundingBox: boundingBox as IngredientCandidate["boundingBox"],
    parsedIngredients: (Array.isArray(entity.ingredients) ? entity.ingredients : []) as IngredientJsonValue[],
    ingredientCount: numberValue(entity.ingredients_n),
    knownIngredientCount: numberValue(entity.known_ingredients_n),
    unknownIngredientCount: numberValue(entity.unknown_ingredients_n),
  };
  const validationErrors = validateIngredientCandidate(candidate, {
    expectedGtin: context.code,
    confidenceThreshold,
  });
  if (validationErrors.length > 0) {
    return {
      prediction,
      entityIndex,
      candidate: null,
      issues: [{
        code: candidateIssueCode(validationErrors),
        message: "Robotoff ingredient evidence failed candidate validation.",
        severity: "error",
        field: "ingredients",
        details: {
          predictionId: candidate.predictionId,
          entityIndex,
          errors: validationErrors,
        },
      }],
    };
  }
  return {
    prediction,
    entityIndex,
    candidate,
    issues: ingredientCandidateWarnings(candidate).map((warning) => ({
      code: `robotoff_ingredient_${warning.code}`,
      message: warning.message,
      severity: "warning" as const,
      field: "ingredients",
      details: { predictionId: candidate.predictionId, entityIndex },
    })),
  };
}

export function parseRobotoffIngredientEvidence(
  response: unknown,
  context: RobotoffIngredientContext,
  confidenceThreshold = 0.85,
): RobotoffIngredientParseResult {
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("Robotoff ingredient confidence threshold must be between zero and one.");
  }
  if (!isRecord(response) || !Array.isArray(response.image_predictions)) {
    throw new Error("Robotoff ingredient response must contain image_predictions.");
  }
  const predictions = response.image_predictions.filter((prediction): prediction is RawRecord => (
    isRecord(prediction)
    && prediction.type === "ner"
    && prediction.model_name === "ingredient_detection"
  ));
  const evidence: ParsedIngredientEvidence[] = [];
  for (const prediction of predictions) {
    const data = isRecord(prediction.data) ? prediction.data : null;
    if (!data || !Array.isArray(data.entities)) {
      evidence.push({
        prediction,
        entityIndex: -1,
        candidate: null,
        issues: [{
          code: "robotoff_ingredient_invalid_entities",
          message: "Robotoff ingredient prediction does not contain an entity array.",
          severity: "error",
          field: "ingredients",
          details: { predictionId: stringValue(prediction.id).trim() },
        }],
      });
      continue;
    }
    for (const [entityIndex, entity] of data.entities.entries()) {
      if (!isRecord(entity)) {
        evidence.push({
          prediction,
          entityIndex,
          candidate: null,
          issues: [{
            code: "robotoff_ingredient_invalid_entity",
            message: "Robotoff ingredient entity is not an object.",
            severity: "error",
            field: "ingredients",
            details: { predictionId: stringValue(prediction.id).trim(), entityIndex },
          }],
        });
        continue;
      }
      evidence.push(parseEntity(prediction, entity, entityIndex, context, confidenceThreshold));
    }
  }
  const candidates = evidence.flatMap(({ candidate }) => candidate ? [candidate] : []);
  const hasConflict = ingredientCandidatesConflict(candidates);
  if (hasConflict) {
    for (const item of evidence) {
      if (!item.candidate) continue;
      item.issues.push({
        code: "robotoff_ingredient_image_conflict",
        message: "Multiple ingredient label images produce materially different text candidates.",
        severity: "error",
        field: "ingredients",
        details: { predictionId: item.candidate.predictionId, entityIndex: item.entityIndex },
      });
    }
  }
  return {
    evidence,
    candidates,
    issues: evidence.flatMap(({ issues }) => issues),
    predictionCount: predictions.length,
    entityCount: evidence.filter(({ entityIndex }) => entityIndex >= 0).length,
    hasConflict,
  };
}
