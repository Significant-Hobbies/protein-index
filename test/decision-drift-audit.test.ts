import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditDecisionDrift,
  classifyDecisionDrift,
  deduplicateReviewDecisions,
  findAmbiguousDecisionIds,
  readActiveReviewBundleSet,
  type CurrentArtifactCandidate,
} from "../scripts/decision-drift-audit";
import { extractRobotoffApi } from "../scripts/adapters/robotoff-api";
import { stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";
import { readReviewDecisionBundle, writeReviewDecisionBundle } from "../scripts/review-bundles";
import {
  canonicalJson,
  nutritionCandidateFromEvidence,
  nutritionCandidateHash,
  type EvidenceDecisionInput,
  type NutritionCandidate,
} from "../shared/evidence-decisions";
import {
  ingredientCandidateHash,
  type IngredientCandidate,
  type IngredientEvidenceDecisionInput,
} from "../shared/ingredient-evidence";

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

async function nutritionArtifactFixture(root: string): Promise<string> {
  const input = join(root, "source.jsonl");
  const nutritionImageUrl = "https://images.openfoodfacts.org/images/products/890/000/000/0012/2.jpg";
  await writeFile(input, `${JSON.stringify({
    code: "8900000000012",
    product_name: "Decision audit fixture",
    brands: "Fixture Brand",
    countries_tags: ["en:india"],
    quantity: "500 g",
    serving_size: "50 g",
    image_nutrition_url: nutritionImageUrl,
  })}\n`, "utf8");
  const source = await stageOpenFoodFacts({
    input,
    outputDirectory: join(root, "source"),
    mode: "sample",
    limit: null,
  });
  const artifactDirectory = join(root, "artifact");
  await extractRobotoffApi({
    input: source.stagedPath,
    inputManifest: source.manifestPath,
    outputDirectory: artifactDirectory,
    mode: "sample",
    limit: null,
    minimumIntervalMs: 0,
    labelFetcher: async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "4" },
    }),
    fetcher: async () => new Response(JSON.stringify({
      image_predictions: [{
        id: "artifact-prediction",
        type: "nutrition_extraction",
        model_name: "nutrition_extractor",
        model_version: "nutrition_extractor-2.0",
        timestamp: "2026-07-17T01:00:00Z",
        image: {
          image_id: "2",
          source_image: "/890/000/000/0012/2.jpg",
          uploaded_at: "2026-07-17T00:00:00Z",
        },
        data: { nutrients: {
          "energy-kcal_100g": { value: "360", unit: "kcal", score: 0.99 },
          proteins_100g: { value: "52", unit: "g", score: 0.99 },
          carbohydrates_100g: { value: "20", unit: "g", score: 0.99 },
          fat_100g: { value: "8", unit: "g", score: 0.99 },
        } },
      }],
    }), { status: 200 }),
  });
  return artifactDirectory;
}

async function ingredientDecisionFixture(): Promise<IngredientEvidenceDecisionInput> {
  const candidate: IngredientCandidate = {
    predictionId: "ingredient-prediction",
    entityIndex: 0,
    barcode: "08900000000012",
    imageId: "ingredient-image",
    imageUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/ingredients.jpg",
    modelName: "ingredient_detection",
    modelVersion: "ingredient-detection-1.0",
    predictedAt: "2026-07-17T01:00:00.000Z",
    observedAt: "2026-07-17T00:00:00.000Z",
    entityText: "Milk solids",
    entityConfidence: 0.99,
    language: { code: "en", confidence: 0.99 },
    boundingBox: [0, 0, 100, 100],
    parsedIngredients: [{ id: "en:milk", text: "Milk", in_taxonomy: true }],
    ingredientCount: 1,
    knownIngredientCount: 1,
    unknownIngredientCount: 0,
  };
  return {
    id: "evd_ingredient_fixture",
    sourceId: "open_food_facts_robotoff_ingredients",
    sourceRecordKey: "08900000000012:ingredient-prediction:0",
    sourceRecordId: "src_ingredient_fixture",
    sourceContentHash: "e".repeat(64),
    productId: "prd_fixture",
    candidateHash: await ingredientCandidateHash(candidate),
    fieldFamily: "ingredients",
    decision: "reject",
    payload: { candidate, reviewedText: null, normalizedIngredients: [] },
    evidenceUrl: candidate.imageUrl,
    rationale: "The prediction is not supported by the exact label image",
    decidedBy: "local_operator",
    decidedAt: "2026-07-17T02:00:00.000Z",
  };
}

async function writeActiveSet(path: string, nutrition: string[]): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    families: {
      ingredients: ["review-00000000000000000000"],
      nutrition: [...nutrition].sort(),
    },
  }, null, 2)}\n`, "utf8");
}

describe("decision drift audit helpers", () => {
  it("loads an exact sorted family-specific active bundle set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-active-bundles-"));
    const path = join(directory, "active-bundles.json");
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      families: {
        ingredients: ["review-11111111111111111111"],
        nutrition: ["review-22222222222222222222", "review-33333333333333333333"],
      },
    }, null, 2)}\n`, "utf8");

    await expect(readActiveReviewBundleSet(path, "nutrition")).resolves.toMatchObject({
      bundleIds: ["review-22222222222222222222", "review-33333333333333333333"],
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("keeps the checked-in active bundle partition exact and conflict-free", async () => {
    const path = "review-decisions/active-bundles.json";
    for (const [family, expected] of [["nutrition", 312], ["ingredients", 66]] as const) {
      const set = await readActiveReviewBundleSet(path, family);
      const bundles = await Promise.all(set.bundleIds.map((id) => readReviewDecisionBundle(`review-decisions/${id}`)));
      const decisions = bundles.flatMap(({ decisions }) => decisions);
      expect(decisions).toHaveLength(expected);
      expect(decisions.every((decision) => decision.fieldFamily === family)).toBe(true);
      expect(new Set(decisions.map(({ id }) => id))).toHaveLength(expected);
      expect(new Set(decisions.map((decision) => [decision.sourceId, decision.sourceRecordKey, decision.candidateHash, decision.fieldFamily].join("\0")))).toHaveLength(expected);
      expect(new Set(decisions.map((decision) => [decision.sourceId, decision.sourceRecordKey, decision.fieldFamily].join("\0")))).toHaveLength(expected);
      const verifies = decisions.filter(({ decision }) => decision === "verify");
      expect(new Set(verifies.map(({ fieldFamily, productId }) => `${fieldFamily}\0${productId}`))).toHaveLength(verifies.length);
    }
  });

  it("rejects repeated, unsorted, malformed, and family-empty active bundle sets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-active-bundles-invalid-"));
    const path = join(directory, "active-bundles.json");
    for (const [value, family, message] of [
      [{ schemaVersion: 1, families: { ingredients: ["review-11111111111111111111"], nutrition: ["review-22222222222222222222", "review-22222222222222222222"] } }, "nutrition", /repeats/],
      [{ schemaVersion: 1, families: { ingredients: ["review-11111111111111111111"], nutrition: ["review-33333333333333333333", "review-22222222222222222222"] } }, "nutrition", /sorted/],
      [{ schemaVersion: 1, families: { ingredients: ["unsafe"], nutrition: ["review-22222222222222222222"] } }, "ingredients", /valid ingredients/],
      [{ schemaVersion: 1, families: { ingredients: [], nutrition: ["review-22222222222222222222"] } }, "ingredients", /valid ingredients/],
    ] as const) {
      await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
      await expect(readActiveReviewBundleSet(path, family)).rejects.toThrow(message);
    }
  });

  it("audits only selected active bundles and fails closed on missing or wrong-family selections", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-active-audit-"));
    const artifactDirectory = await nutritionArtifactFixture(directory);
    const bundlesDirectory = join(directory, "review-decisions");
    const selectedDecision = (await nutritionFixture({ id: "evd_selected" })).decision;
    const selected = await writeReviewDecisionBundle({
      decisions: [selectedDecision],
      outputRoot: bundlesDirectory,
      createdAt: "2026-07-17T03:00:00.000Z",
    });
    const superseded = await writeReviewDecisionBundle({
      decisions: [{ ...selectedDecision, rationale: "Superseded conflicting historical rationale" }],
      outputRoot: bundlesDirectory,
      createdAt: "2026-07-17T03:00:00.000Z",
    });
    expect(superseded.manifest.bundleId).not.toBe(selected.manifest.bundleId);

    const bundleSetFile = join(directory, "active-bundles.json");
    await writeActiveSet(bundleSetFile, [selected.manifest.bundleId]);
    const report = await auditDecisionDrift({ artifactDirectory, bundlesDirectory, bundleSetFile });
    expect(report.inputs).toMatchObject({
      bundleIds: [selected.manifest.bundleId],
      bundleCount: 1,
      decisionRecords: 1,
      uniqueDecisions: 1,
      duplicateDecisionRecords: 0,
    });
    expect(report.conflicts).toEqual([]);
    expect(report.findings.map(({ decisionId }) => decisionId)).toEqual(["evd_selected"]);

    await writeActiveSet(bundleSetFile, ["review-ffffffffffffffffffff"]);
    await expect(auditDecisionDrift({ artifactDirectory, bundlesDirectory, bundleSetFile })).rejects.toThrow();

    const wrongFamily = await writeReviewDecisionBundle({
      decisions: [await ingredientDecisionFixture()],
      outputRoot: bundlesDirectory,
      createdAt: "2026-07-17T03:00:00.000Z",
    });
    await writeActiveSet(bundleSetFile, [wrongFamily.manifest.bundleId]);
    await expect(auditDecisionDrift({ artifactDirectory, bundlesDirectory, bundleSetFile }))
      .rejects.toThrow("is not a pure nutrition bundle");
  });

  it("rejects every cross-bundle overlap forbidden by an active set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-active-overlaps-"));
    const artifactDirectory = await nutritionArtifactFixture(directory);
    const bundleSetFile = join(directory, "active-bundles.json");
    const base = (await nutritionFixture({ id: "evd_overlap_a" })).decision;
    const changed = (await nutritionFixture({ id: "evd_overlap_b", calories: 361 })).decision;
    const cases: Array<{ name: string; decisions: [EvidenceDecisionInput, EvidenceDecisionInput]; message: string }> = [
      {
        name: "decision-id",
        decisions: [base, { ...base, rationale: "Same immutable ID with different contents" }],
        message: "repeats a decision ID",
      },
      {
        name: "candidate-key",
        decisions: [base, { ...base, id: "evd_overlap_candidate", rationale: "Second decision for the same candidate" }],
        message: "repeats a candidate key",
      },
      {
        name: "source-key",
        decisions: [base, changed],
        message: "repeats a source key",
      },
      {
        name: "verified-product",
        decisions: [base, {
          ...changed,
          id: "evd_overlap_product",
          sourceRecordKey: "08900000000012:prediction-2",
          sourceRecordId: "src_fixture_2",
        }],
        message: "verifies one product more than once",
      },
    ];

    for (const overlap of cases) {
      const bundlesDirectory = join(directory, overlap.name);
      const bundles = await Promise.all(overlap.decisions.map((decision) => writeReviewDecisionBundle({
        decisions: [decision],
        outputRoot: bundlesDirectory,
        createdAt: "2026-07-17T03:00:00.000Z",
      })));
      await writeActiveSet(bundleSetFile, bundles.map(({ manifest }) => manifest.bundleId));
      await expect(auditDecisionDrift({ artifactDirectory, bundlesDirectory, bundleSetFile }))
        .rejects.toThrow(overlap.message);
    }
  });

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
