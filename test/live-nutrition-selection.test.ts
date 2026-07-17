import { describe, expect, it } from "vitest";
import {
  liveNutritionSelectionQuery,
  validateLiveNutritionSelection,
} from "../scripts/live-nutrition-selection";
import type { ReviewEvidenceDecision } from "../scripts/review-bundles";

const sourceHash = "a".repeat(64);
const candidateHash = "b".repeat(64);
const decidedAt = "2026-07-17T02:00:00.000Z";

function decision(overrides: Partial<ReviewEvidenceDecision> = {}): ReviewEvidenceDecision {
  return {
    id: "evd_selected",
    sourceId: "open_food_facts_robotoff",
    sourceRecordKey: "8900000000012:prediction-1",
    sourceRecordId: "src_selected",
    sourceContentHash: sourceHash,
    productId: "prd_selected",
    candidateHash,
    fieldFamily: "nutrition",
    decision: "verify",
    payload: {
      predictionId: "prediction-1",
      barcode: "08900000000012",
      imageId: "image-1",
      imageUrl: "https://images.openfoodfacts.org/fixture.jpg",
      modelName: "nutrition_extractor",
      modelVersion: "nutrition_extractor-2.0",
      observedAt: "2026-07-17T01:00:00.000Z",
      basis: "per_100g",
      minimumConfidence: 0.99,
      nutritionPer100g: { calories: 360, proteinGrams: 52 },
    },
    evidenceUrl: "https://images.openfoodfacts.org/fixture.jpg",
    rationale: "Verified against the exact package label",
    decidedBy: "reviewer",
    decidedAt,
    ...overrides,
  } as ReviewEvidenceDecision;
}

function state(overrides: Record<string, unknown> = {}): unknown {
  return [{
    success: true,
    results: [{
      product_id: "prd_selected",
      source_record_id: "src_selected",
      label_verified_at: decidedAt,
      decision_id: "evd_selected",
      source_record_key: "8900000000012:prediction-1",
      source_content_hash: sourceHash,
      candidate_hash: candidateHash,
      decided_at: decidedAt,
      active: 1,
      current_source_content_hash: sourceHash,
      ...overrides,
    }],
  }];
}

describe("live nutrition selection", () => {
  it("emits the authoritative exact selected-decision query", () => {
    const query = liveNutritionSelectionQuery();
    expect(query).toContain("nf.status = 'verified' AND nf.authority = 100");
    expect(query).toContain("ed.decided_at = nf.label_verified_at");
    expect(query).toContain("sr.content_hash AS current_source_content_hash");
  });

  it("accepts one exact active published decision per live product", () => {
    const result = validateLiveNutritionSelection({
      state: state(),
      decisions: [decision()],
      expectedCount: 1,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.decisions.map(({ id }) => id)).toEqual(["evd_selected"]);
  });

  it.each([
    ["inactive decision", { active: 0 }],
    ["stale source projection", { current_source_content_hash: "c".repeat(64) }],
    ["different selected timestamp", { label_verified_at: "2026-07-17T03:00:00.000Z" }],
    ["malformed candidate hash", { candidate_hash: "not-a-hash" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => validateLiveNutritionSelection({
      state: state(overrides),
      decisions: [decision()],
      expectedCount: 1,
    })).toThrow();
  });

  it("rejects missing, mismatched, duplicate, or incomplete selected records", () => {
    expect(() => validateLiveNutritionSelection({
      state: state(),
      decisions: [],
      expectedCount: 1,
    })).toThrow(/absent/);
    expect(() => validateLiveNutritionSelection({
      state: state(),
      decisions: [decision({ productId: "prd_other" })],
      expectedCount: 1,
    })).toThrow(/does not match/);
    expect(() => validateLiveNutritionSelection({
      state: [{ success: true, results: [
        (state() as Array<{ results: unknown[] }>)[0]?.results[0],
        (state() as Array<{ results: unknown[] }>)[0]?.results[0],
      ] }],
      decisions: [decision()],
      expectedCount: 2,
    })).toThrow(/exactly one/);
    expect(() => validateLiveNutritionSelection({
      state: state(),
      decisions: [decision()],
      expectedCount: 2,
    })).toThrow(/exactly one/);
  });
});
