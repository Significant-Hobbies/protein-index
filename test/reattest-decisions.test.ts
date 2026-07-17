import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractRobotoffApi } from "../scripts/adapters/robotoff-api";
import { stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";
import { auditDecisionDrift, type DecisionDriftAuditReport } from "../scripts/decision-drift-audit";
import {
  exactLabelReattestationConfirmation,
  generateExactLabelReattestation,
  planExactLabelReattestation,
} from "../scripts/reattest-decisions";
import { readReviewDecisionBundle, writeReviewDecisionBundle, type ReviewEvidenceDecision } from "../scripts/review-bundles";
import { stagedProductId, stagedSourceRecordId } from "../scripts/adapters/label-image";
import { nutritionCandidateFromEvidence, type EvidenceDecisionInput } from "../shared/evidence-decisions";
import type { StagedProduct } from "../shared/types";

const DECIDED_AT = "2026-07-17T12:00:00.000Z";

function predecessorDecision(): EvidenceDecisionInput {
  const candidate = nutritionCandidateFromEvidence({
    code: "robotoff_nutrition_candidate",
    details: { candidate: {
      predictionId: "prediction-1",
      barcode: "08900000000012",
      imageId: "2",
      imageUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/2.jpg",
      modelName: "nutrition_extractor",
      modelVersion: "nutrition_extractor-2.0",
      observedAt: "2026-07-17T01:00:00.000Z",
      basis: "per_100g",
      minimumConfidence: 0.99,
      nutritionPer100g: {
        calories: 360,
        proteinGrams: 52,
        carbohydrateGrams: 20,
        sugarGrams: null,
        fatGrams: 8,
        saturatedFatGrams: null,
        fibreGrams: null,
        sodiumMg: null,
      },
    } },
  }, "08900000000012");
  if (!candidate) throw new Error("Fixture candidate is invalid");
  return {
    id: "evd_predecessor",
    sourceId: "open_food_facts_robotoff",
    sourceRecordKey: "08900000000012:prediction-1",
    sourceRecordId: "src_fixture",
    sourceContentHash: "a".repeat(64),
    productId: "prd_fixture",
    candidateHash: "b".repeat(64),
    fieldFamily: "nutrition",
    decision: "reject",
    payload: candidate,
    evidenceUrl: candidate.imageUrl,
    rationale: "Rejected against the exact package label.",
    decidedBy: "original_operator",
    decidedAt: "2026-07-17T02:00:00.000Z",
  };
}

function auditFixture(classification: DecisionDriftAuditReport["findings"][number]["classification"] = "source_revision_drift_candidate_unchanged"): DecisionDriftAuditReport {
  const predecessor = predecessorDecision();
  return {
    schemaVersion: 1,
    artifact: {
      directory: "artifact",
      fieldFamily: "nutrition",
      sourceId: "open_food_facts_robotoff",
      adapterVersion: "robotoff-api-v8",
      inputHash: "c".repeat(64),
      extractionRunId: "run-current",
      parentSourceRunId: "run-source",
      sourceComplete: true,
      candidateCount: 1,
    },
    inputs: {
      bundleSetFile: "active-bundles.json",
      bundleSetSha256: "d".repeat(64),
      bundleIds: ["review-00000000000000000000"],
      bundleCount: 1,
      decisionRecords: 1,
      uniqueDecisions: 1,
      duplicateDecisionRecords: 0,
      currentCandidates: 1,
    },
    classificationCounts: {
      candidate_key_active_state_ambiguous: 0,
      unsupported_source_or_family: 0,
      artifact_candidate_missing: 0,
      candidate_drift: 0,
      identity_drift: 0,
      source_revision_drift_candidate_unchanged: classification === "source_revision_drift_candidate_unchanged" ? 1 : 0,
      exact_proof_incomplete_or_inconsistent: 0,
      linked_proof_drift: 0,
      requires_selected_projection_state: 0,
      legacy_proof_match_requires_new_decision: 0,
      exact_link_valid: 0,
    },
    conflicts: [],
    findings: [{
      decisionId: predecessor.id,
      fieldFamily: "nutrition",
      decision: predecessor.decision,
      sourceId: predecessor.sourceId,
      sourceRecordKey: predecessor.sourceRecordKey,
      sourceRecordId: predecessor.sourceRecordId,
      sourceContentHash: predecessor.sourceContentHash,
      productId: predecessor.productId,
      candidateHash: predecessor.candidateHash,
      evidenceUrl: predecessor.evidenceUrl,
      extractionAttemptId: null,
      labelAssetId: null,
      classification,
      differences: classification === "source_revision_drift_candidate_unchanged" ? ["source_content_hash"] : ["candidate_hash"],
      current: {
        sourceRecordId: predecessor.sourceRecordId,
        sourceContentHash: "e".repeat(64),
        productId: predecessor.productId,
        gtin: "08900000000012",
        candidateHash: predecessor.candidateHash,
        evidenceUrl: predecessor.evidenceUrl,
        extractionAttemptId: `xat_${"1".repeat(24)}`,
        labelAssetId: `lbl_${"2".repeat(24)}`,
        labelContentSha256: "f".repeat(64),
        proofValid: true,
        proofIssues: [],
      },
      bundles: [{ bundleId: "review-00000000000000000000", directory: "review-00000000000000000000", ledgerSha256: "0".repeat(64) }],
    }],
    unreviewedCurrentCandidates: [],
    hasHardFailure: false,
  };
}

function plan(overrides: Partial<Parameters<typeof planExactLabelReattestation>[0]> = {}) {
  const audit = overrides.audit ?? auditFixture();
  const expectedDecisionCount = overrides.expectedDecisionCount ?? 1;
  return planExactLabelReattestation({
    audit,
    predecessors: [predecessorDecision()],
    fieldFamily: "nutrition",
    expectedDecisionCount,
    decidedBy: "sarthak",
    decidedAt: DECIDED_AT,
    confirmation: exactLabelReattestationConfirmation({
      fieldFamily: overrides.fieldFamily ?? "nutrition",
      extractionRunId: audit.artifact.extractionRunId,
      activeSetSha256: audit.inputs.bundleSetSha256 ?? "",
      decisionCount: expectedDecisionCount,
    }),
    ...overrides,
  });
}

async function nutritionArtifactFixture(root: string): Promise<string> {
  const input = join(root, "source.jsonl");
  const imageUrl = "https://images.openfoodfacts.org/images/products/890/000/000/0012/2.jpg";
  await writeFile(input, `${JSON.stringify({
    code: "8900000000012",
    product_name: "Re-attestation fixture",
    brands: "Fixture Brand",
    countries_tags: ["en:india"],
    quantity: "500 g",
    image_nutrition_url: imageUrl,
  })}\n`, "utf8");
  const source = await stageOpenFoodFacts({ input, outputDirectory: join(root, "source"), mode: "sample", limit: null });
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
    fetcher: async () => new Response(JSON.stringify({ image_predictions: [{
      id: "prediction-1",
      type: "nutrition_extraction",
      model_name: "nutrition_extractor",
      model_version: "nutrition_extractor-2.0",
      timestamp: "2026-07-17T01:00:00Z",
      image: { image_id: "2", source_image: "/890/000/000/0012/2.jpg", uploaded_at: "2026-07-17T00:00:00Z" },
      data: { nutrients: {
        "energy-kcal_100g": { value: "360", unit: "kcal", score: 0.99 },
        proteins_100g: { value: "52", unit: "g", score: 0.99 },
        carbohydrates_100g: { value: "20", unit: "g", score: 0.99 },
        fat_100g: { value: "8", unit: "g", score: 0.99 },
      } },
    }] }), { status: 200 }),
  });
  return artifactDirectory;
}

describe("exact label decision re-attestation", () => {
  it("creates deterministic immutable successors while preserving reviewed semantics", () => {
    const predecessor = predecessorDecision();
    const original = JSON.stringify(predecessor);
    const first = plan({ predecessors: [predecessor] });
    const second = plan({ predecessors: [predecessor] });
    expect(first).toEqual(second);
    expect(JSON.stringify(predecessor)).toBe(original);
    expect(first.replacements).toHaveLength(1);
    expect(first.replacements[0]).toMatchObject({
      id: expect.stringMatching(/^evd_reattest_[a-f0-9]{24}$/),
      decision: predecessor.decision,
      payload: predecessor.payload,
      candidateHash: predecessor.candidateHash,
      sourceContentHash: "e".repeat(64),
      extractionAttemptId: `xat_${"1".repeat(24)}`,
      labelAssetId: `lbl_${"2".repeat(24)}`,
      decidedBy: "sarthak",
      decidedAt: DECIDED_AT,
      rationale: expect.stringContaining(predecessor.id),
    });
  });

  it("rejects absent authority and malformed operator inputs before touching paths", async () => {
    for (const overrides of [
      { confirmation: "approved" },
      { decidedBy: "" },
      { decidedBy: " leading-space" },
      { decidedAt: "2026-07-17" },
      { decidedAt: "2026-07-17T12:00:00+00:00" },
    ]) expect(() => plan(overrides)).toThrow();

  });

  it("fails the whole batch for every non-source-only drift class and exact-proof mismatch", () => {
    for (const classification of [
      "candidate_key_active_state_ambiguous",
      "unsupported_source_or_family",
      "artifact_candidate_missing",
      "candidate_drift",
      "identity_drift",
      "exact_proof_incomplete_or_inconsistent",
      "linked_proof_drift",
      "requires_selected_projection_state",
      "legacy_proof_match_requires_new_decision",
      "exact_link_valid",
    ] as const) {
      expect(() => plan({ audit: auditFixture(classification) })).toThrow(/not source-revision-only/);
    }
    const invalidProof = auditFixture();
    if (invalidProof.findings[0]?.current) invalidProof.findings[0].current.proofValid = false;
    expect(() => plan({ audit: invalidProof })).toThrow(/invalid current proof/);
    const changedUrl = auditFixture();
    if (changedUrl.findings[0]?.current) changedUrl.findings[0].current.evidenceUrl = "https://images.openfoodfacts.org/different.jpg";
    expect(() => plan({ audit: changedUrl })).toThrow(/evidence URL differs/);
    for (const field of ["sourceContentHash", "labelContentSha256", "extractionAttemptId", "labelAssetId"] as const) {
      const malformed = auditFixture();
      if (malformed.findings[0]?.current) malformed.findings[0].current[field] = "malformed";
      expect(() => plan({ audit: malformed })).toThrow(/malformed exact-link identifiers/);
    }
  });

  it("rejects incomplete, extra, duplicate, and family-mixed predecessor selections", () => {
    expect(() => plan({ predecessors: [] })).toThrow(/exactly match/);
    expect(() => plan({ predecessors: [predecessorDecision(), { ...predecessorDecision(), id: "evd_extra" }] })).toThrow(/exactly match/);
    expect(() => plan({ predecessors: [predecessorDecision(), predecessorDecision()] })).toThrow(/duplicated/);
    expect(() => plan({ predecessors: [{ ...predecessorDecision(), fieldFamily: "ingredients" } as unknown as ReviewEvidenceDecision] }))
      .toThrow(/wrong family/);
    const duplicateAudit = auditFixture();
    duplicateAudit.inputs.duplicateDecisionRecords = 1;
    expect(() => plan({ audit: duplicateAudit })).toThrow(/incomplete, duplicated, or empty/);
    const keyCollisionAudit = auditFixture();
    const originalFinding = keyCollisionAudit.findings[0];
    if (!originalFinding?.current) throw new Error("Expected current fixture finding");
    const duplicateKeyFinding = {
      ...originalFinding,
      decisionId: "evd_same_source_different_candidate",
      candidateHash: "c".repeat(64),
      current: { ...originalFinding.current, candidateHash: "c".repeat(64) },
    };
    keyCollisionAudit.findings.push(duplicateKeyFinding);
    keyCollisionAudit.inputs.decisionRecords = 2;
    keyCollisionAudit.inputs.uniqueDecisions = 2;
    keyCollisionAudit.classificationCounts.source_revision_drift_candidate_unchanged = 2;
    expect(() => plan({
      audit: keyCollisionAudit,
      expectedDecisionCount: 2,
      predecessors: [predecessorDecision(), { ...predecessorDecision(), id: duplicateKeyFinding.decisionId, candidateHash: duplicateKeyFinding.candidateHash }],
    })).toThrow(/repeats an ID, candidate key, or source key/);
  });

  it("writes a portable bundle and proposed manifest only after a fresh all-exact-link audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-index-reattest-integration-"));
    const artifactDirectory = await nutritionArtifactFixture(root);
    const staged = JSON.parse((await readFile(join(artifactDirectory, "staged-products.jsonl"), "utf8")).trim()) as StagedProduct;
    const raw = staged.rawEvidence as { candidate: EvidenceDecisionInput["payload"]; candidateHash: string };
    const predecessor: EvidenceDecisionInput = {
      id: "evd_integration_predecessor",
      sourceId: "open_food_facts_robotoff",
      sourceRecordKey: staged.sourceRecordId,
      sourceRecordId: stagedSourceRecordId(staged),
      sourceContentHash: "0".repeat(64),
      productId: stagedProductId(staged),
      candidateHash: raw.candidateHash,
      fieldFamily: "nutrition",
      decision: "reject",
      payload: raw.candidate,
      evidenceUrl: raw.candidate.imageUrl,
      rationale: "Rejected against the exact fixture label.",
      decidedBy: "original_operator",
      decidedAt: "2026-07-17T02:00:00.000Z",
    };
    const bundlesDirectory = join(root, "review-decisions");
    const oldBundle = await writeReviewDecisionBundle({ decisions: [predecessor], outputRoot: bundlesDirectory, createdAt: DECIDED_AT });
    const canonicalPredecessor = (await readReviewDecisionBundle(oldBundle.directory)).decisions[0];
    if (!canonicalPredecessor) throw new Error("Expected one canonical predecessor decision");
    const oldLedger = await readFile(join(oldBundle.directory, "decisions.jsonl"), "utf8");
    const activeSetFile = join(root, "active-bundles.json");
    await writeFile(activeSetFile, `${JSON.stringify({
      schemaVersion: 1,
      families: { ingredients: ["review-00000000000000000000"], nutrition: [oldBundle.manifest.bundleId] },
    }, null, 2)}\n`, "utf8");
    const before = await auditDecisionDrift({ artifactDirectory, bundlesDirectory, bundleSetFile: activeSetFile });
    expect(before.classificationCounts.source_revision_drift_candidate_unchanged).toBe(1);

    const outputRoot = join(root, "proposed");
    const confirmation = exactLabelReattestationConfirmation({
      fieldFamily: "nutrition",
      extractionRunId: before.artifact.extractionRunId,
      activeSetSha256: before.inputs.bundleSetSha256 ?? "",
      decisionCount: 1,
    });
    const input = {
      artifactDirectory,
      bundlesDirectory,
      activeSetFile,
      fieldFamily: "nutrition" as const,
      expectedDecisionCount: 1,
      outputRoot,
      decidedBy: "sarthak",
      decidedAt: DECIDED_AT,
      confirmation,
    };
    const rejectedOutput = join(root, "rejected-proposed");
    await expect(generateExactLabelReattestation({ ...input, outputRoot: rejectedOutput, confirmation: "approved" }))
      .rejects.toThrow(/does not bind the exact artifact/);
    await expect(stat(rejectedOutput)).rejects.toMatchObject({ code: "ENOENT" });
    for (const invalidInput of [
      { decidedBy: " bad-reviewer" },
      { decidedAt: "2026-07-17" },
    ]) {
      const invalidOutput = join(root, `invalid-${invalidInput.decidedBy ? "reviewer" : "time"}`);
      await expect(generateExactLabelReattestation({ ...input, ...invalidInput, outputRoot: invalidOutput }))
        .rejects.toThrow();
      await expect(stat(invalidOutput)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const first = await generateExactLabelReattestation(input);
    const second = await generateExactLabelReattestation(input);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      predecessorCount: 1,
      replacementCount: 1,
      exactLinkAudit: { exactLinkValid: 1, uniqueDecisions: 1, conflicts: 0, hasHardFailure: false },
    });
    expect(await readFile(join(oldBundle.directory, "decisions.jsonl"), "utf8")).toBe(oldLedger);
    const replacement = await readReviewDecisionBundle(join(outputRoot, first.replacementBundle.bundleId));
    expect(replacement.manifest.decisionCount).toBe(1);
    expect(replacement.decisions[0]).toMatchObject({
      decision: canonicalPredecessor.decision,
      payload: canonicalPredecessor.payload,
      sourceContentHash: staged.contentHash,
      extractionAttemptId: expect.stringMatching(/^xat_[a-f0-9]{24}$/),
      labelAssetId: expect.stringMatching(/^lbl_[a-f0-9]{24}$/),
    });
    const next = JSON.parse(await readFile(join(outputRoot, "active-bundles.next.json"), "utf8")) as {
      families: { nutrition: string[]; ingredients: string[] };
    };
    expect(next.families.nutrition).toEqual([first.replacementBundle.bundleId]);
    expect(next.families.ingredients).toEqual(["review-00000000000000000000"]);
  });
});
