import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewItem } from "../shared/api";
import type { ReviewedNutritionProjection } from "../shared/evidence-decisions";
import {
  NutritionCorrectionConfirmation,
  NutritionCorrectionEditor,
  ReviewedNutritionHistory,
  nutritionDraftFromCandidate,
  nutritionFieldChanges,
  reviewedProjectionFromDraft,
  type ReviewNutritionCandidate,
} from "../src/App";
import { api } from "../src/api";

const nutrition = {
  calories: 210,
  proteinGrams: 20,
  carbohydrateGrams: 15,
  sugarGrams: null,
  fatGrams: 8,
  saturatedFatGrams: 3,
  fibreGrams: null,
  sodiumMg: null,
};

function candidate(normalizedBasis: "per_100g" | "per_100ml" = "per_100g"): ReviewNutritionCandidate {
  return {
    predictionId: "prediction-1",
    imageId: "image-1",
    imageUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
    modelName: "nutrition_extractor_v1",
    modelVersion: "1.2.3",
    observedAt: "2026-07-16T10:00:00.000Z",
    basis: normalizedBasis,
    normalizedBasis,
    minimumConfidence: 0.91,
    nutrition,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("reviewed nutrition dashboard", () => {
  it("pre-fills a mass draft and preserves undeclared fields as explicit null", () => {
    const draft = nutritionDraftFromCandidate(candidate());
    expect(draft).toMatchObject({ basis: "per_100g", values: { calories: "210", proteinGrams: "20", sugarGrams: "", sodiumMg: "" } });

    draft.values.sodiumMg = "340";
    const result = reviewedProjectionFromDraft(draft);
    expect(result.errors).toEqual({});
    expect(result.projection).toEqual({
      basis: "per_100g",
      nutritionPer100g: { ...nutrition, sodiumMg: 340 },
    });
    expect(nutritionFieldChanges(candidate(), result.projection!)).toEqual([
      { field: "sodiumMg", originalValue: null, reviewedValue: 340 },
    ]);
  });

  it("keeps volume corrections dimension-safe and exposes basis changes", () => {
    const volumeCandidate = candidate("per_100ml");
    const draft = nutritionDraftFromCandidate(volumeCandidate);
    draft.basis = "per_100g";
    draft.values.sugarGrams = "4";
    const result = reviewedProjectionFromDraft(draft);
    expect(result.projection).toEqual({ basis: "per_100g", nutritionPer100g: { ...nutrition, sugarGrams: 4 } });

    const markup = renderToStaticMarkup(createElement(NutritionCorrectionConfirmation, {
      reviewId: "review-volume",
      candidate: volumeCandidate,
      projection: result.projection!,
      changes: nutritionFieldChanges(volumeCandidate, result.projection!),
      working: false,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    }));
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Basis changed:");
    expect(markup).toContain("per 100 mL");
    expect(markup).toContain("per 100 g");
    expect(markup).toContain("Confirm corrected values");
  });

  it("rejects missing required, negative, and physically inconsistent values", () => {
    const missing = nutritionDraftFromCandidate(candidate());
    missing.values.calories = "";
    expect(reviewedProjectionFromDraft(missing).errors.calories).toMatch(/Required/);

    const negative = nutritionDraftFromCandidate(candidate());
    negative.values.sodiumMg = "-1";
    expect(reviewedProjectionFromDraft(negative).errors.sodiumMg).toMatch(/non-negative/);

    const inconsistent = nutritionDraftFromCandidate(candidate());
    inconsistent.values.sugarGrams = "20";
    expect(reviewedProjectionFromDraft(inconsistent).errors.sugarGrams).toMatch(/exceeds total carbohydrate/);
  });

  it("renders an accessible, basis-aware editor with explicit null guidance", () => {
    const markup = renderToStaticMarkup(createElement(NutritionCorrectionEditor, {
      reviewId: "review-1",
      candidate: candidate(),
      rationale: "Checked every value against the bound package image",
      working: false,
      onSubmit: async () => true,
    }));
    expect(markup).toContain("Transcribe what the label actually says");
    expect(markup).toContain('id="nutrition-basis-review-1"');
    expect(markup).toContain("Per 100 g");
    expect(markup).toContain("Per 100 mL");
    expect(markup).toContain("Not declared (explicit null)");
    expect(markup).toContain("Review corrected verification");
  });

  it("renders the published corrected projection returned by the review API", () => {
    const reviewedProjection: ReviewedNutritionProjection = {
      basis: "per_100ml",
      nutritionPer100ml: { ...nutrition, sodiumMg: 340 },
    };
    const item = {
      reviewedProjection,
      nutritionChanges: [{ field: "sodiumMg", originalValue: null, reviewedValue: 340 }],
    } as ReviewItem;
    const markup = renderToStaticMarkup(createElement(ReviewedNutritionHistory, { item }));
    expect(markup).toContain("Published correction");
    expect(markup).toContain("Per 100 mL");
    expect(markup).toContain("1 nutrition field changed");
    expect(markup).toContain("340 mg");
  });
});

describe("review mutation request contract", () => {
  it.each([
    ["verify_nutrition", null],
    ["reject_nutrition", null],
    ["verify_ingredients", "Visible ingredients"],
  ])("omits reviewedProjection for the unchanged %s path", async (decision, reviewedText) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "resolved" }), { status: 200 }));
    await api.resolveReview("review-1", decision, "Exact package evidence", "https://example.com/label.jpg", null, reviewedText, null);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      decision,
      rationale: "Exact package evidence",
      evidenceUrl: "https://example.com/label.jpg",
      candidateProductId: null,
      reviewedText,
    });
    expect(String(init?.body)).not.toContain("reviewedProjection");
  });

  it("includes the reviewed projection only for corrected verification", async () => {
    const reviewedProjection: ReviewedNutritionProjection = { basis: "per_100ml", nutritionPer100ml: nutrition };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "resolved" }), { status: 200 }));
    await api.resolveReview("review-1", "verify_nutrition", "Transcribed exact package label", "https://example.com/label.jpg", null, null, reviewedProjection);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ reviewedProjection });
  });
});
