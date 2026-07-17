import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalNutritionDecisionPayload,
  effectiveNutritionProjection,
  nutritionCandidateHash,
  nutritionDecisionCandidate,
  nutritionEvidenceDecisionMatchesBinding,
  parseNutritionDecisionPayload,
  validateEvidenceDecision,
  type CorrectedNutritionEvidenceDecisionInput,
  type NutritionCandidate,
  type NutritionDecisionPayload,
  type NutritionEvidenceDecisionInput,
  type ReviewedNutritionProjection,
} from "../shared/evidence-decisions";

const candidate: NutritionCandidate = {
  predictionId: "reviewed-projection-fixture",
  barcode: "08906009532363",
  imageId: "42",
  imageUrl: "https://images.openfoodfacts.org/images/products/890/600/953/2363/42.jpg",
  modelName: "nutrition_extractor",
  modelVersion: "nutrition_extractor-2.0",
  observedAt: "2026-07-17T08:00:00.000Z",
  minimumConfidence: 0.97,
  basis: "per_100ml",
  nutritionPer100ml: {
    calories: 50,
    proteinGrams: 10,
    carbohydrateGrams: 1,
    sugarGrams: 0,
    fatGrams: 0.5,
    saturatedFatGrams: 0.1,
    fibreGrams: null,
    sodiumMg: null,
  },
};

const reviewedProjection: ReviewedNutritionProjection = {
  basis: "per_100ml",
  nutritionPer100ml: {
    calories: 52,
    proteinGrams: 10,
    carbohydrateGrams: 2,
    sugarGrams: 0,
    fatGrams: 0.5,
    saturatedFatGrams: 0.1,
    fibreGrams: null,
    sodiumMg: 125,
  },
};

async function correctedDecision(): Promise<CorrectedNutritionEvidenceDecisionInput> {
  return {
    id: "evd_reviewed_projection_fixture",
    sourceId: "open_food_facts_robotoff",
    sourceRecordKey: `${candidate.barcode}:${candidate.predictionId}`,
    sourceRecordId: "src_reviewed_projection_fixture",
    sourceContentHash: "a".repeat(64),
    productId: "prd_reviewed_projection_fixture",
    candidateHash: await nutritionCandidateHash(candidate),
    fieldFamily: "nutrition",
    decision: "verify",
    payload: { candidate, reviewedProjection },
    evidenceUrl: candidate.imageUrl,
    rationale: "Every supported declaration was transcribed from the exact bound label.",
    decidedBy: "local_operator",
    decidedAt: "2026-07-17T08:30:00.000Z",
  };
}

describe("reviewed nutrition transcription contract", () => {
  it("retains the original candidate while selecting one explicit reviewed projection", async () => {
    const decision = await correctedDecision();

    expect(await validateEvidenceDecision(decision)).toEqual([]);
    expect(parseNutritionDecisionPayload(decision.payload, candidate.barcode)).toEqual(decision.payload);
    expect(nutritionDecisionCandidate(decision.payload)).toEqual(candidate);
    expect(await nutritionCandidateHash(nutritionDecisionCandidate(decision.payload))).toBe(decision.candidateHash);
    expect(canonicalJson(canonicalNutritionDecisionPayload(decision.payload)))
      .toBe(canonicalJson(decision.payload));
    expect(effectiveNutritionProjection(decision.payload)).toEqual({
      basis: "per_100ml",
      nutrition: reviewedProjection.nutritionPer100ml,
    });

    const massProjection: ReviewedNutritionProjection = {
      basis: "per_100g",
      nutritionPer100g: reviewedProjection.nutritionPer100ml!,
    };
    const massDecision: CorrectedNutritionEvidenceDecisionInput = {
      ...decision,
      payload: { candidate, reviewedProjection: massProjection },
    };
    expect(await validateEvidenceDecision(massDecision)).toEqual([]);
    expect(effectiveNutritionProjection(massDecision.payload)).toEqual({
      basis: "per_100g",
      nutrition: massProjection.nutritionPer100g,
    });
  });

  it("rejects missing, invalid, and ambiguous reviewed projections", async () => {
    const decision = await correctedDecision();
    const reviewed = reviewedProjection.nutritionPer100ml;
    if (!reviewed) throw new Error("Expected volume fixture");

    const missingKey = {
      candidate,
      reviewedProjection: {
        basis: "per_100ml",
        nutritionPer100ml: Object.fromEntries(
          Object.entries(reviewed).filter(([field]) => field !== "sodiumMg"),
        ),
      },
    };
    expect(parseNutritionDecisionPayload(missingKey, candidate.barcode)).toBeNull();

    const negative = {
      candidate,
      reviewedProjection: {
        basis: "per_100ml",
        nutritionPer100ml: { ...reviewed, proteinGrams: -1 },
      },
    };
    expect(parseNutritionDecisionPayload(negative, candidate.barcode)).toBeNull();

    const nonFinite = {
      candidate,
      reviewedProjection: {
        basis: "per_100ml",
        nutritionPer100ml: { ...reviewed, sodiumMg: Number.POSITIVE_INFINITY },
      },
    };
    expect(parseNutritionDecisionPayload(nonFinite, candidate.barcode)).toBeNull();

    const bothDimensions = {
      candidate,
      reviewedProjection: {
        basis: "per_100ml",
        nutritionPer100g: reviewed,
        nutritionPer100ml: reviewed,
      },
    };
    expect(parseNutritionDecisionPayload(bothDimensions, candidate.barcode)).toBeNull();

    const neitherDimension = {
      candidate,
      reviewedProjection: { basis: "per_100ml" },
    };
    expect(parseNutritionDecisionPayload(neitherDimension, candidate.barcode)).toBeNull();

    const perServing = {
      candidate,
      reviewedProjection: { basis: "per_serving", nutritionPer100ml: reviewed },
    };
    expect(parseNutritionDecisionPayload(perServing, candidate.barcode)).toBeNull();

    const invalidDecision = {
      ...decision,
      payload: missingKey as unknown as NutritionDecisionPayload,
    } as NutritionEvidenceDecisionInput;
    expect(await validateEvidenceDecision(invalidDecision)).toContain("reviewedProjection is not valid");
  });

  it("rejects corrections attached to rejection decisions or a different image", async () => {
    const decision = await correctedDecision();
    const rejected = { ...decision, decision: "reject" } as unknown as NutritionEvidenceDecisionInput;
    expect(await validateEvidenceDecision(rejected)).toContain("reviewedProjection is verification-only");

    const wrongImage = { ...decision, evidenceUrl: "https://example.com/a-different-label.jpg" };
    expect(await validateEvidenceDecision(wrongImage)).toContain(
      "corrected verification evidenceUrl must match the candidate label image",
    );
  });

  it("fails exact binding checks on candidate or source drift", async () => {
    const decision = await correctedDecision();
    const binding = {
      sourceId: decision.sourceId,
      sourceRecordKey: decision.sourceRecordKey,
      sourceRecordId: decision.sourceRecordId,
      sourceContentHash: decision.sourceContentHash,
      productId: decision.productId,
      candidateHash: decision.candidateHash,
    };

    expect(nutritionEvidenceDecisionMatchesBinding(decision, binding)).toBe(true);
    expect(nutritionEvidenceDecisionMatchesBinding(decision, {
      ...binding,
      candidateHash: "b".repeat(64),
    })).toBe(false);
    expect(nutritionEvidenceDecisionMatchesBinding(decision, {
      ...binding,
      sourceContentHash: "c".repeat(64),
    })).toBe(false);
  });

  it("preserves a checked-in legacy decision's canonical bytes and effective projection", async () => {
    const fixtureUrl = new URL(
      "../review-decisions/review-14a9a56f9ca787977668/decisions.jsonl",
      import.meta.url,
    );
    const line = readFileSync(fixtureUrl, "utf8").trim().split("\n")[0];
    if (!line) throw new Error("Expected a legacy decision fixture");
    const legacy = JSON.parse(line) as Record<string, unknown>;
    const payload = parseNutritionDecisionPayload(legacy.payload);
    if (!payload) throw new Error("Expected a valid legacy nutrition payload");

    expect("candidate" in payload).toBe(false);
    expect(canonicalJson({ ...legacy, payload: canonicalNutritionDecisionPayload(payload) })).toBe(line);
    expect(await nutritionCandidateHash(nutritionDecisionCandidate(payload))).toBe(legacy.candidateHash);
    expect(effectiveNutritionProjection(payload)).toEqual({
      basis: "per_100g",
      nutrition: nutritionDecisionCandidate(payload).nutritionPer100g,
    });
  });
});
