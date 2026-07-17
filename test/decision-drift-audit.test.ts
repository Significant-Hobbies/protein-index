import { describe, expect, it } from "vitest";
import {
  classifyDecisionDrift,
  deduplicateReviewDecisions,
  findAmbiguousDecisionIds,
  type CurrentArtifactCandidate,
} from "../scripts/decision-drift-audit";
import {
  canonicalJson,
  nutritionCandidateFromEvidence,
  nutritionCandidateHash,
  type EvidenceDecisionInput,
  type NutritionCandidate,
} from "../shared/evidence-decisions";

async function nutritionFixture(input: {
  id?: string;
  calories?: number;
  decision?: EvidenceDecisionInput["decision"];
  linked?: boolean;
} = {}): Promise<{ decision: EvidenceDecisionInput; current: CurrentArtifactCandidate }> {
  const candidate = nutritionCandidateFromEvidence({
    code: "robotoff_nutrition_candidate",
    details: {
      candidate: {
        predictionId: "prediction-1",
        barcode: "08900000000012",
        imageId: "image-1",
        imageUrl: "https://images.openfoodfacts.org/fixture.jpg",
        modelName: "nutrition_extractor",
        modelVersion: "nutrition_extractor-2.0",
        observedAt: "2026-07-17T01:00:00.000Z",
        basis: "per_100g",
        minimumConfidence: 0.98,
        nutritionPer100g: {
          calories: input.calories ?? 360,
          proteinGrams: 52,
          carbohydrateGrams: 20,
          sugarGrams: 3,
          fatGrams: 8,
          saturatedFatGrams: 2,
          fibreGrams: 5,
          sodiumMg: 250,
        },
      },
    },
  }, "08900000000012");
  if (!candidate) throw new Error("Expected a valid nutrition fixture candidate");
  const candidateHash = await nutritionCandidateHash(candidate);
  const extractionAttemptId = `xat_${"a".repeat(24)}`;
  const labelAssetId = `lbl_${"b".repeat(24)}`;
  const common = {
    sourceId: "open_food_facts_robotoff",
    sourceRecordKey: "08900000000012:prediction-1",
    sourceRecordId: "src_fixture",
    sourceContentHash: "c".repeat(64),
    productId: "prd_fixture",
    candidateHash,
  };
  const decision: EvidenceDecisionInput = {
    id: input.id ?? "evd_fixture",
    ...common,
    ...(input.linked ? { extractionAttemptId, labelAssetId } : {}),
    fieldFamily: "nutrition",
    decision: input.decision ?? "verify",
    payload: candidate,
    evidenceUrl: candidate.imageUrl,
    rationale: "Checked against the exact package label",
    decidedBy: "local_operator",
    decidedAt: "2026-07-17T02:00:00.000Z",
  };
  const current: CurrentArtifactCandidate = {
    fieldFamily: "nutrition",
    ...common,
    gtin: candidate.barcode,
    candidate,
    canonicalCandidate: canonicalJson(candidate),
    evidenceUrl: candidate.imageUrl,
    extractionAttemptId,
    labelAssetId,
    labelContentSha256: "d".repeat(64),
    proofValid: true,
    proofIssues: [],
  };
  return { decision, current };
}

describe("decision drift audit helpers", () => {
  it("deduplicates identical reviewed history deterministically", async () => {
    const second = (await nutritionFixture({ id: "evd_b" })).decision;
    const first = (await nutritionFixture({ id: "evd_a" })).decision;

    const result = deduplicateReviewDecisions([second, first, { ...first }]);

    expect(result.duplicateCount).toBe(1);
    expect(result.decisions.map(({ id }) => id)).toEqual(["evd_a", "evd_b"]);
    expect(result.decisions[0]).toEqual(first);
  });

  it("fails closed when one immutable decision id has conflicting contents", async () => {
    const decision = (await nutritionFixture()).decision;

    expect(() => deduplicateReviewDecisions([
      decision,
      { ...decision, rationale: "A materially different historical edit" },
    ])).toThrow(/conflict/i);
  });

  it("marks multiple decision ids for one candidate key as ambiguous", async () => {
    const first = await nutritionFixture({ id: "evd_candidate_a", decision: "reject" });
    const second = await nutritionFixture({ id: "evd_candidate_b", decision: "reject" });
    const artifact = { fieldFamily: "nutrition" as const, sourceId: first.current.sourceId };

    const ambiguous = findAmbiguousDecisionIds(
      [second.decision, first.decision],
      [first.current],
      artifact,
    );

    expect([...ambiguous]).toEqual([
      ["evd_candidate_a", ["multiple_decision_ids_for_candidate_key"]],
      ["evd_candidate_b", ["multiple_decision_ids_for_candidate_key"]],
    ]);
  });

  it("marks multiple current verify decisions for one product as ambiguous", async () => {
    const first = await nutritionFixture({ id: "evd_product_a" });
    const second = await nutritionFixture({ id: "evd_product_b", calories: 361 });
    const artifact = { fieldFamily: "nutrition" as const, sourceId: first.current.sourceId };

    const ambiguous = findAmbiguousDecisionIds(
      [second.decision, first.decision],
      [second.current, first.current],
      artifact,
    );

    expect([...ambiguous]).toEqual([
      ["evd_product_a", ["multiple_current_verifies_for_product"]],
      ["evd_product_b", ["multiple_current_verifies_for_product"]],
    ]);
  });

  it("separates exact links from legacy semantic matches", async () => {
    const linked = await nutritionFixture({ linked: true });
    const legacy = await nutritionFixture();
    const artifact = { fieldFamily: "nutrition" as const, sourceId: linked.current.sourceId };

    await expect(classifyDecisionDrift(linked.decision, [linked.current], artifact)).resolves.toMatchObject({
      classification: "exact_link_valid",
      current: linked.current,
      differences: [],
    });
    await expect(classifyDecisionDrift(legacy.decision, [legacy.current], artifact)).resolves.toMatchObject({
      classification: "legacy_proof_match_requires_new_decision",
      current: legacy.current,
      differences: ["immutable_extraction_link"],
    });
  });

  it("classifies source, candidate, identity, proof, and linkage drift without rebinding", async () => {
    const fixture = await nutritionFixture();
    const linked = await nutritionFixture({ linked: true });
    const changedCandidate = await nutritionFixture({ calories: 361 });
    const artifact = { fieldFamily: "nutrition" as const, sourceId: fixture.current.sourceId };

    await expect(classifyDecisionDrift(fixture.decision, [{
      ...fixture.current,
      sourceContentHash: "e".repeat(64),
    }], artifact)).resolves.toMatchObject({ classification: "source_revision_drift_candidate_unchanged" });

    await expect(classifyDecisionDrift(fixture.decision, [{
      ...fixture.current,
      candidate: changedCandidate.current.candidate as NutritionCandidate,
      candidateHash: changedCandidate.current.candidateHash,
      canonicalCandidate: changedCandidate.current.canonicalCandidate,
    }], artifact)).resolves.toMatchObject({ classification: "candidate_drift" });

    await expect(classifyDecisionDrift(fixture.decision, [{
      ...fixture.current,
      productId: "prd_rebound",
    }], artifact)).resolves.toMatchObject({ classification: "identity_drift" });

    await expect(classifyDecisionDrift(fixture.decision, [{
      ...fixture.current,
      proofValid: false,
      proofIssues: ["label byte hash mismatch"],
    }], artifact)).resolves.toMatchObject({
      classification: "exact_proof_incomplete_or_inconsistent",
      differences: expect.arrayContaining([expect.stringMatching(/label byte hash mismatch/i)]),
    });

    await expect(classifyDecisionDrift(linked.decision, [{
      ...linked.current,
      labelAssetId: `lbl_${"f".repeat(24)}`,
    }], artifact)).resolves.toMatchObject({ classification: "linked_proof_drift" });
  });

  it("keeps missing, other-family, and redundant decisions explicitly non-exact", async () => {
    const fixture = await nutritionFixture();
    const redundant = await nutritionFixture({ decision: "redundant", linked: true });
    const nutritionArtifact = { fieldFamily: "nutrition" as const, sourceId: fixture.current.sourceId };

    await expect(classifyDecisionDrift(fixture.decision, [], nutritionArtifact)).resolves.toMatchObject({
      classification: "artifact_candidate_missing",
      current: null,
    });
    await expect(classifyDecisionDrift(fixture.decision, [], {
      fieldFamily: "ingredients",
      sourceId: "open_food_facts_robotoff_ingredients",
    })).resolves.toMatchObject({ classification: "unsupported_source_or_family" });
    await expect(classifyDecisionDrift(redundant.decision, [redundant.current], nutritionArtifact)).resolves.toMatchObject({
      classification: "requires_selected_projection_state",
    });
  });
});
