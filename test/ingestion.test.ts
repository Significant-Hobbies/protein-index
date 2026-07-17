import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { normalizeOpenFoodFactsRecord, stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";
import { enrichOpenFoodFactsApi } from "../scripts/adapters/open-food-facts-api";
import { extractRobotoffApi, validateRobotoffNutritionArtifact } from "../scripts/adapters/robotoff-api";
import { extractRobotoffIngredientApi, validateRobotoffIngredientArtifact } from "../scripts/adapters/robotoff-ingredients-api";
import { parseRobotoffIngredientEvidence } from "../scripts/adapters/robotoff-ingredients";
import { parseRobotoffNutritionEvidence, type RobotoffProductContext } from "../scripts/adapters/robotoff";
import {
  AUTOMATIC_PUBLICATION_FAMILIES,
  automaticPublicationContract,
  assertAutomaticPublicationPostconditions,
  assertIdempotentPublicationReplay,
  assertNoPendingD1Migrations,
  assertPublicationEvidence,
  parsePublicationState,
  publicationStateQuery,
  validateAutomaticPublicationSnapshot,
  type AutomaticPublicationInput,
  type ExactExtractionSnapshot,
  type PublicationState,
} from "../scripts/publication";
import { emitImportSql } from "../scripts/reconcile";
import {
  evidenceDecisionFromDatabaseRow,
  emitReviewDecisionSql,
  emitReviewSourceStateQuery,
  readReviewDecisionBundle,
  validateExistingEvidenceDecisions,
  validateReviewPostconditions,
  validateReviewPublicationState,
  validateReviewDecisionSources,
  writeReviewDecisionBundle,
} from "../scripts/review-bundles";

import {
  canonicalJson,
  nutritionCandidateFromEvidence,
  nutritionCandidateHash,
  nutritionCandidateNormalizedBasis,
  nutritionCandidateValues,
  type EvidenceDecisionInput,
} from "../shared/evidence-decisions";
import { ingredientCandidateHash, type IngredientEvidenceDecisionInput } from "../shared/ingredient-evidence";
import { parseIngredients } from "../shared/ingredients";
import type { SourceManifest } from "../shared/types";

const labelImageFetcher = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
  status: 200,
  headers: { "content-type": "image/jpeg", "content-length": "4" },
});

const indiaProduct = {
  code: "8900000000012",
  product_name: "Test Soya Chunks",
  brands: "Test Brand",
  countries_tags: ["en:india"],
  quantity: "500 g",
  serving_size: "50 g",
  categories_tags: ["en:soy-products"],
  ingredients_text: "Defatted soy flour 100%",
  allergens_tags: ["en:soybeans"],
  nutriments: {
    "energy-kcal_100g": 345,
    proteins_100g: 52,
    carbohydrates_100g: 33,
    sugars_100g: 7,
    fat_100g: 1,
    "saturated-fat_100g": 0.2,
    fiber_100g: 13,
    sodium_100g: 0.025,
    calcium_100g: 0.35,
  },
  last_modified_t: 1_752_537_600,
};

const automaticInput = (overrides: Partial<AutomaticPublicationInput> = {}): AutomaticPublicationInput => ({
  workflowName: "Source sync",
  runId: 123,
  headSha: "a".repeat(40),
  headBranch: "main",
  repository: "Significant-Hobbies/protein-index",
  artifactName: "open-food-facts-snapshot-123",
  artifactDigest: `sha256:${"b".repeat(64)}`,
  artifactBytes: 1_024,
  ...overrides,
});

async function writeAutomaticArtifact(input: {
  directory: string;
  source?: SourceManifest["source"];
  product?: Record<string, unknown>;
  report?: Record<string, unknown>;
}): Promise<void> {
  const normalized = normalizeOpenFoodFactsRecord(indiaProduct).staged;
  if (!normalized) throw new Error("Expected the Open Food Facts fixture to normalize");
  const product: Record<string, unknown> = input.product ?? { ...normalized };
  const source = input.source ?? "open_food_facts";
  product.source = source;
  const now = "2026-07-16T10:00:00.000Z";
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source,
    sourceKind: "open_data",
    sourceAuthority: source === "open_food_facts_robotoff"
      ? { identity: 0, nutrition: 20, ingredients: 0 }
      : { identity: 40, nutrition: 35, ingredients: 35 },
    sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    sourceRetentionNotes: "Automatic publication test fixture",
    adapterVersion: "test-v1",
    input: "fixture",
    inputHash: "b".repeat(64),
    inputBytes: 1,
    sourceUpdatedAt: now,
    startedAt: now,
    completedAt: now,
    mode: "production",
    terminalEvidence: "end_of_file",
    sourceComplete: true,
    marketComplete: false,
    advertisedTotal: 1,
    recordsRead: 1,
    indiaRecords: 1,
    stagedRecords: 1,
    invalidRecords: 0,
    duplicateRecords: 0,
    newRecords: 1,
    changedRecords: 0,
    unchangedRecords: 0,
    missingSinceRecords: 0,
    knownExclusions: [],
    disconnectedSources: [],
  };
  const barcodeAccounted = source !== "open_food_facts";
  const report = input.report ?? {
    sourceComplete: true,
    marketComplete: false,
    ...(barcodeAccounted ? { requestedBarcodes: 1, accountedBarcodes: 1, outcomes: { failed: 0 } } : {}),
    continuity: { currentStagedRecords: 1, previousStagedRecords: 1, missingSinceRecords: 0, maximumDropRatio: 0.2 },
    exclusions: { records: 0, reconcilesIndiaSlice: true },
  };
  const files = new Map<string, string>([
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["report.json", `${JSON.stringify(report, null, 2)}\n`],
    ["source-index.jsonl", `${JSON.stringify({ sourceRecordId: product.sourceRecordId, contentHash: product.contentHash })}\n`],
    ["exclusions.jsonl", ""],
    ["staged-products.jsonl", `${JSON.stringify(product)}\n`],
  ]);
  if (barcodeAccounted) files.set("outcomes.jsonl", `${JSON.stringify({ requestedCode: product.sourceRecordId, status: "enriched" })}\n`);
  for (const [name, contents] of files) await writeFile(join(input.directory, name), contents, "utf8");
  const checksums = [...files].map(([name, contents]) => `${createHash("sha256").update(contents).digest("hex")}  ${name}`);
  await writeFile(join(input.directory, "checksums.sha256"), `${checksums.join("\n")}\n`, "utf8");
}

const ingredientPrediction = {
  id: 10477207,
  type: "ner",
  model_name: "ingredient_detection",
  model_version: "ingredient-detection-1.0",
  timestamp: "2024-08-12T15:45:02.473405",
  image: {
    barcode: "0001241000224",
    uploaded_at: "2024-08-10T04:07:50",
    image_id: "2",
    source_image: "/000/124/100/0224/2.jpg",
  },
  data: {
    entities: [{
      lang: { lang: "en", confidence: 0.61748207 },
      text: "Casein, Sucrose, Precooked Rice Flour, Edible Vegetable R Solids, Bengal Gram.",
      score: 0.9999909996986389,
      ingredients: [
        { id: "en:casein", text: "Casein", in_taxonomy: true },
        { id: "en:sucrose", text: "Sucrose", in_taxonomy: true },
        { id: "en:rice-flour", text: "Rice Flour", in_taxonomy: true },
        { id: "en:edible-vegetable-r-solids", text: "Edible Vegetable R Solids", in_taxonomy: false },
        { id: "en:bengal-gram", text: "Bengal Gram", in_taxonomy: false },
      ],
      bounding_box: [52, 79, 305, 1568],
      ingredients_n: 8,
      known_ingredients_n: 4,
      unknown_ingredients_n: 4,
    }],
  },
};

describe("Robotoff ingredient evidence", () => {
  const context = {
    code: "00001241000224",
    ingredientImageUrl: "https://images.openfoodfacts.org/images/products/000/124/100/0224/2.jpg",
  };

  it("fails closed for response-only legacy artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-ingredients-legacy-"));
    await expect(validateRobotoffIngredientArtifact(directory)).rejects.toThrow("label-assets.jsonl is required");
  });

  it("parses the official ingredient-detection entity shape without verifying it", () => {
    const parsed = parseRobotoffIngredientEvidence({ image_predictions: [
      ingredientPrediction,
      { ...ingredientPrediction, id: 1, type: "nutrition_extraction", model_name: "nutrition_extractor" },
    ] }, context);
    expect(parsed).toMatchObject({ predictionCount: 1, entityCount: 1, hasConflict: false });
    expect(parsed.candidates[0]).toMatchObject({
      predictionId: "10477207",
      entityIndex: 0,
      barcode: "0001241000224",
      imageId: "2",
      modelName: "ingredient_detection",
      modelVersion: "ingredient-detection-1.0",
      language: { code: "en", confidence: 0.61748207 },
      ingredientCount: 8,
      knownIngredientCount: 4,
      unknownIngredientCount: 4,
    });
    expect(parsed.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_ingredient_low_taxonomy_recognition",
      severity: "warning",
    }));
  });

  it("rejects low-confidence and identity-mismatched entities", () => {
    const lowConfidence = {
      ...ingredientPrediction,
      data: { entities: [{ ...ingredientPrediction.data.entities[0], score: 0.5 }] },
    };
    expect(parseRobotoffIngredientEvidence({ image_predictions: [lowConfidence] }, context).issues)
      .toContainEqual(expect.objectContaining({ code: "robotoff_ingredient_low_confidence" }));
    const wrongIdentity = {
      ...ingredientPrediction,
      image: { ...ingredientPrediction.image, barcode: "8900000000012" },
    };
    expect(parseRobotoffIngredientEvidence({ image_predictions: [wrongIdentity] }, context).issues)
      .toContainEqual(expect.objectContaining({ code: "robotoff_ingredient_identity_mismatch" }));
  });

  it("keeps materially different image text candidates and marks their conflict", () => {
    const conflicting = {
      ...ingredientPrediction,
      id: 10477208,
      image: { ...ingredientPrediction.image, image_id: "3", source_image: "/000/124/100/0224/3.jpg" },
      data: { entities: [{
        ...ingredientPrediction.data.entities[0],
        text: "Casein, Sucrose, Peanut Flour.",
      }] },
    };
    const parsed = parseRobotoffIngredientEvidence({ image_predictions: [ingredientPrediction, conflicting] }, context);
    expect(parsed).toMatchObject({ predictionCount: 2, entityCount: 2, hasConflict: true });
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.issues.filter(({ code }) => code === "robotoff_ingredient_image_conflict")).toHaveLength(2);
  });

  it("collects the exact ingredient-image cohort and resumes per GTIN", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-ingredients-"));
    const input = join(directory, "source.jsonl");
    await writeFile(input, `${JSON.stringify({
      ...indiaProduct,
      code: "00001241000224",
      image_ingredients_url: context.ingredientImageUrl,
    })}\n`, "utf8");
    const source = await stageOpenFoodFacts({
      input,
      outputDirectory: join(directory, "source"),
      mode: "production",
      limit: null,
    });
    const outputDirectory = join(directory, "extracted");
    let requests = 0;
    const first = await extractRobotoffIngredientApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      labelFetcher: labelImageFetcher,
      fetcher: async (request) => {
        requests += 1;
        const url = new URL(request.toString());
        expect(url.searchParams.get("type")).toBe("ner");
        expect(url.searchParams.get("model_name")).toBe("ingredient_detection");
        expect(url.searchParams.get("barcode")).toBe("00001241000224");
        return new Response(JSON.stringify({ image_predictions: [ingredientPrediction] }), { status: 200 });
      },
    });
    expect(requests).toBe(1);
    expect(first).toMatchObject({
      contexts: 1,
      outcomes: { candidate: 1, no_prediction: 0, rejected: 0, failed: 0 },
      fetchedBarcodes: 1,
      resumedBarcodes: 0,
    });
    expect(first.manifest.adapterVersion).toBe("robotoff-ingredients-api-v3");
    const candidates = (await readFile(first.candidatesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      requestedCode: "00001241000224",
      candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      candidate: { predictionId: "10477207", entityIndex: 0 },
    });
    const staged = (await readFile(first.stagedPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      source: "open_food_facts_robotoff_ingredients",
      ingredients: { raw: null, status: "missing" },
      rawEvidence: {
        candidateHash: candidates[0].candidateHash,
        candidate: { predictionId: "10477207", entityIndex: 0 },
      },
      validationIssues: [{
        code: "robotoff_ingredient_candidate",
        details: { candidateHash: candidates[0].candidateHash },
      }],
    });
    const sqlPath = join(outputDirectory, "import.sql");
    await emitImportSql({ stagedPath: first.stagedPath, manifestPath: first.manifestPath, outputPath: sqlPath });
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("'ingredient_conflict'");
    expect(sql).toContain(candidates[0].candidateHash);
    expect(sql).toContain("INSERT INTO ingredient_statements");
    expect(sql).toContain("d.field_family = 'ingredients'");
    expect(sql).toContain("d.decision = 'verify'");
    expect(sql).toContain("WITH RECURSIVE decision AS");
    expect(sql).toContain("decision = CASE");
    expect(sql).toContain("'verify_ingredients'");
    expect(sql).not.toContain("VALUES ('prd_b0e8e3fe90558cbe96e938b1', 'src_");
    expect(sql).not.toContain("verified_nutrition");
    await expect(validateRobotoffIngredientArtifact(outputDirectory)).resolves.toMatchObject({
      report: {
        requestedBarcodes: 1,
        accountedBarcodes: 1,
        candidateRecords: 1,
        modelVersions: { "ingredient-detection-1.0": 1 },
        languages: { en: 1 },
        taxonomyRecognition: { belowSixtyPercent: 1, atLeastSixtyPercent: 0 },
      },
    });
    await writeFile(
      join(outputDirectory, "prior-label-assets.jsonl"),
      await readFile(first.labelAssetsPath, "utf8"),
      "utf8",
    );

    const resumed = await extractRobotoffIngredientApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: async () => { throw new Error("restored exact label proof should not be fetched again"); },
      fetcher: async () => { throw new Error("completed GTIN should not be fetched again"); },
    });
    expect(resumed).toMatchObject({ fetchedBarcodes: 0, resumedBarcodes: 1, outcomes: { candidate: 1 } });
  });

  it("retries ingredient requests and records terminal failure evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-ingredients-failure-"));
    const input = join(directory, "source.jsonl");
    await writeFile(input, `${JSON.stringify({
      ...indiaProduct,
      code: "00001241000224",
      image_ingredients_url: context.ingredientImageUrl,
    })}\n`, "utf8");
    const source = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
    let attempts = 0;
    const outputDirectory = join(directory, "extracted");
    await expect(extractRobotoffIngredientApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      labelFetcher: labelImageFetcher,
      fetcher: async () => {
        attempts += 1;
        return new Response("busy", { status: 503 });
      },
    })).rejects.toThrow("incomplete");
    expect(attempts).toBe(2);
    const outcome = JSON.parse((await readFile(join(outputDirectory, "outcomes.jsonl"), "utf8")).trim());
    expect(outcome).toMatchObject({ requestedCode: "00001241000224", status: "failed" });
    await expect(validateRobotoffIngredientArtifact(outputDirectory)).rejects.toThrow("not source complete");
  });

  it("keeps exact multi-image and multi-entity ingredient outcomes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-ingredients-mixed-"));
    const input = join(directory, "source.jsonl");
    await writeFile(input, `${JSON.stringify({
      ...indiaProduct,
      code: "00001241000224",
      image_ingredients_url: context.ingredientImageUrl,
    })}\n`, "utf8");
    const source = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
    const second = {
      ...ingredientPrediction,
      id: 10477208,
      image: { ...ingredientPrediction.image, image_id: "3", source_image: "/000/124/100/0224/3.jpg" },
      data: {
        entities: [
          { ...ingredientPrediction.data.entities[0], text: "Casein, Sucrose, Peanut Flour." },
          { ...ingredientPrediction.data.entities[0], text: "Casein and cocoa." },
        ],
      },
    };
    const result = await extractRobotoffIngredientApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "extracted"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: labelImageFetcher,
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [ingredientPrediction, second] }), { status: 200 }),
    });
    const artifact = await validateRobotoffIngredientArtifact(join(directory, "extracted"));
    expect(result.report).toMatchObject({ labelAssets: 2, extractionAttempts: 1, extractionAttemptLabels: 2 });
    expect(artifact.extractionAttempts[0]).toMatchObject({ predictionCount: 2, candidateCount: 3, conflictCount: 3 });
    expect(artifact.extractionAttemptLabels).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "requested", candidateCount: 1 }),
      expect.objectContaining({ role: "prediction", candidateCount: 2 }),
    ]));
  });

  it("rejects tampered ingredient extraction artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-ingredients-tamper-"));
    const input = join(directory, "source.jsonl");
    await writeFile(input, `${JSON.stringify({
      ...indiaProduct,
      code: "00001241000224",
      image_ingredients_url: context.ingredientImageUrl,
    })}\n`, "utf8");
    const source = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
    const outputDirectory = join(directory, "extracted");
    const result = await extractRobotoffIngredientApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: labelImageFetcher,
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [ingredientPrediction] }), { status: 200 }),
    });
    const originalCandidates = await readFile(result.candidatesPath, "utf8");
    await writeFile(result.candidatesPath, `${originalCandidates} `, "utf8");
    await expect(validateRobotoffIngredientArtifact(outputDirectory)).rejects.toThrow("checksum mismatch");
    await writeFile(result.candidatesPath, originalCandidates, "utf8");
    const responsePath = join(outputDirectory, "responses", "00001241000224.json");
    const originalResponse = await readFile(responsePath, "utf8");
    expect(await readFile(result.checksumsPath, "utf8")).toContain("responses/00001241000224.json");
    await writeFile(responsePath, `${originalResponse} `, "utf8");
    await expect(validateRobotoffIngredientArtifact(outputDirectory)).rejects.toThrow("responses/00001241000224.json");
  });
});

async function reviewDecision(id: string, decision: "verify" | "reject" = "verify"): Promise<EvidenceDecisionInput> {
  const evidence = {
    code: "robotoff_nutrition_candidate",
    details: { candidate: {
      predictionId: `prediction-${id}`,
      barcode: "8900000000012",
      imageId: `image-${id}`,
      imageUrl: `https://images.openfoodfacts.org/${id}.jpg`,
      modelName: "nutrition_extractor",
      modelVersion: "nutrition_extractor-2.0",
      observedAt: "2026-07-15T00:00:00.000Z",
      basis: "per_100g",
      minimumConfidence: 0.95,
      nutritionPer100g: {
        calories: 365, proteinGrams: 25, carbohydrateGrams: 46.5, sugarGrams: 4,
        fatGrams: 8.9, saturatedFatGrams: 2, fibreGrams: 5, sodiumMg: 250,
      },
    } },
  };
  const candidate = nutritionCandidateFromEvidence(evidence, "08900000000012");
  if (!candidate) throw new Error("Expected valid review fixture candidate");
  return {
    id,
    sourceId: "open_food_facts_robotoff",
    sourceRecordKey: `8900000000012:prediction-${id}`,
    sourceRecordId: `src_${id}`,
    sourceContentHash: `source_${id}`,
    productId: "prd_fixture",
    candidateHash: await nutritionCandidateHash(candidate),
    fieldFamily: "nutrition",
    decision,
    payload: candidate,
    evidenceUrl: candidate.imageUrl,
    rationale: `Reviewed decision ${id}`,
    decidedBy: "local_operator",
    decidedAt: "2026-07-15T01:00:00.000Z",
  };
}

async function volumeReviewDecision(id: string): Promise<EvidenceDecisionInput> {
  const evidence = {
    code: "robotoff_nutrition_candidate",
    details: { candidate: {
      predictionId: `prediction-${id}`,
      barcode: "8900000000012",
      imageId: `image-${id}`,
      imageUrl: `https://images.openfoodfacts.org/${id}.jpg`,
      modelName: "nutrition_extractor",
      modelVersion: "nutrition_extractor-2.0",
      observedAt: "2026-07-15T00:00:00.000Z",
      basis: "per_100ml",
      minimumConfidence: 0.96,
      nutritionPer100ml: {
        calories: 50, proteinGrams: 10, carbohydrateGrams: 1, sugarGrams: 0,
        fatGrams: 0.5, saturatedFatGrams: 0.1, fibreGrams: 0, sodiumMg: 20,
      },
    } },
  };
  const candidate = nutritionCandidateFromEvidence(evidence, "08900000000012");
  if (!candidate) throw new Error("Expected valid volume review fixture candidate");
  return {
    id,
    sourceId: "open_food_facts_robotoff",
    sourceRecordKey: `8900000000012:prediction-${id}`,
    sourceRecordId: `src_${id}`,
    sourceContentHash: `source_${id}`,
    productId: "prd_volume_fixture",
    candidateHash: await nutritionCandidateHash(candidate),
    fieldFamily: "nutrition",
    decision: "verify",
    payload: candidate,
    evidenceUrl: candidate.imageUrl,
    rationale: `Reviewed volume decision ${id}`,
    decidedBy: "local_operator",
    decidedAt: "2026-07-15T01:00:00.000Z",
  };
}

async function ingredientReviewDecision(id: string): Promise<IngredientEvidenceDecisionInput> {
  const parsed = parseRobotoffIngredientEvidence(
    { image_predictions: [ingredientPrediction] },
    {
      code: "00001241000224",
      ingredientImageUrl: "https://images.openfoodfacts.org/images/products/000/124/100/0224/2.jpg",
    },
  );
  const candidate = parsed.candidates[0];
  if (!candidate) throw new Error("Expected valid ingredient review fixture candidate");
  const reviewedText = "Casein, sucrose, precooked rice flour, Bengal gram";
  return {
    id,
    sourceId: "open_food_facts_robotoff_ingredients",
    sourceRecordKey: `00001241000224:${candidate.predictionId}:${candidate.entityIndex}`,
    sourceRecordId: `src_${id}`,
    sourceContentHash: `source_${id}`,
    productId: "prd_ingredient_fixture",
    candidateHash: await ingredientCandidateHash(candidate),
    fieldFamily: "ingredients",
    decision: "verify",
    payload: { candidate, reviewedText, normalizedIngredients: parseIngredients(reviewedText) },
    evidenceUrl: candidate.imageUrl,
    rationale: "Corrected visible OCR artifacts against the current ingredient label",
    decidedBy: "local_operator",
    decidedAt: "2026-07-15T01:00:00.000Z",
  };
}

describe("Reviewed evidence bundles", () => {
  it("round-trips exact extraction links while keeping legacy decision pairs null", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-linked-review-bundle-"));
    const legacy = await reviewDecision("evd_link_legacy", "reject");
    const linkedNutrition: EvidenceDecisionInput = {
      ...await reviewDecision("evd_link_nutrition", "reject"),
      extractionAttemptId: `xat_${"a".repeat(24)}`,
      labelAssetId: `lbl_${"b".repeat(24)}`,
    };
    const linkedIngredients: IngredientEvidenceDecisionInput = {
      ...await ingredientReviewDecision("evd_link_ingredients"),
      extractionAttemptId: `xat_${"c".repeat(24)}`,
      labelAssetId: `lbl_${"d".repeat(24)}`,
    };
    const written = await writeReviewDecisionBundle({
      decisions: [linkedNutrition, legacy, linkedIngredients],
      outputRoot: directory,
      createdAt: "2026-07-17T02:00:00.000Z",
    });
    const parsed = await readReviewDecisionBundle(written.directory);
    expect(parsed.decisions.find(({ id }) => id === linkedNutrition.id)).toMatchObject({
      extractionAttemptId: linkedNutrition.extractionAttemptId,
      labelAssetId: linkedNutrition.labelAssetId,
    });
    expect(parsed.decisions.find(({ id }) => id === linkedIngredients.id)).toMatchObject({
      extractionAttemptId: linkedIngredients.extractionAttemptId,
      labelAssetId: linkedIngredients.labelAssetId,
    });
    expect(parsed.decisions.find(({ id }) => id === legacy.id)).not.toHaveProperty("extractionAttemptId");

    const sqlPath = join(directory, "linked-review.sql");
    await emitReviewDecisionSql(parsed, sqlPath);
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("extraction_attempt_id, label_asset_id");
    expect(sql).toContain(`'${linkedNutrition.extractionAttemptId}', '${linkedNutrition.labelAssetId}'`);
    expect(sql).toContain(`'${linkedIngredients.extractionAttemptId}', '${linkedIngredients.labelAssetId}'`);

    const linkedRow = {
      id: linkedNutrition.id,
      source_id: linkedNutrition.sourceId,
      source_record_key: linkedNutrition.sourceRecordKey,
      source_record_id: linkedNutrition.sourceRecordId,
      source_content_hash: linkedNutrition.sourceContentHash,
      product_id: linkedNutrition.productId,
      candidate_hash: linkedNutrition.candidateHash,
      extraction_attempt_id: linkedNutrition.extractionAttemptId,
      label_asset_id: linkedNutrition.labelAssetId,
      field_family: linkedNutrition.fieldFamily,
      decision: linkedNutrition.decision,
      payload_json: canonicalJson(linkedNutrition.payload),
      evidence_url: linkedNutrition.evidenceUrl,
      rationale: linkedNutrition.rationale,
      decided_by: linkedNutrition.decidedBy,
      decided_at: linkedNutrition.decidedAt,
    };
    expect(evidenceDecisionFromDatabaseRow(linkedRow)).toMatchObject({
      extractionAttemptId: linkedNutrition.extractionAttemptId,
      labelAssetId: linkedNutrition.labelAssetId,
    });
    expect(evidenceDecisionFromDatabaseRow({
      ...linkedRow,
      id: legacy.id,
      source_record_key: legacy.sourceRecordKey,
      source_record_id: legacy.sourceRecordId,
      source_content_hash: legacy.sourceContentHash,
      candidate_hash: legacy.candidateHash,
      payload_json: canonicalJson(legacy.payload),
      evidence_url: legacy.evidenceUrl,
      rationale: legacy.rationale,
      extraction_attempt_id: null,
      label_asset_id: null,
    })).not.toHaveProperty("extractionAttemptId");

    const linkedOnly = { ...parsed, decisions: [linkedNutrition] };
    expect(() => validateExistingEvidenceDecisions(linkedOnly, [evidenceDecisionFromDatabaseRow(linkedRow)]))
      .not.toThrow();
    expect(() => validateExistingEvidenceDecisions(linkedOnly, [{
      ...linkedNutrition,
      labelAssetId: `lbl_${"e".repeat(24)}`,
    }])).toThrow("conflicts with an existing decision id");
    await expect(writeReviewDecisionBundle({
      decisions: [{ ...linkedNutrition, labelAssetId: null }],
      outputRoot: join(directory, "partial"),
    })).rejects.toThrow("exact attempt and label asset ID");
  });

  it("round-trips ingredient decisions in the backward-compatible reviewed bundle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-ingredient-review-bundle-"));
    const nutrition = await reviewDecision("evd_nutrition", "verify");
    const ingredients = await ingredientReviewDecision("evd_ingredients");
    const written = await writeReviewDecisionBundle({
      decisions: [nutrition, ingredients],
      outputRoot: directory,
      createdAt: "2026-07-15T02:00:00.000Z",
    });
    const parsed = await readReviewDecisionBundle(written.directory);
    expect(parsed.manifest).toMatchObject({ decisionCount: 2, verifyCount: 2, rejectCount: 0 });
    expect(parsed.decisions.map(({ fieldFamily }) => fieldFamily).sort()).toEqual(["ingredients", "nutrition"]);
    const ingredientDecision = parsed.decisions.find(({ fieldFamily }) => fieldFamily === "ingredients");
    expect(ingredientDecision).toMatchObject({
      fieldFamily: "ingredients",
      payload: { reviewedText: ingredients.payload.reviewedText, normalizedIngredients: ingredients.payload.normalizedIngredients },
    });
    const sqlPath = join(directory, "ingredient-review.sql");
    await emitReviewDecisionSql(parsed, sqlPath);
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("'ingredients', 'verify'");
    expect(sql).toContain("'verify_ingredients'");
    expect(sql).toContain("INSERT INTO ingredient_statements");
    expect(sql).toContain("INSERT INTO product_ingredients");
    expect(sql).toContain("'ingredients.raw'");
    expect(sql).toContain("'ingredients', 'verified'");

    const whitespaceCandidate = { ...ingredients.payload.candidate, entityText: "Casein,  sucrose" };
    const whitespaceDecision: IngredientEvidenceDecisionInput = {
      ...ingredients,
      id: "evd_ingredient_whitespace",
      sourceRecordKey: `00001241000224:${whitespaceCandidate.predictionId}:${whitespaceCandidate.entityIndex}:whitespace`,
      sourceRecordId: "src_ingredient_whitespace",
      sourceContentHash: "source_ingredient_whitespace",
      candidateHash: await ingredientCandidateHash(whitespaceCandidate),
      payload: {
        ...ingredients.payload,
        candidate: whitespaceCandidate,
        reviewedText: "Casein,  sucrose",
        normalizedIngredients: parseIngredients("Casein, sucrose"),
      },
      rationale: "Preserve  exact label spacing",
    };
    const whitespaceBundle = await writeReviewDecisionBundle({
      decisions: [whitespaceDecision],
      outputRoot: join(directory, "whitespace"),
      createdAt: "2026-07-15T02:00:00.000Z",
    });
    const whitespaceSqlPath = join(directory, "ingredient-whitespace.sql");
    await emitReviewDecisionSql(whitespaceBundle, whitespaceSqlPath);
    const whitespaceSql = await readFile(whitespaceSqlPath, "utf8");
    expect(whitespaceSql).toContain('"entityText":"Casein,  sucrose"');
    expect(whitespaceSql).toContain("Preserve  exact label spacing");

    const ingredientOnly = await writeReviewDecisionBundle({
      decisions: [ingredients],
      outputRoot: join(directory, "ingredient-only"),
      createdAt: "2026-07-15T02:00:00.000Z",
    });
    const exact = ingredientOnly.decisions[0];
    if (!exact || exact.fieldFamily !== "ingredients") throw new Error("Expected ingredient-only reviewed bundle");
    const row = {
      id: exact.id,
      source_id: exact.sourceId,
      source_record_key: exact.sourceRecordKey,
      source_record_id: exact.sourceRecordId,
      source_content_hash: exact.sourceContentHash,
      product_id: exact.productId,
      candidate_hash: exact.candidateHash,
      field_family: exact.fieldFamily,
      decision: exact.decision,
      payload_json: canonicalJson(exact.payload),
      evidence_url: exact.evidenceUrl,
      rationale: exact.rationale,
      decided_by: exact.decidedBy,
      decided_at: exact.decidedAt,
    };
    const ingredientRows = exact.payload.normalizedIngredients.map((ingredient) => ({
      id: `ing_${createHash("sha256").update(`${exact.id}:${ingredient.position}`).digest("hex").slice(0, 24)}`,
      product_id: exact.productId,
      source_record_id: exact.sourceRecordId,
      parent_id: null,
      position: ingredient.position,
      raw_text: ingredient.raw,
      normalized_name: ingredient.normalizedName,
      percentage: ingredient.percentage,
      resolved: ingredient.normalizedName === null ? 0 : 1,
    }));
    expect(validateReviewPostconditions(ingredientOnly, [
      { success: true, results: [row] },
      { success: true, results: [] },
      { success: true, results: [{
        product_id: exact.productId,
        source_record_id: exact.sourceRecordId,
        raw_text: exact.payload.reviewedText,
        language: exact.payload.candidate.language.code,
        status: "verified",
        confidence: "high",
        authority: 100,
        observed_at: exact.payload.candidate.observedAt,
        updated_at: exact.decidedAt,
      }] },
      { success: true, results: ingredientRows },
      { success: true, results: [{
        product_id: exact.productId,
        field_family: "ingredients",
        outcome: "verified",
        source_record_id: exact.sourceRecordId,
        evidence_url: exact.evidenceUrl,
        observed_at: exact.payload.candidate.observedAt,
        verified_at: exact.decidedAt,
        decided_by: exact.decidedBy,
      }] },
      { success: true, results: [] },
      { success: true, results: [{
        redundant_facts: 0,
        redundant_outcomes: 0,
        redundant_observations: 0,
        redundant_nutrients: 0,
      }] },
    ])).toMatchObject({ decisions: 1, verifiedFacts: 1, verifiedOutcomes: 1, unresolvedCandidates: 0 });
  });

  it("exports deterministic sorted ledgers and validates exact source linkage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-review-bundle-"));
    const second = await reviewDecision("evd_b", "reject");
    const first = await reviewDecision("evd_a", "verify");
    const left = await writeReviewDecisionBundle({
      decisions: [second, first],
      outputRoot: join(directory, "left"),
      createdAt: "2026-07-15T02:00:00.000Z",
    });
    const right = await writeReviewDecisionBundle({
      decisions: [first, second],
      outputRoot: join(directory, "right"),
      createdAt: "2026-07-15T03:00:00.000Z",
    });
    expect(left.ledger).toBe(right.ledger);
    expect(left.manifest.ledgerSha256).toBe(right.manifest.ledgerSha256);
    expect(left.manifest.createdAt).not.toBe(right.manifest.createdAt);
    expect(left.manifest).toMatchObject({ decisionCount: 2, verifyCount: 1, rejectCount: 1, sourceRecordCount: 2 });
    const parsed = await readReviewDecisionBundle(left.directory);
    expect(parsed.decisions.map(({ id }) => id)).toEqual(["evd_a", "evd_b"]);
    expect(() => validateReviewDecisionSources(parsed, parsed.decisions.map((item) => ({
      sourceId: item.sourceId,
      sourceRecordKey: item.sourceRecordKey,
      sourceRecordId: item.sourceRecordId,
      contentHash: item.sourceContentHash,
      productId: item.productId,
      productGtin: item.fieldFamily === "nutrition" ? item.payload.barcode : item.payload.candidate.barcode,
    })))).not.toThrow();
    expect(() => validateReviewDecisionSources(parsed, parsed.decisions.map((item, index) => ({
      sourceId: item.sourceId,
      sourceRecordKey: item.sourceRecordKey,
      sourceRecordId: item.sourceRecordId,
      contentHash: index === 0 ? "drifted" : item.sourceContentHash,
      productId: item.productId,
      productGtin: item.fieldFamily === "nutrition" ? item.payload.barcode : item.payload.candidate.barcode,
    })))).toThrow("source evidence has drifted");
    expect(() => validateExistingEvidenceDecisions(parsed, [{ ...first, rationale: "Conflicting edit" }]))
      .toThrow("conflicts with an existing decision id");
    expect(() => validateExistingEvidenceDecisions(parsed, [first, second])).not.toThrow();
    const sqlPath = join(directory, "review-decisions.sql");
    const plan = await emitReviewDecisionSql(parsed, sqlPath);
    const sql = await readFile(sqlPath, "utf8");
    expect(plan).toMatchObject({ decisionCount: 2, verifyCount: 1, rejectCount: 1, expectedResolvedCandidates: 2 });
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM evidence_decisions WHERE id = 'evd_a')");
    expect(sql).toContain("INSERT INTO nutrition_facts");
    expect(sql).toContain("SELECT COUNT(*) AS applied_decisions");
    expect(sql).toContain("SELECT COUNT(*) AS unresolved_candidates");
    const sourceRows = parsed.decisions.map((item) => ({
      source_id: item.sourceId,
      source_record_key: item.sourceRecordKey,
      source_record_id: item.sourceRecordId,
      content_hash: item.sourceContentHash,
      product_id: item.productId,
      product_gtin: item.fieldFamily === "nutrition" ? item.payload.barcode : item.payload.candidate.barcode,
    }));
    expect(() => validateReviewPublicationState(parsed, [
      { success: true, results: sourceRows },
      { success: true, results: [] },
      { success: true, results: [] },
    ])).not.toThrow();
    const decisionRows = parsed.decisions.map((item) => ({
      id: item.id,
      source_id: item.sourceId,
      source_record_key: item.sourceRecordKey,
      source_record_id: item.sourceRecordId,
      source_content_hash: item.sourceContentHash,
      product_id: item.productId,
      candidate_hash: item.candidateHash,
      field_family: item.fieldFamily,
      decision: item.decision,
      payload_json: canonicalJson(item.payload),
      evidence_url: item.evidenceUrl,
      rationale: item.rationale,
      decided_by: item.decidedBy,
      decided_at: item.decidedAt,
    }));
    const nutrition = nutritionCandidateValues(first.payload);
    const postconditions = [
      { success: true, results: decisionRows },
      { success: true, results: [{
        product_id: first.productId,
        source_record_id: first.sourceRecordId,
        status: "verified",
        authority: 100,
        basis: nutritionCandidateNormalizedBasis(first.payload),
        calories: nutrition.calories,
        protein_grams: nutrition.proteinGrams,
        carbohydrate_grams: nutrition.carbohydrateGrams,
        sugar_grams: nutrition.sugarGrams,
        fat_grams: nutrition.fatGrams,
        saturated_fat_grams: nutrition.saturatedFatGrams,
        fibre_grams: nutrition.fibreGrams,
        sodium_mg: nutrition.sodiumMg,
        label_verified_at: first.decidedAt,
        observed_at: first.payload.observedAt,
      }] },
      { success: true, results: [] },
      { success: true, results: [] },
      { success: true, results: [{
        product_id: first.productId,
        field_family: "nutrition",
        outcome: "verified",
        source_record_id: first.sourceRecordId,
        evidence_url: first.evidenceUrl,
        observed_at: first.payload.observedAt,
        verified_at: first.decidedAt,
        decided_by: first.decidedBy,
      }] },
      { success: true, results: [] },
      { success: true, results: [{
        redundant_facts: 0,
        redundant_outcomes: 0,
        redundant_observations: 0,
        redundant_nutrients: 0,
      }] },
    ];
    expect(validateReviewPostconditions(parsed, postconditions)).toMatchObject({
      decisions: 2,
      verifiedFacts: 1,
      verifiedOutcomes: 1,
      unresolvedCandidates: 0,
    });
    expect(() => validateReviewPostconditions(parsed, [
      postconditions[0], postconditions[1], postconditions[2], postconditions[3], postconditions[4],
      { success: true, results: [{ id: "rev_still_open" }] }, postconditions[6],
    ])).toThrow("remain unresolved");
  });

  it("emits and validates exact per-100-mL reviewed publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-review-volume-"));
    const decision = await volumeReviewDecision("evd_volume");
    const bundle = await writeReviewDecisionBundle({ decisions: [decision], outputRoot: directory });
    const parsed = await readReviewDecisionBundle(bundle.directory);
    const exact = parsed.decisions[0];
    if (!exact || exact.fieldFamily !== "nutrition") throw new Error("Expected a volume nutrition decision");
    expect(nutritionCandidateNormalizedBasis(exact.payload)).toBe("per_100ml");
    expect(nutritionCandidateValues(exact.payload)).toMatchObject({ calories: 50, proteinGrams: 10 });

    const sqlPath = join(directory, "volume-review.sql");
    await emitReviewDecisionSql(parsed, sqlPath);
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("'per_100ml', 'as_sold', 50, 10");
    expect(sql).toContain('"nutritionPer100ml"');
    expect(sql).toContain("CASE WHEN 0 THEN");

    const database = new DatabaseSync(":memory:");
    for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      database.exec(await readFile(join("migrations", migration), "utf8"));
    }
    database.exec(`
      INSERT INTO sources (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
        license_url, retention_notes, credential_requirement, created_at)
      VALUES ('open_food_facts_robotoff', 'Robotoff', 'open_data', 0, 20, 0, NULL, 'review only', NULL, '2026-07-15T00:00:00.000Z');
      INSERT INTO ingestion_runs (id, source_id, adapter_version, mode, input_identifier, records_read,
        india_records, staged_records, terminal_evidence, source_complete, market_complete, status, started_at, completed_at)
      VALUES ('run_volume', 'open_food_facts_robotoff', 'test', 'sample', 'fixture', 1, 1, 1,
        'end_of_file', 1, 0, 'completed', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
      INSERT INTO products (id, gtin, brand, brand_normalized, name, name_normalized, category,
        marketed_reasons_json, nutrition_reasons_json, classifier_version, completeness,
        completeness_missing_json, identity_authority, created_at, updated_at)
      VALUES ('prd_volume_fixture', '08900000000012', 'Test', 'test', 'Protein water', 'protein water',
        'ready_to_drink', '[]', '[]', 'protein-v1', 50, '[]', 100,
        '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
      INSERT INTO source_records (id, source_id, source_record_id, product_id, source_url, content_hash,
        observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule, identity_hash)
      VALUES ('src_evd_volume', 'open_food_facts_robotoff', '8900000000012:prediction-evd_volume',
        'prd_volume_fixture', 'https://robotoff.openfoodfacts.org/', 'source_evd_volume',
        '2026-07-15T00:00:00.000Z', 'run_volume', 'run_volume', '{}', 'exact_gtin', 'identity');
      INSERT INTO review_items (id, type, priority, status, source_record_id, product_id,
        candidate_product_ids_json, evidence_json, created_at)
      VALUES ('rev_volume', 'nutrition_validation', 50, 'open', 'src_evd_volume', 'prd_volume_fixture',
        '[]', '{"details":{"candidateHash":"${exact.candidateHash}"}}', '2026-07-15T00:00:00.000Z');
    `);
    database.exec(sql);
    database.exec(sql);
    expect(database.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions) AS decisions,
      (SELECT COUNT(*) FROM nutrient_values WHERE basis = 'per_100ml') AS nutrients,
      (SELECT COUNT(*) FROM field_observations WHERE selected = 1) AS observations,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE field_family = 'nutrition') AS outcomes,
      (SELECT status FROM review_items WHERE id = 'rev_volume') AS review_status,
      (SELECT basis FROM nutrition_facts WHERE product_id = 'prd_volume_fixture') AS basis
    `).get()).toEqual({ decisions: 1, nutrients: 8, observations: 8, outcomes: 1, review_status: "resolved", basis: "per_100ml" });

    const nutrition = nutritionCandidateValues(exact.payload);
    const decisionRow = {
      id: exact.id,
      source_id: exact.sourceId,
      source_record_key: exact.sourceRecordKey,
      source_record_id: exact.sourceRecordId,
      source_content_hash: exact.sourceContentHash,
      product_id: exact.productId,
      candidate_hash: exact.candidateHash,
      field_family: exact.fieldFamily,
      decision: exact.decision,
      payload_json: canonicalJson(exact.payload),
      evidence_url: exact.evidenceUrl,
      rationale: exact.rationale,
      decided_by: exact.decidedBy,
      decided_at: exact.decidedAt,
    };
    const postconditions = [
      { success: true, results: [decisionRow] },
      { success: true, results: [{
        product_id: exact.productId,
        source_record_id: exact.sourceRecordId,
        status: "verified",
        authority: 100,
        basis: "per_100ml",
        calories: nutrition.calories,
        protein_grams: nutrition.proteinGrams,
        carbohydrate_grams: nutrition.carbohydrateGrams,
        sugar_grams: nutrition.sugarGrams,
        fat_grams: nutrition.fatGrams,
        saturated_fat_grams: nutrition.saturatedFatGrams,
        fibre_grams: nutrition.fibreGrams,
        sodium_mg: nutrition.sodiumMg,
        label_verified_at: exact.decidedAt,
        observed_at: exact.payload.observedAt,
      }] },
      { success: true, results: [] },
      { success: true, results: [] },
      { success: true, results: [{
        product_id: exact.productId,
        field_family: "nutrition",
        outcome: "verified",
        source_record_id: exact.sourceRecordId,
        evidence_url: exact.evidenceUrl,
        observed_at: exact.payload.observedAt,
        verified_at: exact.decidedAt,
        decided_by: exact.decidedBy,
      }] },
      { success: true, results: [] },
      { success: true, results: [{
        redundant_facts: 0,
        redundant_outcomes: 0,
        redundant_observations: 0,
        redundant_nutrients: 0,
      }] },
    ];
    expect(validateReviewPostconditions(parsed, postconditions)).toMatchObject({
      decisions: 1,
      verifiedFacts: 1,
      verifiedOutcomes: 1,
      unresolvedCandidates: 0,
    });
    expect(() => validateReviewPostconditions(parsed, [
      postconditions[0],
      { success: true, results: [{ ...postconditions[1]!.results[0], basis: "per_100g" }] },
      ...postconditions.slice(2),
    ])).toThrow("Verified nutrition postcondition failed");
  });

  it("publishes exact redundant nutrition as a terminal fact no-op and fails closed on projection drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-review-redundant-"));
    const decision: EvidenceDecisionInput = {
      ...(await reviewDecision("evd_redundant")),
      decision: "redundant",
      rationale: "Additional label image exactly matches the selected verified projection",
    };
    const written = await writeReviewDecisionBundle({
      decisions: [decision],
      outputRoot: directory,
      createdAt: "2026-07-15T02:00:00.000Z",
    });
    expect(written.manifest).toMatchObject({
      decisionCount: 1,
      verifyCount: 0,
      rejectCount: 0,
      redundantCount: 1,
    });
    const parsed = await readReviewDecisionBundle(written.directory);
    expect(parsed.decisions[0]).toMatchObject({ decision: "redundant", fieldFamily: "nutrition" });

    const selected = nutritionCandidateValues(decision.payload);
    const selectedRow = {
      product_id: decision.productId,
      source_record_id: "src_selected_redundant",
      status: "verified",
      authority: 100,
      basis: nutritionCandidateNormalizedBasis(decision.payload),
      calories: selected.calories,
      protein_grams: selected.proteinGrams,
      carbohydrate_grams: selected.carbohydrateGrams,
      sugar_grams: selected.sugarGrams,
      fat_grams: selected.fatGrams,
      saturated_fat_grams: selected.saturatedFatGrams,
      fibre_grams: selected.fibreGrams,
      sodium_mg: selected.sodiumMg,
      label_verified_at: "2026-07-14T01:00:00.000Z",
      observed_at: "2026-07-14T00:00:00.000Z",
    };
    const sourceRow = {
      source_id: decision.sourceId,
      source_record_key: decision.sourceRecordKey,
      source_record_id: decision.sourceRecordId,
      content_hash: decision.sourceContentHash,
      product_id: decision.productId,
      product_gtin: decision.payload.barcode,
    };
    expect(() => validateReviewPublicationState(parsed, [
      { success: true, results: [sourceRow] },
      { success: true, results: [] },
      { success: true, results: [selectedRow] },
    ])).not.toThrow();
    expect(() => validateReviewPublicationState(parsed, [
      { success: true, results: [sourceRow] },
      { success: true, results: [] },
      { success: true, results: [{ ...selectedRow, protein_grams: 24 }] },
    ])).toThrow("projection has drifted");

    const sourceQueryPath = join(directory, "redundant-source-state.sql");
    await emitReviewSourceStateQuery(parsed, sourceQueryPath);
    const sourceQuery = await readFile(sourceQueryPath, "utf8");
    expect(sourceQuery).toContain("FROM source_records");
    expect(sourceQuery).toContain("FROM nutrition_facts");
    expect(sourceQuery).toContain(`'${decision.productId}'`);

    const sqlPath = join(directory, "redundant-review.sql");
    const plan = await emitReviewDecisionSql(parsed, sqlPath);
    const sql = await readFile(sqlPath, "utf8");
    expect(plan).toMatchObject({
      decisionCount: 1,
      verifyCount: 0,
      rejectCount: 0,
      redundantCount: 1,
      expectedResolvedCandidates: 1,
    });
    expect(sql).toContain("'redundant_nutrition'");
    expect(sql).toContain("nf.status = 'verified'");
    expect(sql).toContain("nf.authority = 100");
    expect(sql).not.toMatch(/INSERT INTO nutrition_facts|INSERT INTO field_observations|INSERT INTO nutrient_values|INSERT INTO evidence_outcomes|UPDATE products/);

    const database = new DatabaseSync(":memory:");
    for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      database.exec(await readFile(join("migrations", migration), "utf8"));
    }
    database.exec(`
      INSERT INTO sources (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
        license_url, retention_notes, credential_requirement, created_at)
      VALUES ('open_food_facts_robotoff', 'Robotoff', 'open_data', 0, 20, 0, NULL, 'review only', NULL, '2026-07-15T00:00:00.000Z');
      INSERT INTO ingestion_runs (id, source_id, adapter_version, mode, input_identifier, records_read,
        india_records, staged_records, terminal_evidence, source_complete, market_complete, status, started_at, completed_at)
      VALUES ('run_redundant', 'open_food_facts_robotoff', 'test', 'sample', 'fixture', 2, 2, 2,
        'end_of_file', 1, 0, 'completed', '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
      INSERT INTO products (id, gtin, brand, brand_normalized, name, name_normalized, category,
        marketed_reasons_json, nutrition_reasons_json, classifier_version, completeness,
        completeness_missing_json, identity_authority, created_at, updated_at)
      VALUES ('prd_fixture', '08900000000012', 'Test', 'test', 'Protein bar', 'protein bar',
        'protein_bar', '[]', '[]', 'protein-v1', 50, '[]', 100,
        '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:00.000Z');
      INSERT INTO source_records (id, source_id, source_record_id, product_id, source_url, content_hash,
        observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule, identity_hash)
      VALUES ('src_selected_redundant', 'open_food_facts_robotoff', 'selected-label', 'prd_fixture',
        'https://robotoff.openfoodfacts.org/', 'selected-content', '2026-07-14T00:00:00.000Z',
        'run_redundant', 'run_redundant', '{}', 'exact_gtin', 'selected-identity'),
        ('src_evd_redundant', 'open_food_facts_robotoff', '8900000000012:prediction-evd_redundant',
        'prd_fixture', 'https://robotoff.openfoodfacts.org/', 'source_evd_redundant',
        '2026-07-15T00:00:00.000Z', 'run_redundant', 'run_redundant', '{}', 'exact_gtin', 'candidate-identity');
      INSERT INTO nutrition_facts (product_id, source_record_id, status, confidence, authority, basis,
        preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams,
        saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
      VALUES ('prd_fixture', 'src_selected_redundant', 'verified', 'high', 100, 'per_100g', 'as_sold',
        365, 24, 46.5, 4, 8.9, 2, 5, 250, '2026-07-14T01:00:00.000Z',
        '2026-07-14T00:00:00.000Z', '2026-07-14T01:00:00.000Z');
      INSERT INTO evidence_outcomes (product_id, field_family, outcome, source_record_id, evidence_url,
        observed_at, verified_at, decided_by, notes)
      VALUES ('prd_fixture', 'nutrition', 'verified', 'src_selected_redundant',
        'https://images.openfoodfacts.org/selected.jpg', '2026-07-14T00:00:00.000Z',
        '2026-07-14T01:00:00.000Z', 'local_operator', 'Selected verified label');
      INSERT INTO review_items (id, type, priority, status, source_record_id, product_id,
        candidate_product_ids_json, evidence_json, created_at)
      VALUES ('rev_redundant', 'nutrition_validation', 50, 'open', 'src_evd_redundant', 'prd_fixture',
        '[]', '{"details":{"candidateHash":"${decision.candidateHash}"}}', '2026-07-15T00:00:00.000Z');
    `);
    database.exec(sql);
    expect(database.prepare("SELECT COUNT(*) AS decisions FROM evidence_decisions").get()).toEqual({ decisions: 0 });
    expect(database.prepare("SELECT status FROM review_items WHERE id = 'rev_redundant'").get()).toEqual({ status: "open" });

    database.exec("UPDATE nutrition_facts SET protein_grams = 25 WHERE product_id = 'prd_fixture'");
    database.exec(sql);
    database.exec(sql);
    expect(database.prepare(`SELECT
      (SELECT COUNT(*) FROM evidence_decisions WHERE decision = 'redundant') AS decisions,
      (SELECT status FROM review_items WHERE id = 'rev_redundant') AS review_status,
      (SELECT decision FROM review_items WHERE id = 'rev_redundant') AS review_decision,
      (SELECT COUNT(*) FROM nutrition_facts) AS facts,
      (SELECT source_record_id FROM nutrition_facts WHERE product_id = 'prd_fixture') AS fact_source,
      (SELECT COUNT(*) FROM field_observations WHERE source_record_id = 'src_evd_redundant') AS observations,
      (SELECT COUNT(*) FROM nutrient_values WHERE source_record_id = 'src_evd_redundant') AS nutrients,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE source_record_id = 'src_evd_redundant') AS outcomes
    `).get()).toEqual({
      decisions: 1,
      review_status: "resolved",
      review_decision: "redundant_nutrition",
      facts: 1,
      fact_source: "src_selected_redundant",
      observations: 0,
      nutrients: 0,
      outcomes: 0,
    });

    const decisionRow = {
      id: decision.id,
      source_id: decision.sourceId,
      source_record_key: decision.sourceRecordKey,
      source_record_id: decision.sourceRecordId,
      source_content_hash: decision.sourceContentHash,
      product_id: decision.productId,
      candidate_hash: decision.candidateHash,
      field_family: decision.fieldFamily,
      decision: decision.decision,
      payload_json: canonicalJson(decision.payload),
      evidence_url: decision.evidenceUrl,
      rationale: decision.rationale,
      decided_by: decision.decidedBy,
      decided_at: decision.decidedAt,
    };
    const existingOutcome = {
      product_id: decision.productId,
      field_family: "nutrition",
      outcome: "verified",
      source_record_id: "src_selected_redundant",
      evidence_url: "https://images.openfoodfacts.org/selected.jpg",
      observed_at: "2026-07-14T00:00:00.000Z",
      verified_at: "2026-07-14T01:00:00.000Z",
      decided_by: "local_operator",
    };
    const postconditions = [
      { success: true, results: [decisionRow] },
      { success: true, results: [selectedRow] },
      { success: true, results: [] },
      { success: true, results: [] },
      { success: true, results: [existingOutcome] },
      { success: true, results: [] },
      { success: true, results: [{
        redundant_facts: 0,
        redundant_outcomes: 0,
        redundant_observations: 0,
        redundant_nutrients: 0,
      }] },
    ];
    expect(validateReviewPostconditions(parsed, postconditions)).toMatchObject({
      decisions: 1,
      verifiedFacts: 0,
      verifiedOutcomes: 0,
      redundantFacts: 0,
      redundantOutcomes: 0,
      unresolvedCandidates: 0,
    });
    expect(() => validateReviewPostconditions(parsed, [
      ...postconditions.slice(0, 6),
      { success: true, results: [{
        redundant_facts: 0,
        redundant_outcomes: 0,
        redundant_observations: 1,
        redundant_nutrients: 0,
      }] },
    ])).toThrow("wrote unexpected verified state");
  });

  it("rejects order-dependent verify and redundant decisions for the same nutrition product", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-review-mixed-modes-"));
    const verify = await reviewDecision("evd_mixed_verify");
    const redundant: EvidenceDecisionInput = {
      ...(await reviewDecision("evd_mixed_redundant")),
      decision: "redundant",
    };
    await expect(writeReviewDecisionBundle({
      decisions: [verify, redundant],
      outputRoot: join(directory, "verify-first"),
    })).rejects.toThrow("Cannot mix nutrition verify and redundant decisions");
    await expect(writeReviewDecisionBundle({
      decisions: [redundant, verify],
      outputRoot: join(directory, "redundant-first"),
    })).rejects.toThrow("Cannot mix nutrition verify and redundant decisions");
  });

  it("keeps every checked-in legacy review bundle checksum-compatible and omits new manifest bytes", async () => {
    const candidateDirectories = (await readdir("review-decisions", { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => join("review-decisions", name))
      .sort();
    const directories = (await Promise.all(candidateDirectories.map(async (directory) => {
      const files = new Set(await readdir(directory));
      return ["manifest.json", "decisions.jsonl", "checksums.sha256"].every((file) => files.has(file))
        ? directory
        : null;
    }))).filter((directory): directory is string => directory !== null);
    expect(directories.length).toBeGreaterThan(0);
    let legacyCount = 0;
    for (const directory of directories) {
      const manifestBytes = await readFile(join(directory, "manifest.json"), "utf8");
      const manifest = JSON.parse(manifestBytes) as { redundantCount?: number };
      if (manifest.redundantCount !== undefined) continue;
      legacyCount += 1;
      const ledgerBytes = await readFile(join(directory, "decisions.jsonl"), "utf8");
      const bundle = await readReviewDecisionBundle(directory);
      expect(bundle.ledger).toBe(ledgerBytes);
      expect(bundle.manifest).not.toHaveProperty("redundantCount");
      expect(await readFile(join(directory, "manifest.json"), "utf8")).toBe(manifestBytes);
      expect(await readFile(join(directory, "decisions.jsonl"), "utf8")).toBe(ledgerBytes);
    }
    expect(legacyCount).toBeGreaterThan(0);

    const verifyReject = await writeReviewDecisionBundle({
      decisions: [await reviewDecision("evd_legacy_verify"), await reviewDecision("evd_legacy_reject", "reject")],
      outputRoot: await mkdtemp(join(tmpdir(), "protein-index-review-legacy-shape-")),
      createdAt: "2026-07-15T02:00:00.000Z",
    });
    expect(JSON.parse(await readFile(join(verifyReject.directory, "manifest.json"), "utf8"))).not.toHaveProperty("redundantCount");
  });

  it("refuses empty, invalid, tampered, and unsafe review bundles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-review-invalid-"));
    await expect(writeReviewDecisionBundle({ decisions: [], outputRoot: directory })).rejects.toThrow("empty");
    const decision = await reviewDecision("evd_valid");
    await expect(writeReviewDecisionBundle({
      decisions: [{ ...decision, candidateHash: "0".repeat(64) }],
      outputRoot: directory,
    })).rejects.toThrow("candidateHash does not match payload");
    const bundle = await writeReviewDecisionBundle({ decisions: [decision], outputRoot: directory });
    await writeFile(join(bundle.directory, "decisions.jsonl"), `${bundle.ledger} `, "utf8");
    await expect(readReviewDecisionBundle(bundle.directory)).rejects.toThrow("checksum mismatch");
    await writeFile(join(bundle.directory, "checksums.sha256"), `${"0".repeat(64)}  ../decisions.jsonl\n`, "utf8");
    await expect(readReviewDecisionBundle(bundle.directory)).rejects.toThrow("safe portable relative path");
  });
});

describe("Open Food Facts bulk staging", () => {
  it("pins automatic publication to the exact workflow, artifact, branch, run, and head SHA", () => {
    expect(automaticPublicationContract(automaticInput())).toMatchObject({
      workflowName: "Source sync",
      expectedSource: "open_food_facts",
      discoveryDropCeiling: 0.2,
    });
    expect(() => automaticPublicationContract(automaticInput({ workflowName: "Unknown workflow" }))).toThrow("unsupported workflow");
    expect(() => automaticPublicationContract(automaticInput({ artifactName: "open-food-facts-snapshot-999" }))).toThrow("expected artifact");
    expect(() => automaticPublicationContract(automaticInput({ headBranch: "feature" }))).toThrow("default-branch");
    expect(() => automaticPublicationContract(automaticInput({ headSha: "abc" }))).toThrow("head SHA");
    expect(() => automaticPublicationContract(automaticInput({ runId: 0 }))).toThrow("run ID");
    expect(() => automaticPublicationContract(automaticInput({ repository: "fork/protein-index" }))).toThrow("Significant-Hobbies/protein-index");
    expect(() => automaticPublicationContract(automaticInput({ artifactDigest: "abc" }))).toThrow("artifact digest");
    expect(() => automaticPublicationContract(automaticInput({ artifactBytes: 0 }))).toThrow("artifact size");
    expect(() => automaticPublicationContract(automaticInput({
      workflowName: "Extract label evidence with Robotoff",
      runId: 29551181430,
      artifactName: "robotoff-label-candidates-29551181430",
    }))).toThrow("superseded extraction run");
  });

  it("accepts checksummed community evidence and rejects legacy review-only artifacts without label-byte proofs", async () => {
    const communityDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-community-"));
    await writeAutomaticArtifact({ directory: communityDirectory });
    await expect(validateAutomaticPublicationSnapshot(communityDirectory, automaticInput())).resolves.toMatchObject({
      validatedStagedRecords: 1,
      contract: { expectedSource: "open_food_facts", evidenceKind: "community" },
    });

    const normalized = normalizeOpenFoodFactsRecord(indiaProduct).staged;
    if (!normalized) throw new Error("Expected the Open Food Facts fixture to normalize");
    const reviewProduct: Record<string, unknown> = {
      ...structuredClone(normalized),
      source: "open_food_facts_robotoff",
      sourceAuthority: { identity: 0, nutrition: 20, ingredients: 0 },
      nutrients: [],
      nutrition: {
        ...normalized.nutrition,
        per100g: {
          calories: null,
          proteinGrams: null,
          carbohydrateGrams: null,
          sugarGrams: null,
          fatGrams: null,
          saturatedFatGrams: null,
          fibreGrams: null,
          sodiumMg: null,
        },
        status: "missing",
        confidence: "low",
        source: "open_food_facts_robotoff",
        labelVerifiedAt: null,
      },
      ingredients: {
        ...normalized.ingredients,
        raw: null,
        normalized: [],
        allergens: [],
        additives: [],
        status: "missing",
        confidence: "low",
        source: "open_food_facts_robotoff",
      },
      validationIssues: [{ code: "robotoff_nutrition_candidate", severity: "warning", field: "nutrition" }],
      rawEvidence: { candidate: { calories: 345, proteinGrams: 52 } },
    };
    const reviewDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-review-"));
    await writeAutomaticArtifact({ directory: reviewDirectory, source: "open_food_facts_robotoff", product: reviewProduct });
    await expect(validateAutomaticPublicationSnapshot(reviewDirectory, automaticInput({
      workflowName: "Extract label evidence with Robotoff",
      artifactName: "robotoff-label-candidates-123",
    }))).rejects.toThrow("label-assets.jsonl is required");
  });

  it("rejects verified facts, decision payloads, source drift, excessive discovery drops, and checksum drift", async () => {
    const verifiedDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-verified-"));
    const verified = normalizeOpenFoodFactsRecord(indiaProduct).staged;
    if (!verified) throw new Error("Expected the Open Food Facts fixture to normalize");
    verified.nutrition.status = "verified";
    verified.nutrition.labelVerifiedAt = "2026-07-16T10:00:00.000Z";
    await writeAutomaticArtifact({ directory: verifiedDirectory, product: { ...verified } });
    await expect(validateAutomaticPublicationSnapshot(verifiedDirectory, automaticInput())).rejects.toThrow("verified nutrition");

    const decisionDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-decision-"));
    const decisionProduct = normalizeOpenFoodFactsRecord(indiaProduct).staged;
    if (!decisionProduct) throw new Error("Expected the Open Food Facts fixture to normalize");
    await writeAutomaticArtifact({ directory: decisionDirectory, product: { ...decisionProduct, verificationDecision: { decision: "verify" } } });
    await expect(validateAutomaticPublicationSnapshot(decisionDirectory, automaticInput())).rejects.toThrow("decision payloads");

    const sourceDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-source-"));
    await writeAutomaticArtifact({ directory: sourceDirectory, source: "open_food_facts_api" });
    await expect(validateAutomaticPublicationSnapshot(sourceDirectory, automaticInput())).rejects.toThrow("does not match");

    const dropDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-drop-"));
    await writeAutomaticArtifact({
      directory: dropDirectory,
      report: {
        sourceComplete: true,
        marketComplete: false,
        continuity: { currentStagedRecords: 1, previousStagedRecords: 10, missingSinceRecords: 3, maximumDropRatio: 0.5 },
        exclusions: { records: 0, reconcilesIndiaSlice: true },
      },
    });
    await expect(validateAutomaticPublicationSnapshot(dropDirectory, automaticInput())).rejects.toThrow("20 percent");

    const checksumDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-checksum-"));
    await writeAutomaticArtifact({ directory: checksumDirectory });
    await writeFile(join(checksumDirectory, "staged-products.jsonl"), "{}\n", "utf8");
    await expect(validateAutomaticPublicationSnapshot(checksumDirectory, automaticInput())).rejects.toThrow("checksum mismatch");
  });

  it("retains richer equal-authority nutrition while preserving source records and replay idempotence", async () => {
    const database = new DatabaseSync(":memory:");
    for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      database.exec(await readFile(join("migrations", migration), "utf8"));
    }
    const normalized = normalizeOpenFoodFactsRecord(indiaProduct).staged;
    if (!normalized) throw new Error("Expected the Open Food Facts fixture to normalize");
    const writeImport = async (source: string, product: typeof normalized, timestamp: string, suffix: string, automatic = false): Promise<string> => {
      const directory = await mkdtemp(join(tmpdir(), `protein-index-monotonic-${suffix}-`));
      const staged = structuredClone(product);
      staged.source = source;
      staged.sourceAuthority.nutrition = 40;
      staged.observedAt = timestamp;
      staged.nutrition.observedAt = timestamp;
      staged.contentHash = createHash("sha256").update(`${source}:${timestamp}:${JSON.stringify(staged.nutrition.per100g)}`).digest("hex");
      await writeAutomaticArtifact({ directory, source, product: { ...staged } });
      const manifestPath = join(directory, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SourceManifest;
      manifest.startedAt = timestamp;
      manifest.completedAt = timestamp;
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      const outputPath = join(directory, "import.sql");
      await emitImportSql({ stagedPath: join(directory, "staged-products.jsonl"), manifestPath, outputPath, applyEvidenceDecisions: !automatic });
      return readFile(outputPath, "utf8");
    };

    const rich = structuredClone(normalized);
    const richSql = await writeImport("open_food_facts_api", rich, "2026-07-16T10:00:00.000Z", "rich");
    const sparse = structuredClone(normalized);
    sparse.nutrition.per100g = {
      calories: 350,
      proteinGrams: 50,
      carbohydrateGrams: null,
      sugarGrams: null,
      fatGrams: null,
      saturatedFatGrams: null,
      fibreGrams: null,
      sodiumMg: null,
    };
    const sparseSql = await writeImport("open_food_facts", sparse, "2026-07-16T11:00:00.000Z", "sparse");
    database.exec(richSql);
    database.exec(sparseSql);
    expect(database.prepare("SELECT source_id, calories, protein_grams, sugar_grams FROM nutrition_facts JOIN source_records ON source_records.id = nutrition_facts.source_record_id").get()).toMatchObject({
      source_id: "open_food_facts_api",
      calories: 345,
      protein_grams: 52,
      sugar_grams: 7,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM source_records").get()).toMatchObject({ count: 2 });

    const equallyRich = structuredClone(normalized);
    equallyRich.nutrition.per100g.calories = 360;
    const equallyRichSql = await writeImport("open_food_facts", equallyRich, "2026-07-16T12:00:00.000Z", "equal");
    database.exec(equallyRichSql);
    expect(database.prepare("SELECT source_id, calories FROM nutrition_facts JOIN source_records ON source_records.id = nutrition_facts.source_record_id").get()).toMatchObject({
      source_id: "open_food_facts",
      calories: 360,
    });
    const beforeReplay = database.prepare("SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM source_records) AS source_records, (SELECT COUNT(*) FROM review_items) AS reviews, (SELECT COUNT(*) FROM evidence_decisions) AS decisions").get();
    database.exec(equallyRichSql);
    expect(database.prepare("SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM source_records) AS source_records, (SELECT COUNT(*) FROM review_items) AS reviews, (SELECT COUNT(*) FROM evidence_decisions) AS decisions").get()).toEqual(beforeReplay);

    database.exec("UPDATE nutrition_facts SET status = 'verified', authority = 100, calories = 999, label_verified_at = '2026-07-16T12:30:00.000Z'");
    database.exec(`UPDATE products SET nutritionally_protein_dense = 1,
      nutrition_reasons_json = '["protein_at_least_20_percent_calories"]'`);
    const newerCommunity = structuredClone(normalized);
    newerCommunity.nutrition.per100g.calories = 370;
    const automaticSql = await writeImport("open_food_facts", newerCommunity, "2026-07-16T13:00:00.000Z", "automatic", true);
    database.exec(automaticSql);
    expect(database.prepare("SELECT status, authority, calories FROM nutrition_facts").get()).toMatchObject({
      status: "verified",
      authority: 100,
      calories: 999,
    });
    expect(database.prepare("SELECT nutritionally_protein_dense, nutrition_reasons_json FROM products").get()).toMatchObject({
      nutritionally_protein_dense: 1,
      nutrition_reasons_json: '["protein_at_least_20_percent_calories"]',
    });
    database.close();
  });

  it("fails closed on pending migrations and validates exact automatic publication postconditions", async () => {
    expect(() => assertNoPendingD1Migrations("No migrations to apply!\n")).not.toThrow();
    expect(() => assertNoPendingD1Migrations("Migrations to be applied:\n0008_new.sql\n")).toThrow("no pending migrations");
    expect(() => assertNoPendingD1Migrations("")).toThrow("no pending migrations");

    const directory = await mkdtemp(join(tmpdir(), "protein-index-auto-state-"));
    await writeAutomaticArtifact({ directory });
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as SourceManifest;
    const query = publicationStateQuery(manifest);
    expect(query).toContain(manifest.inputHash);
    expect(query).toContain("exact_run_status");
    const runId = /run_[a-f0-9]{24}/.exec(query)?.[0];
    expect(runId).toBeTruthy();
    const before: PublicationState = {
      products: 10,
      sourceRecords: 20,
      openReviews: 2,
      decisions: 3,
      verifiedNutrition: 4,
      verifiedIngredients: 5,
      extractionRuns: 0,
      labelAssets: 0,
      extractionAttempts: 0,
      currentExtractionAttempts: 0,
      extractionAttemptLabels: 0,
      exactRunId: null,
      exactRunStatus: null,
      exactRunInputHash: null,
      exactRunSourceComplete: null,
      exactRunStagedRecords: null,
      exactExtractionRunId: null,
      exactExtractionRunStatus: null,
      exactExtractionArtifactDigest: null,
      exactExtractionAttempts: 0,
      exactExtractionAttemptLabels: 0,
    };
    const after: PublicationState = {
      ...before,
      products: 11,
      sourceRecords: 21,
      openReviews: 3,
      exactRunId: runId ?? null,
      exactRunStatus: "completed",
      exactRunInputHash: manifest.inputHash,
      exactRunSourceComplete: 1,
      exactRunStagedRecords: manifest.stagedRecords,
    };
    const parsed = parsePublicationState([{ success: true, results: [{
      products: after.products,
      source_records: after.sourceRecords,
      open_reviews: after.openReviews,
      decisions: after.decisions,
      verified_nutrition: after.verifiedNutrition,
      verified_ingredients: after.verifiedIngredients,
      extraction_runs: after.extractionRuns,
      label_assets: after.labelAssets,
      extraction_attempts: after.extractionAttempts,
      current_extraction_attempts: after.currentExtractionAttempts,
      extraction_attempt_labels: after.extractionAttemptLabels,
      exact_run_id: after.exactRunId,
      exact_run_status: after.exactRunStatus,
      exact_run_input_hash: after.exactRunInputHash,
      exact_run_source_complete: after.exactRunSourceComplete,
      exact_run_staged_records: after.exactRunStagedRecords,
      exact_extraction_run_id: after.exactExtractionRunId,
      exact_extraction_run_status: after.exactExtractionRunStatus,
      exact_extraction_artifact_digest: after.exactExtractionArtifactDigest,
      exact_extraction_attempts: after.exactExtractionAttempts,
      exact_extraction_attempt_labels: after.exactExtractionAttemptLabels,
    }] }]);
    expect(parsed).toEqual(after);
    expect(assertAutomaticPublicationPostconditions(before, after, manifest)).toMatchObject({
      productDelta: 1,
      sourceRecordDelta: 1,
      openReviewDelta: 1,
      verifiedNutritionDelta: 0,
      verifiedIngredientDelta: 0,
    });
    expect(() => assertAutomaticPublicationPostconditions(before, { ...after, verifiedNutrition: 5 }, manifest)).toThrow("increased verified nutrition");
    expect(() => assertAutomaticPublicationPostconditions(before, { ...after, exactRunInputHash: "wrong" }, manifest)).toThrow("input hash");
    const exactExtraction: ExactExtractionSnapshot = {
      fieldFamily: "nutrition",
      extractionRunId: `xrun_${"c".repeat(24)}`,
      parentSourceRunId: `run_${"d".repeat(24)}`,
      parentSourceInputHash: "e".repeat(64),
      requestSchemaHash: "f".repeat(64),
      modelName: "nutrition_extractor",
      modelVersion: '{"nutrition_extractor-2.0":1}',
      labelAssetsPath: "/tmp/label-assets.jsonl",
      extractionAttemptsPath: "/tmp/extraction-attempts.jsonl",
      extractionAttemptLabelsPath: "/tmp/extraction-attempt-labels.jsonl",
      labelAssets: 2,
      extractionAttempts: 1,
      extractionAttemptLabels: 2,
    };
    const extractionContract = automaticPublicationContract(automaticInput({
      workflowName: "Extract label evidence with Robotoff",
      artifactName: "robotoff-label-candidates-123",
    }));
    const afterExtraction: PublicationState = {
      ...after,
      extractionRuns: 1,
      labelAssets: 2,
      extractionAttempts: 1,
      currentExtractionAttempts: 1,
      extractionAttemptLabels: 2,
      exactExtractionRunId: exactExtraction.extractionRunId,
      exactExtractionRunStatus: "accepted",
      exactExtractionArtifactDigest: "b".repeat(64),
      exactExtractionAttempts: 1,
      exactExtractionAttemptLabels: 2,
    };
    expect(() => assertAutomaticPublicationPostconditions(
      before,
      afterExtraction,
      manifest,
      exactExtraction,
      extractionContract,
    )).not.toThrow();
    expect(() => assertAutomaticPublicationPostconditions(
      before,
      { ...afterExtraction, exactExtractionArtifactDigest: "0".repeat(64) },
      manifest,
      exactExtraction,
      extractionContract,
    )).toThrow("artifact digest");
    expect(() => assertIdempotentPublicationReplay(after, { ...after })).not.toThrow();
    expect(() => assertIdempotentPublicationReplay(after, { ...after, sourceRecords: 22 })).toThrow("sourceRecords");
  });

  it("keeps the automatic workflow router pinned, serialized, migration-free, and auditable", async () => {
    const workflow = await readFile(".github/workflows/publish-automatic-evidence.yml", "utf8");
    for (const [name, family] of Object.entries(AUTOMATIC_PUBLICATION_FAMILIES)) {
      expect(workflow).toContain(`- ${name}`);
      expect(workflow).toContain(`'${name}': Object.freeze({ source: '${family.source}', artifactPrefix: '${family.artifactPrefix}' })`);
    }
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("github.event.workflow_run.head_branch == github.event.repository.default_branch");
    expect(workflow).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(workflow).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("Require automatic-publication contract at upstream commit");
    expect(workflow).toContain("test -f migrations/0009_extraction_outcome_ledger.sql");
    expect(workflow).toContain("validateAutomaticPublicationSnapshot");
    expect(workflow).toContain("applyEvidenceDecisions: !automatic");
    expect(workflow).toContain("Require protected publication credentials");
    expect(workflow).toContain("-z \"$CLOUDFLARE_API_TOKEN\"");
    expect(workflow).toContain("-z \"$CLOUDFLARE_ACCOUNT_ID\"");
    expect(workflow).toContain("artifact.digest");
    expect(workflow).toContain("artifact.size_in_bytes");
    expect(workflow).toContain("Initialize durable publication evidence");
    expect(workflow).toContain('evidence_dir="$RUNNER_TEMP/protein-index-publication-evidence"');
    expect(workflow).toContain('echo "PUBLICATION_EVIDENCE_DIR=$evidence_dir" >> "$GITHUB_ENV"');
    expect(workflow).not.toContain("PUBLICATION_EVIDENCE_DIR: ${{ runner.temp }}");
    expect(workflow).toContain("path: ${{ env.PUBLICATION_EVIDENCE_DIR }}/");
    expect(workflow).not.toContain("path: .data/publication-evidence/");
    expect(workflow).toContain("group: protein-index-production-publication");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("--automatic");
    expect(workflow).toContain("--skip-migrations");
    expect(workflow).toContain("--upstream-repository");
    expect(workflow).toContain("--artifact-digest");
    expect(workflow).toContain("--artifact-bytes");
    expect(workflow).not.toContain("migrations apply");
    expect(workflow).not.toContain("wrangler deploy");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("/api/health");
    expect(workflow).toContain("/api/products?scope=all");

    const reviewed = await readFile(".github/workflows/publish-robotoff-candidates.yml", "utf8");
    expect(reviewed).toContain("expected_head_sha:");
    expect(reviewed).toContain("expected_artifact_digest:");
    expect(reviewed).toContain("getWorkflowRun");
    expect(reviewed).toContain("new Set([29551181430, 29552807113])");
    expect(reviewed).toContain("new Set([8395774354, 8396363821]).has(artifact.id)");
    expect(workflow).toContain("new Set([29551181430, 29552807113]).has(run.id)");
    expect(workflow).toContain("new Set([8395774354, 8396363821]).has(artifact.id)");
    expect(reviewed).toContain("robotoff-api-v8");
    expect(reviewed).toContain("robotoff-ingredients-api-v3");
    expect(reviewed).toContain("--automatic");
    expect(reviewed).toContain("--skip-migrations");

    const restore = await readFile(".github/actions/restore-exact-responses/action.yml", "utf8");
    expect(restore).toContain("expected-adapter-version:");
    expect(restore).toContain("restore-label-proofs:");
    expect(restore).toContain("prior-label-assets.jsonl");
    for (const sourceConsumerWorkflow of [
      ".github/workflows/enrich-open-food-facts.yml",
      ".github/workflows/extract-robotoff.yml",
      ".github/workflows/extract-robotoff-ingredients.yml",
    ]) {
      const consumer = await readFile(sourceConsumerWorkflow, "utf8");
      expect(consumer).toContain("getWorkflowRun");
      expect(consumer).toContain("run.name !== 'Source sync' || run.conclusion !== 'success'");
      expect(consumer).toContain("run.head_branch !== context.payload.repository.default_branch");
      expect(consumer).toContain("run.head_repository?.full_name !== `${context.repo.owner}/${context.repo.repo}`");
      expect(consumer).toContain("matches.length !== 1");
      expect(consumer).toContain("artifact.digest");
      expect(consumer).toContain("artifact.size_in_bytes <= 0");
    }
    for (const extractionWorkflow of [
      ".github/workflows/extract-robotoff.yml",
      ".github/workflows/extract-robotoff-ingredients.yml",
    ]) {
      const extraction = await readFile(extractionWorkflow, "utf8");
      expect(extraction).toContain("label-assets.jsonl");
      expect(extraction).toContain("extraction-attempts.jsonl");
      expect(extraction).toContain("extraction-attempt-labels.jsonl");
      expect(extraction).toContain('restore-label-proofs: "true"');
      expect(extraction).toContain("pnpm data:audit-decisions --");
      expect(extraction).toContain("--fail-on candidate_key_active_state_ambiguous");
      expect(extraction).toContain("decision-drift audit");
      expect(extraction).toContain("if: always()");
    }
  });

  it("accepts only source-complete, reconciled production snapshots for publication", () => {
    const manifest = {
      mode: "production",
      sourceComplete: true,
      marketComplete: false,
      terminalEvidence: "end_of_file",
      stagedRecords: 17,
      indiaRecords: 20,
    } as SourceManifest;
    const report = {
      sourceComplete: true,
      marketComplete: false,
      exclusions: { records: 3, reconcilesIndiaSlice: true },
      continuity: { currentStagedRecords: 17, previousStagedRecords: 17, missingSinceRecords: 0, maximumDropRatio: 0.2 },
    };
    expect(() => assertPublicationEvidence(manifest, report)).not.toThrow();
    expect(() => assertPublicationEvidence(manifest, { ...report, exclusions: { records: 2, reconcilesIndiaSlice: true } })).toThrow(
      "staged plus excluded records",
    );
    expect(() => assertPublicationEvidence({ ...manifest, sourceComplete: false }, report)).toThrow("manifest is not source complete");
  });

  it("requires exact terminal accounting for API enrichment publication", () => {
    const manifest = {
      source: "open_food_facts_api",
      mode: "production",
      sourceComplete: true,
      terminalEvidence: "end_of_file",
      stagedRecords: 8,
      indiaRecords: 10,
    } as SourceManifest;
    const report = {
      sourceComplete: true,
      marketComplete: false,
      requestedBarcodes: 10,
      accountedBarcodes: 10,
      outcomes: { failed: 0 },
      exclusions: { records: 2, reconcilesIndiaSlice: true },
    };
    expect(() => assertPublicationEvidence(manifest, report)).not.toThrow();
    expect(() => assertPublicationEvidence(manifest, { ...report, accountedBarcodes: 9 })).toThrow("barcode accounting");
    expect(() => assertPublicationEvidence(manifest, { ...report, outcomes: { failed: 1 } })).toThrow("failed barcodes");
  });

  it("requires terminal barcode accounting for multi-prediction Robotoff evidence", () => {
    const manifest = {
      source: "open_food_facts_robotoff",
      mode: "production",
      sourceComplete: true,
      terminalEvidence: "end_of_file",
      stagedRecords: 14,
      indiaRecords: 10,
    } as SourceManifest;
    const report = {
      sourceComplete: true,
      marketComplete: false,
      requestedBarcodes: 10,
      accountedBarcodes: 10,
      outcomes: { failed: 0 },
      exclusions: { records: 2, reconcilesIndiaSlice: true },
    };
    expect(() => assertPublicationEvidence(manifest, report)).not.toThrow();
    expect(() => assertPublicationEvidence(manifest, { ...report, accountedBarcodes: 9 })).toThrow("barcode accounting");
    expect(() => assertPublicationEvidence(manifest, { ...report, outcomes: { failed: 1 } })).toThrow("failed barcodes");
  });

  it("requires terminal barcode accounting for multi-prediction Robotoff ingredient evidence", () => {
    const manifest = {
      source: "open_food_facts_robotoff_ingredients",
      mode: "production",
      sourceComplete: true,
      terminalEvidence: "end_of_file",
      stagedRecords: 14,
      indiaRecords: 10,
    } as SourceManifest;
    const report = {
      sourceComplete: true,
      marketComplete: false,
      requestedBarcodes: 10,
      accountedBarcodes: 10,
      outcomes: { failed: 0 },
      exclusions: { records: 2, reconcilesIndiaSlice: true },
    };
    expect(() => assertPublicationEvidence(manifest, report)).not.toThrow();
    expect(() => assertPublicationEvidence(manifest, { ...report, accountedBarcodes: 9 })).toThrow("barcode accounting");
    expect(() => assertPublicationEvidence(manifest, { ...report, outcomes: { failed: 1 } })).toThrow("failed barcodes");
  });

  it("streams all India-tagged foods without protein prefiltering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-ingest-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(
      input,
      [
        JSON.stringify(indiaProduct),
        JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats", categories_tags: ["en:oats"] }),
        JSON.stringify({ ...indiaProduct, code: "8900000000036", countries_tags: ["en:united-states"] }),
      ].join("\n"),
      "utf8",
    );
    const result = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null });
    expect(result.manifest).toMatchObject({ recordsRead: 3, indiaRecords: 2, stagedRecords: 2, sourceComplete: true, marketComplete: false });
    const staged = (await readFile(result.stagedPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; nutrition: { status: string }; nutrients: Array<{ code: string }> });
    expect(staged.map(({ name }) => name)).toEqual(["Test Soya Chunks", "Ordinary Oats"]);
    expect(staged[0]?.nutrition.status).toBe("unverified");
    expect(staged[0]?.nutrients.some(({ code }) => code === "calcium")).toBe(true);
  });

  it("preserves a liquid nutrition basis instead of labeling it per 100 g", () => {
    const normalized = normalizeOpenFoodFactsRecord({
      ...indiaProduct,
      code: "8900000000029",
      product_name: "Protein Drink",
      quantity: "6 x 200ml",
      product_quantity: 1200,
      product_quantity_unit: "ml",
      serving_size: "70 ml",
      serving_quantity: 70,
      serving_quantity_unit: "ml",
    });
    expect(normalized.staged?.nutrition.basis).toBe("per_100ml");
    expect(normalized.staged?.netQuantityGrams).toBeNull();
    expect(normalized.staged?.servingSizeGrams).toBeNull();
    expect(normalized.staged?.nutrients.every(({ basis }) => basis === "per_100ml")).toBe(true);
    const computedGramServing = normalizeOpenFoodFactsRecord({
      ...indiaProduct,
      code: "8900000000043",
      serving_size: "",
      serving_quantity: 50,
    });
    expect(computedGramServing.staged?.servingSizeGrams).toBe(50);
    const declaredLiquid = normalizeOpenFoodFactsRecord({
      ...indiaProduct,
      code: "8900000000050",
      quantity: "",
      serving_size: "1 can (250 ml)",
      nutrition_data_per: "100ml",
      nutriments: { "energy-kcal_100g": 901, proteins_100g: 1 },
    });
    expect(declaredLiquid.staged?.nutrition.basis).toBe("per_100ml");
    expect(declaredLiquid.issues).not.toContainEqual(expect.objectContaining({
      code: "energy_over_physical_maximum",
    }));
    const massBeforePreparationVolume = normalizeOpenFoodFactsRecord({
      ...indiaProduct,
      code: "8900000000050",
      quantity: "",
      serving_size: "36 grams in 350 ml of water",
    });
    expect(massBeforePreparationVolume.staged?.nutrition.basis).toBe("per_100g");
    expect(massBeforePreparationVolume.staged?.servingSizeGrams).toBe(36);
    const unknown = normalizeOpenFoodFactsRecord({ ...indiaProduct, code: "8900000000036", quantity: "" });
    expect(unknown.staged?.nutrition.basis).toBe("per_100g");
  });

  it("writes an auditable exclusion ledger that reconciles the India slice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-exclusions-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(input, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "", product_name: "Missing code" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000012", product_name: "Duplicate record" }),
    ].join("\n"), "utf8");
    const result = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null });
    const exclusions = (await readFile(result.exclusionsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      sourceRow: number;
      sourceRecordId: string | null;
      reasonCodes: string[];
      evidenceHash: string;
    });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as { exclusions: { records: number; reconcilesIndiaSlice: boolean } };
    expect(exclusions).toHaveLength(2);
    expect(exclusions.map(({ reasonCodes }) => reasonCodes[0])).toEqual(["missing_identity", "duplicate_source_record_id"]);
    expect(exclusions.every(({ sourceRow, evidenceHash }) => sourceRow > 0 && evidenceHash.length === 64)).toBe(true);
    expect(report.exclusions).toEqual({ records: 2, path: "exclusions.jsonl", reconcilesIndiaSlice: true });
    expect(result.manifest).toMatchObject({ indiaRecords: 3, stagedRecords: 1, invalidRecords: 1, duplicateRecords: 1 });
  });

  it("fails closed for capped production traversal", async () => {
    await expect(stageOpenFoodFacts({ input: "unused", outputDirectory: "unused", mode: "production", limit: 10 })).rejects.toThrow(
      "Production source traversal cannot use a record limit",
    );
  });

  it("fails closed on an empty India snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-empty-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(input, `${JSON.stringify({ ...indiaProduct, countries_tags: ["en:france"] })}\n`, "utf8");
    await expect(stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null })).rejects.toThrow(
      "zero India-tagged staged records",
    );
  });

  it("compares a complete production snapshot with the prior source index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-continuity-"));
    const firstInput = join(directory, "first.jsonl");
    const secondInput = join(directory, "second.jsonl");
    await writeFile(firstInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
    ].join("\n"), "utf8");
    const first = await stageOpenFoodFacts({
      input: firstInput,
      outputDirectory: join(directory, "first"),
      mode: "production",
      limit: null,
      sourceUpdatedAt: "2026-07-14T00:00:00Z",
    });
    await writeFile(secondInput, [
      JSON.stringify({ ...indiaProduct, ingredients_text: "Defatted soy flour (100%)" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000043", product_name: "Plain Curd" }),
    ].join("\n"), "utf8");
    const second = await stageOpenFoodFacts({
      input: secondInput,
      outputDirectory: join(directory, "second"),
      mode: "production",
      limit: null,
      previousManifestPath: first.manifestPath,
      previousIndexPath: first.indexPath,
    });
    expect(second.manifest).toMatchObject({
      sourceComplete: true,
      newRecords: 1,
      changedRecords: 1,
      unchangedRecords: 1,
      missingSinceRecords: 0,
    });
    expect(second.manifest.sourceUpdatedAt).toBeNull();
  });

  it("fails closed when a production snapshot materially shrinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-drop-"));
    const firstInput = join(directory, "first.jsonl");
    const secondInput = join(directory, "second.jsonl");
    await writeFile(firstInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000043", product_name: "Plain Curd" }),
    ].join("\n"), "utf8");
    const first = await stageOpenFoodFacts({
      input: firstInput,
      outputDirectory: join(directory, "first"),
      mode: "production",
      limit: null,
    });
    await writeFile(secondInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
    ].join("\n"), "utf8");
    await expect(stageOpenFoodFacts({
      input: secondInput,
      outputDirectory: join(directory, "second"),
      mode: "production",
      limit: null,
      previousManifestPath: first.manifestPath,
      previousIndexPath: first.indexPath,
      maximumDropRatio: 0.2,
    })).rejects.toThrow("Source continuity failure");
  });
});

describe("Open Food Facts rich API enrichment", () => {
  async function sourceSnapshot(directory: string, records = 2) {
    const input = join(directory, "source.jsonl");
    const products = [
      { ...indiaProduct, nutriments: {} },
      { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats", nutriments: {} },
    ].slice(0, records);
    await writeFile(input, `${products.map((product) => JSON.stringify(product)).join("\n")}\n`, "utf8");
    return stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
  }

  it("fills compact-export gaps and accounts for every requested barcode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-"));
    const source = await sourceSnapshot(directory);
    const fetcher = async () => new Response(JSON.stringify({
      count: 1,
      products: [indiaProduct],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      fetcher,
    });
    expect(result.outcomes).toEqual({ enriched: 1, unchanged: 0, not_found: 1, rejected: 0, failed: 0 });
    expect(result.manifest).toMatchObject({ source: "open_food_facts_api", sourceComplete: true, recordsRead: 2, stagedRecords: 1 });
    const staged = JSON.parse((await readFile(result.stagedPath, "utf8")).trim()) as { source: string; nutrition: { status: string; per100g: { proteinGrams: number; calories: number } } };
    expect(staged).toMatchObject({ source: "open_food_facts_api", nutrition: { status: "unverified", per100g: { proteinGrams: 52, calories: 345 } } });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      requestedBarcodes: number;
      accountedBarcodes: number;
      exclusions: { records: number; reconcilesIndiaSlice: boolean };
      coverage: { nutritionPairs: { baseline: number; afterEnrichment: number; delta: number } };
    };
    expect(report).toMatchObject({
      requestedBarcodes: 2,
      accountedBarcodes: 2,
      exclusions: { records: 1, reconcilesIndiaSlice: true },
      coverage: { nutritionPairs: { baseline: 0, afterEnrichment: 1, delta: 1 } },
    });
  });

  it("resumes from matching batch artifacts without refetching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-resume-"));
    const source = await sourceSnapshot(directory, 1);
    const outputDirectory = join(directory, "enriched");
    let requests = 0;
    const firstFetch = async () => {
      requests += 1;
      return new Response(JSON.stringify({ count: 1, products: [indiaProduct] }), { status: 200 });
    };
    await enrichOpenFoodFactsApi({ input: source.stagedPath, inputManifest: source.manifestPath, outputDirectory, mode: "sample", limit: null, minimumIntervalMs: 0, fetcher: firstFetch });
    const resumed = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      fetcher: async () => { throw new Error("resume should not fetch"); },
    });
    expect(requests).toBe(1);
    const report = JSON.parse(await readFile(resumed.reportPath, "utf8")) as { fetchedBatches: number; resumedBatches: number };
    expect(report).toMatchObject({ fetchedBatches: 0, resumedBatches: 1 });
  });

  it("retries transient failures and preserves incomplete accounting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-retry-"));
    const source = await sourceSnapshot(directory, 1);
    let attempts = 0;
    const transient = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "transient"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("busy", { status: 503 })
          : new Response(JSON.stringify({ count: 1, products: [indiaProduct] }), { status: 200 });
      },
    });
    expect(attempts).toBe(2);
    expect(transient.manifest.sourceComplete).toBe(true);

    const failedDirectory = join(directory, "failed");
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: failedDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      fetcher: async () => new Response("busy", { status: 503 }),
    })).rejects.toThrow("incomplete");
    const failedReport = JSON.parse(await readFile(join(failedDirectory, "report.json"), "utf8")) as { sourceComplete: boolean; accountedBarcodes: number; outcomes: { failed: number } };
    expect(failedReport).toMatchObject({ sourceComplete: false, accountedBarcodes: 1, outcomes: { failed: 1 } });
  });

  it("times out a hung upstream request and preserves terminal accounting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-timeout-"));
    const source = await sourceSnapshot(directory, 1);
    let attempts = 0;
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "timed-out"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      requestTimeoutMs: 5,
      fetcher: async (_input, init) => {
        attempts += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    })).rejects.toThrow("incomplete");
    expect(attempts).toBe(4);
    const report = JSON.parse(await readFile(join(directory, "timed-out/report.json"), "utf8")) as {
      requestTimeoutMs: number;
      sourceComplete: boolean;
      outcomes: { failed: number };
    };
    expect(report).toMatchObject({ requestTimeoutMs: 5, sourceComplete: false, outcomes: { failed: 1 } });
  });

  it("retries only failed batches on resume and clears stale failure evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-partial-resume-"));
    const source = await sourceSnapshot(directory, 2);
    const outputDirectory = join(directory, "enriched");
    let firstRunRequests = 0;
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 1,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 1,
      fetcher: async () => {
        firstRunRequests += 1;
        return firstRunRequests === 1
          ? new Response(JSON.stringify({ products: [indiaProduct] }), { status: 200 })
          : new Response("busy", { status: 503 });
      },
    })).rejects.toThrow("incomplete");
    expect(firstRunRequests).toBe(3);
    expect(await readFile(join(outputDirectory, "responses/batch-00002.json.error.json"), "utf8")).toContain("failed after retry");

    let resumedRequests = 0;
    const resumedProduct = { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" };
    const resumed = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 1,
      minimumIntervalMs: 10_000,
      fetcher: async () => {
        resumedRequests += 1;
        return new Response(JSON.stringify({ products: [resumedProduct] }), { status: 200 });
      },
    });
    expect(resumedRequests).toBe(1);
    expect(resumed.manifest.sourceComplete).toBe(true);
    const report = JSON.parse(await readFile(resumed.reportPath, "utf8")) as { fetchedBatches: number; resumedBatches: number };
    expect(report).toMatchObject({ fetchedBatches: 1, resumedBatches: 1 });
    await expect(readFile(join(outputDirectory, "responses/batch-00002.json.error.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("splits a persistently unavailable batch and preserves complete accounting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-split-"));
    const source = await sourceSnapshot(directory, 2);
    const returnedByCode = new Map([
      ["8900000000012", indiaProduct],
      ["8900000000029", { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }],
    ]);
    let requests = 0;
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 5,
      fetcher: async (input) => {
        requests += 1;
        const codes = new URL(input.toString()).searchParams.get("code")?.split(",") ?? [];
        if (codes.length > 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ products: codes.flatMap((code) => returnedByCode.get(code) ?? []) }), { status: 200 });
      },
    });
    expect(requests).toBe(7);
    expect(result.manifest.sourceComplete).toBe(true);
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as { accountedBarcodes: number; fallbackSplits: number; outcomes: { failed: number } };
    expect(report).toMatchObject({ accountedBarcodes: 2, fallbackSplits: 1, outcomes: { failed: 0 } });
  });

  it("retries a transient multi-code 503 before splitting the batch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-multi-retry-"));
    const source = await sourceSnapshot(directory, 2);
    const returnedByCode = new Map([
      ["8900000000012", indiaProduct],
      ["8900000000029", { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }],
    ]);
    let requests = 0;
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      fetcher: async (input) => {
        requests += 1;
        if (requests === 1) return new Response("busy", { status: 503 });
        const codes = new URL(input.toString()).searchParams.get("code")?.split(",") ?? [];
        return new Response(JSON.stringify({ products: codes.flatMap((code) => returnedByCode.get(code) ?? []) }), { status: 200 });
      },
    });
    expect(requests).toBe(2);
    expect(result.manifest.sourceComplete).toBe(true);
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as { fallbackSplits: number; outcomes: { failed: number } };
    expect(report).toMatchObject({ fallbackSplits: 0, outcomes: { failed: 0 } });
  });

  it("uses the single-product endpoint after an isolated search failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-product-fallback-"));
    const source = await sourceSnapshot(directory, 1);
    const requests: string[] = [];
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 1,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      fetcher: async (input) => {
        const url = input.toString();
        requests.push(url);
        if (url.includes("/api/v2/search")) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ status: 1, product: indiaProduct }), { status: 200 });
      },
    });
    expect(requests).toHaveLength(3);
    expect(requests.slice(0, 2).every((url) => url.includes("/api/v2/search"))).toBe(true);
    expect(requests[2]).toContain("/api/v2/product/8900000000012");
    expect(result.manifest.sourceComplete).toBe(true);
    expect(result.outcomes.failed).toBe(0);
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as { singleProductFallbacks: number };
    expect(report.singleProductFallbacks).toBe(1);
  });

  it("records an official single-product miss as not found instead of failed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-product-miss-"));
    const source = await sourceSnapshot(directory, 1);
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 1,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 1,
      fetcher: async (input) => input.toString().includes("/api/v2/search")
        ? new Response("busy", { status: 503 })
        : new Response(JSON.stringify({ status: 0, status_verbose: "product not found" }), { status: 200 }),
    });
    expect(result.manifest.sourceComplete).toBe(true);
    expect(result.outcomes).toMatchObject({ not_found: 1, failed: 0 });
  });

  it("preserves successful split siblings and resumes only failed codes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-partial-split-"));
    const source = await sourceSnapshot(directory, 2);
    const outputDirectory = join(directory, "enriched");
    let firstRequests = 0;
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 1,
      minimumSplitBatchSize: 1,
      fetcher: async (input) => {
        firstRequests += 1;
        const codes = new URL(input.toString()).searchParams.get("code")?.split(",") ?? [];
        if (codes.length > 1 || codes[0] === "8900000000029") return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ products: [indiaProduct] }), { status: 200 });
      },
    })).rejects.toThrow("incomplete");
    expect(firstRequests).toBe(4);
    const partial = JSON.parse(await readFile(join(outputDirectory, "responses/batch-00001.json"), "utf8")) as {
      response: { products: Array<{ code: string }> };
      failedCodes: string[];
    };
    expect(partial.response.products.map(({ code }) => code)).toEqual(["8900000000012"]);
    expect(partial.failedCodes).toEqual(["8900000000029"]);

    let resumedRequests = 0;
    const resumedProduct = { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" };
    const resumed = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      fetcher: async (input) => {
        resumedRequests += 1;
        expect(new URL(input.toString()).searchParams.get("code")).toBe("8900000000029");
        return new Response(JSON.stringify({ products: [resumedProduct] }), { status: 200 });
      },
    });
    expect(resumedRequests).toBe(1);
    expect(resumed.outcomes.failed).toBe(0);
    expect(resumed.manifest.sourceComplete).toBe(true);
  });
});

describe("Robotoff label evidence", () => {
  const context: RobotoffProductContext = {
    code: "8900000000012",
    brand: "Test Brand",
    name: "Test Protein Bar",
    flavour: "Cocoa",
    category: "protein_bar",
    categoryRaw: "Protein bars",
    netQuantityGrams: 40,
    servingSizeGrams: 40,
    nutritionBasis: "per_100g",
    imageUrl: null,
    nutritionImageUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/nutrition_en.2.400.jpg",
  };

  function prediction(id: number, imageId: string, nutrients: Record<string, unknown>) {
    return {
      id,
      type: "nutrition_extraction",
      model_name: "nutrition_extractor",
      model_version: "nutrition_extractor-2.0",
      timestamp: "2026-07-15T10:00:00",
      image: { image_id: imageId, source_image: `/890/000/000/0012/${imageId}.jpg`, uploaded_at: "2026-07-15T09:00:00" },
      data: { nutrients },
    };
  }

  const nutrient = (value: number, unit: string, score = 0.98) => ({ value: String(value), unit, score });

  async function sourceWithNutritionImage(directory: string) {
    const input = join(directory, "source.jsonl");
    await writeFile(input, `${JSON.stringify({
      ...indiaProduct,
      image_nutrition_url: context.nutritionImageUrl,
    })}\n`, "utf8");
    return stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
  }

  it("fails closed for nutrition artifacts without exact label-byte proof", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-legacy-"));
    await expect(validateRobotoffNutritionArtifact(directory)).rejects.toThrow("label-assets.jsonl is required");
  });

  it("retains a plausible per-100-g prediction as review evidence only", () => {
    const response = { image_predictions: [prediction(1, "7", {
      "energy-kcal_100g": nutrient(365, "kcal"),
      proteins_100g: nutrient(25, "g"),
      carbohydrates_100g: nutrient(46.5, "g"),
      fat_100g: nutrient(8.9, "g"),
    })] };
    const result = parseRobotoffNutritionEvidence(response, context);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ basis: "per_100g", modelVersion: "nutrition_extractor-2.0", nutritionPer100g: { calories: 365, proteinGrams: 25 } });
    expect(result.staged[0]?.nutrition.status).toBe("missing");
    expect(result.staged[0]?.rawEvidence).toMatchObject({ candidate: { imageId: "7" }, candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.staged[0]?.validationIssues).toContainEqual(expect.objectContaining({
      code: "robotoff_nutrition_candidate",
      details: expect.objectContaining({ candidateHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    }));
    expect(result.staged[0]?.validationIssues.some(({ code }) => code === "robotoff_nutrition_candidate")).toBe(true);
  });

  it("emits label candidates into the nutrition review queue without selecting facts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-review-"));
    const result = parseRobotoffNutritionEvidence({ image_predictions: [prediction(7, "13", {
      "energy-kcal_100g": nutrient(365, "kcal"),
      proteins_100g: nutrient(25, "g"),
    })] }, context);
    const stagedPath = join(directory, "staged-products.jsonl");
    const manifestPath = join(directory, "manifest.json");
    const sqlPath = join(directory, "import.sql");
    const legacyStaged = structuredClone(result.staged);
    const legacyCandidate = legacyStaged[0]?.validationIssues.find(({ code }) => code === "robotoff_nutrition_candidate");
    if (legacyCandidate?.details) delete legacyCandidate.details.candidateHash;
    await writeFile(stagedPath, `${legacyStaged.map((product) => JSON.stringify(product)).join("\n")}\n`, "utf8");
    const now = "2026-07-15T10:00:00.000Z";
    const manifest: SourceManifest = {
      schemaVersion: 1,
      source: "open_food_facts_robotoff",
      sourceKind: "open_data",
      sourceAuthority: { identity: 0, nutrition: 20, ingredients: 0 },
      sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
      sourceRetentionNotes: "Test Robotoff review artifact",
      adapterVersion: "robotoff-test",
      input: "fixture",
      inputHash: "a".repeat(64),
      inputBytes: 1,
      sourceUpdatedAt: null,
      startedAt: now,
      completedAt: now,
      mode: "sample",
      terminalEvidence: "end_of_file",
      sourceComplete: true,
      marketComplete: false,
      advertisedTotal: 1,
      recordsRead: 1,
      indiaRecords: 1,
      stagedRecords: 1,
      invalidRecords: 0,
      duplicateRecords: 0,
      newRecords: 1,
      changedRecords: 0,
      unchangedRecords: 0,
      missingSinceRecords: 0,
      knownExclusions: [],
      disconnectedSources: [],
    };
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await emitImportSql({ stagedPath, manifestPath, outputPath: sqlPath });
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("'nutrition_validation'");
    expect(sql).toContain("robotoff_nutrition_candidate");
    expect(sql).toContain("evidence_decisions");
    expect(sql).toContain("candidate_hash");
    expect(sql).toMatch(/candidateHash.{0,8}[a-f0-9]{64}/);
    expect(sql).toContain("INSERT INTO nutrition_facts");
    expect(sql).toContain("d.decision = 'verify'");
    expect(result.staged[0]?.nutrition.status).toBe("missing");
    const automaticSqlPath = join(directory, "automatic-import.sql");
    await emitImportSql({
      stagedPath,
      manifestPath,
      outputPath: automaticSqlPath,
      applyEvidenceDecisions: false,
    });
    const automaticSql = await readFile(automaticSqlPath, "utf8");
    expect(automaticSql).toContain("UPDATE nutrition_facts SET status = 'conflict'");
    expect(automaticSql).not.toContain("SELECT d.product_id, d.source_record_id, 'verified'");
    expect(automaticSql).not.toContain("'nutrition', 'verified', d.source_record_id");
  });

  it("normalizes an explicit serving basis only with serving mass", () => {
    const response = { image_predictions: [prediction(2, "8", {
      "energy-kcal_serving": nutrient(146, "kcal"),
      proteins_serving: nutrient(10, "g"),
      fat_serving: nutrient(3.57, "g"),
    })] };
    const converted = parseRobotoffNutritionEvidence(response, context);
    expect(converted.candidates[0]).toMatchObject({ basis: "per_serving", nutritionPer100g: { calories: 365, proteinGrams: 25 } });
    expect(converted.candidates[0] && nutritionCandidateValues(converted.candidates[0]).fatGrams).toBeCloseTo(8.925, 6);
    const ambiguous = parseRobotoffNutritionEvidence(response, { ...context, servingSizeGrams: null });
    expect(ambiguous.candidates).toHaveLength(0);
    expect(ambiguous.issues.some(({ code }) => code === "robotoff_ambiguous_serving_basis")).toBe(true);
  });

  it("uses the serving mass extracted from the same label instead of a conflicting catalog value", () => {
    const response = { image_predictions: [prediction(28, "26", {
      serving_size: { value: "25g", unit: null, score: 0.9 },
      "energy-kcal_serving": nutrient(125, "kcal"),
      proteins_serving: nutrient(2, "g"),
      carbohydrates_serving: nutrient(16, "g"),
      fat_serving: nutrient(6, "g"),
    })] };
    const result = parseRobotoffNutritionEvidence(response, { ...context, servingSizeGrams: 100 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      basis: "per_serving",
      minimumConfidence: 0.9,
      nutritionPer100g: {
        calories: 500,
        proteinGrams: 8,
        carbohydrateGrams: 64,
        fatGrams: 24,
      },
    });
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_overrides_context",
      field: "servingSizeGrams",
    }));
  });

  it("rejects implausible serving OCR and physically impossible calorie density", () => {
    const ghee = parseRobotoffNutritionEvidence({ image_predictions: [prediction(31, "29", {
      serving_size: { value: "714 g", unit: null, score: 0.9985 },
      "energy-kcal_serving": nutrient(126, "kcal"),
      proteins_serving: nutrient(0, "g"),
      fat_serving: nutrient(14, "g"),
      "saturated-fat_serving": nutrient(9.3, "g"),
    })] }, {
      ...context,
      name: "Ghee",
      netQuantityGrams: 144,
      servingSizeGrams: 14,
    });
    expect(ghee.candidates[0]).toMatchObject({
      nutritionPer100g: { calories: 900, proteinGrams: 0, fatGrams: 100 },
    });
    expect(ghee.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_implausible",
      field: "servingSizeGrams",
    }));

    const cashews = parseRobotoffNutritionEvidence({ image_predictions: [prediction(32, "30", {
      serving_size: { value: "28g", unit: null, score: 0.998 },
      "energy-kcal_serving": nutrient(370, "kcal", 0.9),
      proteins_serving: nutrient(5, "g"),
      fat_serving: nutrient(14, "g"),
    })] }, { ...context, name: "Sea Salted Whole Cashews", servingSizeGrams: 70 });
    expect(cashews.candidates).toHaveLength(0);
    expect(cashews.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_energy_over_physical_maximum",
      field: "calories",
    }));
  });

  it("uses catalog corroboration for conflicting serving evidence and ignores incompatible units", () => {
    const nutrients = {
      serving_size: { value: "6 g", text: "69g", unit: null, score: 0.99 },
      "energy-kcal_serving": nutrient(69, "kcal"),
      proteins_serving: nutrient(6.9, "g"),
    };
    const corroborated = parseRobotoffNutritionEvidence(
      { image_predictions: [prediction(33, "31", nutrients)] },
      { ...context, netQuantityGrams: 100, servingSizeGrams: 69 },
    );
    expect(corroborated.candidates[0]).toMatchObject({
      nutritionPer100g: { calories: 100, proteinGrams: 10 },
    });
    expect(corroborated.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_conflict_resolved",
    }));
    expect(corroborated.candidates[0]?.rawNutrients.serving_size).toMatchObject({ value: "6 g", text: "69g" });

    const uncorroborated = parseRobotoffNutritionEvidence(
      { image_predictions: [prediction(34, "32", nutrients)] },
      context,
    );
    expect(uncorroborated.candidates[0]).toMatchObject({
      nutritionPer100g: { calories: 172.5, proteinGrams: 17.25 },
    });
    expect(uncorroborated.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_evidence_conflict",
    }));

    const incompatible = parseRobotoffNutritionEvidence({ image_predictions: [prediction(35, "33", {
      serving_size: { value: "250 mL", unit: null, score: 0.99 },
      "energy-kcal_serving": nutrient(146, "kcal"),
      proteins_serving: nutrient(10, "g"),
    })] }, context);
    expect(incompatible.candidates[0]).toMatchObject({
      nutritionPer100g: { calories: 365, proteinGrams: 25 },
    });
    expect(incompatible.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_incompatible_unit",
    }));

    const mixedDimensions = parseRobotoffNutritionEvidence({ image_predictions: [prediction(36, "34", {
      serving_size: { value: "250 mL", text: "25 g", unit: null, score: 0.99 },
      "energy-kcal_serving": nutrient(100, "kcal"),
      proteins_serving: nutrient(10, "g"),
    })] }, context);
    expect(mixedDimensions.candidates[0]).toMatchObject({
      nutritionPer100g: { calories: 250, proteinGrams: 25 },
    });
    expect(mixedDimensions.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_incompatible_unit",
      details: expect.objectContaining({ corroborated: false }),
    }));
  });

  it("uses a confident label serving volume but ignores a low-confidence override", () => {
    const volumeContext: RobotoffProductContext = {
      ...context,
      name: "Cola",
      netQuantityGrams: null,
      servingSizeGrams: null,
      servingSizeMillilitres: 200,
      nutritionBasis: "per_100ml",
    };
    const nutrients = {
      serving_size: { value: "355", unit: "mL", score: 0.99 },
      "energy-kcal_serving": nutrient(95, "kcal"),
      proteins_serving: nutrient(0, "g"),
      carbohydrates_serving: nutrient(24, "g"),
    };
    const corrected = parseRobotoffNutritionEvidence(
      { image_predictions: [prediction(29, "27", nutrients)] },
      volumeContext,
    );
    expect(corrected.candidates[0]).toMatchObject({
      basis: "per_serving",
      nutritionPer100ml: {
        calories: expect.closeTo(26.760563, 6),
        proteinGrams: 0,
        carbohydrateGrams: expect.closeTo(6.760563, 6),
      },
    });
    expect(corrected.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_overrides_context",
      field: "servingSizeMillilitres",
    }));

    const untrusted = parseRobotoffNutritionEvidence(
      { image_predictions: [prediction(30, "28", {
        ...nutrients,
        serving_size: { value: "355", unit: "mL", score: 0.5 },
      })] },
      volumeContext,
    );
    expect(untrusted.candidates[0]).toMatchObject({
      nutritionPer100ml: { calories: 47.5, proteinGrams: 0, carbohydrateGrams: 12 },
    });
    expect(untrusted.issues).not.toContainEqual(expect.objectContaining({
      code: "robotoff_label_serving_size_overrides_context",
    }));
  });

  it("retains volume nutrition without treating millilitres as grams", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-volume-"));
    const input = join(directory, "source.jsonl");
    await writeFile(input, `${JSON.stringify({
      ...indiaProduct,
      quantity: "70 ml",
      product_quantity: 70,
      product_quantity_unit: "ml",
      serving_size: "70 ml",
      serving_quantity: 70,
      serving_quantity_unit: "ml",
      image_nutrition_url: context.nutritionImageUrl,
    })}\n`, "utf8");
    const source = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
    const legacy = JSON.parse((await readFile(source.stagedPath, "utf8")).trim()) as Record<string, unknown>;
    expect(legacy.servingSizeGrams).toBeNull();
    legacy.servingSizeGrams = 70;
    await writeFile(source.stagedPath, `${JSON.stringify(legacy)}\n`, "utf8");

    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: labelImageFetcher,
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [prediction(22, "20", {
        "energy-kcal_100g": nutrient(155, "kcal"),
        proteins_100g: nutrient(4.5, "g"),
      })] }), { status: 200 }),
    });
    expect(result.outcomes).toEqual({ candidate: 1, no_prediction: 0, rejected: 0, failed: 0 });
    expect(result.manifest.adapterVersion).toBe("robotoff-api-v8");
    const staged = JSON.parse((await readFile(result.stagedPath, "utf8")).trim()) as {
      validationIssues: Array<{ code: string }>;
      rawEvidence: { candidate: Record<string, unknown> };
    };
    expect(staged.validationIssues).toContainEqual(expect.objectContaining({ code: "robotoff_nutrition_candidate" }));
    expect(staged.rawEvidence.candidate).toMatchObject({
      basis: "per_100ml",
      nutritionPer100ml: { calories: 155, proteinGrams: 4.5 },
    });
    expect(staged.rawEvidence.candidate).not.toHaveProperty("nutritionPer100g");
    const sqlPath = join(directory, "robotoff-import.sql");
    await emitImportSql({ stagedPath: result.stagedPath, manifestPath: result.manifestPath, outputPath: sqlPath });
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("Superseded by corrected source evidence");
    expect(sql).toContain("json_extract(evidence_json, '$.code') = 'robotoff_nutrition_candidate'");
    expect(sql).toContain("'per_100ml'");
    expect(sql).toContain("$.nutritionPer100ml.calories");
  });

  it("normalizes a liquid serving only from explicit serving volume", () => {
    const response = { image_predictions: [prediction(25, "23", {
      "energy-kcal_serving": nutrient(125, "kcal"),
      proteins_serving: nutrient(25, "g"),
      sodium_serving: nutrient(50, "mg"),
    })] };
    const volumeContext: RobotoffProductContext = {
      ...context,
      name: "Protein water",
      netQuantityGrams: null,
      servingSizeGrams: null,
      servingSizeMillilitres: 250,
      nutritionBasis: "per_100ml",
      sourceNutritionPer100g: null,
    };
    const result = parseRobotoffNutritionEvidence(response, volumeContext);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      basis: "per_serving",
      nutritionPer100ml: { calories: 50, proteinGrams: 10, sodiumMg: 20 },
    });
    expect(result.candidates[0]).not.toHaveProperty("nutritionPer100g");

    const missingVolume = parseRobotoffNutritionEvidence(response, {
      ...volumeContext,
      servingSizeMillilitres: null,
      servingSizeGrams: 250,
    });
    expect(missingVolume.candidates).toHaveLength(0);
    expect(missingVolume.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_ambiguous_serving_basis",
      field: "servingSizeMillilitres",
    }));
  });

  it("merges supplementary serving values only when both core bases agree", () => {
    const response = { image_predictions: [prediction(20, "18", {
      "energy-kcal_100g": nutrient(365, "kcal"),
      proteins_100g: nutrient(25, "g"),
      carbohydrates_100g: nutrient(46.5, "g"),
      fat_100g: nutrient(8.9, "g"),
      "energy-kcal_serving": nutrient(146, "kcal"),
      "saturated-fat_serving": nutrient(0.8, "g"),
      sodium_serving: nutrient(100, "mg"),
    })] };
    const result = parseRobotoffNutritionEvidence(response, context);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      basis: "per_100g",
      nutritionPer100g: {
        calories: 365,
        proteinGrams: 25,
        saturatedFatGrams: 2,
        sodiumMg: 250,
      },
    });
  });

  it("does not backfill total sugar from a serving column and prefers declared kcal over converted kJ", () => {
    const result = parseRobotoffNutritionEvidence({ image_predictions: [prediction(23, "21", {
      "energy-kj_100g": nutrient(459, "kJ"),
      proteins_100g: nutrient(19.1, "g"),
      carbohydrates_100g: nutrient(5.9, "g"),
      "energy-kcal_serving": nutrient(187, "kcal"),
      proteins_serving: nutrient(32.4, "g"),
      sugars_serving: nutrient(0, "g"),
    })] }, { ...context, netQuantityGrams: 170, servingSizeGrams: 170 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      basis: "per_100g",
      nutritionPer100g: {
        calories: 110,
        proteinGrams: 19.1,
        carbohydrateGrams: 5.9,
        sugarGrams: null,
      },
    });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "robotoff_ambiguous_total_sugar_basis" }));
  });

  it("corrects a kcal value mislabeled as per-100-g kJ only when the macro floor proves conversion impossible", () => {
    const corrected = parseRobotoffNutritionEvidence({ image_predictions: [prediction(26, "24", {
      "energy-kj_100g": nutrient(385.05, "kJ"),
      proteins_100g: nutrient(21.91, "g"),
      carbohydrates_100g: nutrient(56.06, "g"),
      sugars_100g: nutrient(10.22, "g"),
      "saturated-fat_100g": nutrient(3.43, "g"),
      "energy-kcal_serving": nutrient(154, "kcal"),
      proteins_serving: nutrient(8.76, "g"),
    })] }, context);
    expect(corrected.candidates).toHaveLength(1);
    expect(corrected.candidates[0]).toMatchObject({
      basis: "per_100g",
      nutritionPer100g: {
        calories: 385.05,
        proteinGrams: 21.91,
        carbohydrateGrams: 56.06,
      },
    });
    expect(corrected.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_energy_kj_entity_corrected_to_kcal",
      field: "energy-kj_100g",
    }));

    const legitimateKj = parseRobotoffNutritionEvidence({ image_predictions: [prediction(27, "25", {
      "energy-kj_100g": nutrient(1_612, "kJ"),
      proteins_100g: nutrient(21.91, "g"),
      carbohydrates_100g: nutrient(56.06, "g"),
    })] }, context);
    expect(legitimateKj.candidates[0]).toMatchObject({
      nutritionPer100g: { calories: expect.closeTo(385.277, 3) },
    });
    expect(legitimateKj.issues).not.toContainEqual(expect.objectContaining({
      code: "robotoff_energy_kj_entity_corrected_to_kcal",
    }));
  });

  it("rejects serving conversion when raw values match a per-100-g source anchor", () => {
    const result = parseRobotoffNutritionEvidence({ image_predictions: [prediction(24, "22", {
      "energy-kcal_serving": nutrient(312, "kcal"),
      proteins_serving: nutrient(20, "g"),
      carbohydrates_serving: nutrient(4, "g"),
      fat_serving: nutrient(24, "g"),
    })] }, {
      ...context,
      netQuantityGrams: 50,
      servingSizeGrams: 50,
      sourceNutritionPer100g: {
        calories: 312,
        proteinGrams: 20,
        carbohydrateGrams: 4,
        sugarGrams: 4,
        fatGrams: 24,
        saturatedFatGrams: 14.4,
        fibreGrams: null,
        sodiumMg: 24,
      },
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "robotoff_serving_basis_conflicts_source_anchor" }));
  });

  it("does not assume grams for unitless sodium", () => {
    const response = { image_predictions: [prediction(21, "19", {
      "energy-kcal_100g": nutrient(316, "kcal"),
      proteins_100g: nutrient(52.9, "g"),
      sodium_100g: nutrient(11.1, ""),
    })] };
    const result = parseRobotoffNutritionEvidence(response, context);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0] && nutritionCandidateValues(result.candidates[0]).sodiumMg).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "robotoff_unsupported_nutrient_unit",
      field: "sodium_100g",
    }));
  });

  it("rejects impossible nutrition and exposes multi-image disagreement", () => {
    const impossible = parseRobotoffNutritionEvidence({ image_predictions: [prediction(3, "9", {
      "energy-kcal_100g": nutrient(365, "kcal"),
      proteins_100g: nutrient(120, "g"),
    })] }, context);
    expect(impossible.candidates).toHaveLength(0);
    expect(impossible.issues.some(({ code }) => code === "robotoff_nutrient_over_100g")).toBe(true);

    const conflict = parseRobotoffNutritionEvidence({ image_predictions: [
      prediction(4, "10", { "energy-kcal_100g": nutrient(365, "kcal"), proteins_100g: nutrient(25, "g") }),
      prediction(5, "11", { "energy-kcal_100g": nutrient(200, "kcal"), proteins_100g: nutrient(10, "g") }),
    ] }, context);
    expect(conflict.candidates).toHaveLength(2);
    expect(conflict.staged.every(({ validationIssues }) => validationIssues.some(({ code }) => code === "robotoff_image_conflict"))).toBe(true);
  });

  it("does not use low-confidence core values", () => {
    const result = parseRobotoffNutritionEvidence({ image_predictions: [prediction(6, "12", {
      "energy-kcal_100g": nutrient(365, "kcal", 0.99),
      proteins_100g: nutrient(25, "g", 0.5),
    })] }, context, 0.85);
    expect(result.candidates).toHaveLength(0);
    expect(result.issues.some(({ code }) => code === "robotoff_low_confidence_nutrient")).toBe(true);
  });

  it("exhausts label-image barcodes into resumable review candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-api-"));
    const source = await sourceWithNutritionImage(directory);
    const outputDirectory = join(directory, "robotoff");
    let requests = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      const url = new URL(input.toString());
      expect(url.origin + url.pathname).toBe("https://robotoff.openfoodfacts.org/api/v1/image_predictions");
      expect(url.searchParams.get("barcode")).toBe("08900000000012");
      expect(url.searchParams.get("model_name")).toBe("nutrition_extractor");
      expect(url.searchParams.get("type")).toBe("nutrition_extraction");
      expect(new Headers(init?.headers).get("user-agent")).toContain("protein-index");
      return new Response(JSON.stringify({ image_predictions: [prediction(9, "15", {
        "energy-kcal_100g": nutrient(365, "kcal"),
        proteins_100g: nutrient(25, "g"),
      })] }), { status: 200 });
    };
    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "production",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: labelImageFetcher,
      fetcher,
    });
    expect(requests).toBe(1);
    expect(result.outcomes).toEqual({ candidate: 1, no_prediction: 0, rejected: 0, failed: 0 });
    expect(result.manifest).toMatchObject({
      source: "open_food_facts_robotoff",
      sourceComplete: true,
      recordsRead: 1,
      indiaRecords: 1,
      stagedRecords: 1,
    });
    const staged = JSON.parse((await readFile(result.stagedPath, "utf8")).trim()) as {
      nutrition: { status: string };
      validationIssues: Array<{ code: string }>;
    };
    expect(staged.nutrition.status).toBe("missing");
    expect(staged.validationIssues).toContainEqual(expect.objectContaining({ code: "robotoff_nutrition_candidate" }));
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({
      requestedBarcodes: 1,
      accountedBarcodes: 1,
      fetchedBarcodes: 1,
      resumedBarcodes: 0,
      labelAssets: 2,
      extractionAttempts: 1,
      extractionAttemptLabels: 2,
      extractionRunId: expect.stringMatching(/^xrun_[a-f0-9]{24}$/),
      parentSourceRunId: expect.stringMatching(/^run_[a-f0-9]{24}$/),
    });
    await expect(validateRobotoffNutritionArtifact(outputDirectory)).resolves.toMatchObject({
      extractionAttempts: [{ status: "candidate", candidateCount: 1 }],
      extractionAttemptLabels: expect.arrayContaining([
        expect.objectContaining({ role: "requested", outcome: "no_prediction" }),
        expect.objectContaining({ role: "prediction", outcome: "candidate" }),
      ]),
    });
    const automaticSnapshot = await validateAutomaticPublicationSnapshot(outputDirectory, automaticInput({
      workflowName: "Extract label evidence with Robotoff",
      artifactName: "robotoff-label-candidates-123",
    }));
    expect(automaticSnapshot).toMatchObject({
      validatedStagedRecords: 1,
      extractionImport: {
        run: {
          fieldFamily: "nutrition",
          status: "accepted",
          artifactDigest: "b".repeat(64),
        },
      },
    });
    if (!automaticSnapshot.extractionImport) throw new Error("Expected an exact extraction import plan");
    const database = new DatabaseSync(":memory:");
    for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
      database.exec(await readFile(join("migrations", migration), "utf8"));
    }
    const sourceSqlPath = join(directory, "source-import.sql");
    await emitImportSql({
      stagedPath: source.stagedPath,
      manifestPath: source.manifestPath,
      outputPath: sourceSqlPath,
    });
    database.exec(await readFile(sourceSqlPath, "utf8"));
    const extractionSqlPath = join(directory, "extraction-import.sql");
    await emitImportSql({
      stagedPath: result.stagedPath,
      manifestPath: result.manifestPath,
      outputPath: extractionSqlPath,
      applyEvidenceDecisions: false,
      extraction: automaticSnapshot.extractionImport,
    });
    const extractionSql = await readFile(extractionSqlPath, "utf8");
    database.exec(extractionSql);
    expect(database.prepare(`SELECT
      (SELECT COUNT(*) FROM extraction_runs WHERE status = 'accepted') AS runs,
      (SELECT COUNT(*) FROM label_evidence_assets) AS assets,
      (SELECT COUNT(*) FROM extraction_attempts WHERE is_current = 1) AS current_attempts,
      (SELECT COUNT(*) FROM extraction_attempt_labels) AS labels,
      (SELECT COUNT(*) FROM review_items WHERE status = 'open'
        AND json_extract(evidence_json, '$.details.extractionAttemptId') IS NOT NULL) AS exact_reviews`).get())
      .toEqual({ runs: 1, assets: 2, current_attempts: 1, labels: 2, exact_reviews: 1 });
    const beforeReplay = database.prepare(`SELECT
      (SELECT COUNT(*) FROM extraction_runs) AS runs,
      (SELECT COUNT(*) FROM label_evidence_assets) AS assets,
      (SELECT COUNT(*) FROM extraction_attempts) AS attempts,
      (SELECT COUNT(*) FROM extraction_attempt_labels) AS labels,
      (SELECT COUNT(*) FROM review_items) AS reviews`).get();
    database.exec(extractionSql);
    expect(database.prepare(`SELECT
      (SELECT COUNT(*) FROM extraction_runs) AS runs,
      (SELECT COUNT(*) FROM label_evidence_assets) AS assets,
      (SELECT COUNT(*) FROM extraction_attempts) AS attempts,
      (SELECT COUNT(*) FROM extraction_attempt_labels) AS labels,
      (SELECT COUNT(*) FROM review_items) AS reviews`).get()).toEqual(beforeReplay);
    const tamperedAssetsPath = join(directory, "tampered-label-assets.jsonl");
    const tamperedAssets = (await readFile(result.labelAssetsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    tamperedAssets[0].effectiveUrl = "https://images.openfoodfacts.org/tampered-label.jpg";
    await writeFile(tamperedAssetsPath, `${tamperedAssets.map((asset) => JSON.stringify(asset)).join("\n")}\n`, "utf8");
    const collisionSqlPath = join(directory, "collision-import.sql");
    await emitImportSql({
      stagedPath: result.stagedPath,
      manifestPath: result.manifestPath,
      outputPath: collisionSqlPath,
      applyEvidenceDecisions: false,
      extraction: { ...automaticSnapshot.extractionImport, labelAssetsPath: tamperedAssetsPath },
    });
    const collisionSql = await readFile(collisionSqlPath, "utf8");
    expect(() => database.exec(collisionSql)).toThrow();
    database.exec("ROLLBACK");
    expect(database.prepare("SELECT COUNT(*) AS assets FROM label_evidence_assets").get()).toEqual({ assets: 2 });
    database.close();
    await writeFile(
      join(outputDirectory, "prior-label-assets.jsonl"),
      await readFile(result.labelAssetsPath, "utf8"),
      "utf8",
    );

    const resumed = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "production",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: async () => { throw new Error("restored exact label proof should not be fetched again"); },
      fetcher: async () => { throw new Error("resume should not fetch"); },
    });
    const resumedReport = JSON.parse(await readFile(resumed.reportPath, "utf8")) as Record<string, unknown>;
    expect(resumedReport).toMatchObject({ requestedBarcodes: 1, accountedBarcodes: 1, fetchedBarcodes: 0, resumedBarcodes: 1 });
  });

  it("accounts for absent predictions without inventing nutrition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-empty-"));
    const source = await sourceWithNutritionImage(directory);
    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: labelImageFetcher,
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [] }), { status: 200 }),
    });
    expect(result.outcomes).toEqual({ candidate: 0, no_prediction: 1, rejected: 0, failed: 0 });
    expect(await readFile(result.stagedPath, "utf8")).toBe("");
    const exclusion = JSON.parse((await readFile(result.exclusionsPath, "utf8")).trim()) as { status: string; reasons: string[] };
    expect(exclusion).toEqual(expect.objectContaining({ status: "no_prediction", reasons: ["no_nutrition_extraction_prediction"] }));
  });
});
