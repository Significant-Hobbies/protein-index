import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { normalizeOpenFoodFactsRecord, stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";
import { enrichOpenFoodFactsApi } from "../scripts/adapters/open-food-facts-api";
import { extractRobotoffApi } from "../scripts/adapters/robotoff-api";
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
  type PublicationState,
} from "../scripts/publication";
import { emitImportSql } from "../scripts/reconcile";
import {
  emitReviewDecisionSql,
  readReviewDecisionBundle,
  validateExistingEvidenceDecisions,
  validateReviewPostconditions,
  validateReviewPublicationState,
  validateReviewDecisionSources,
  writeReviewDecisionBundle,
} from "../scripts/review-bundles";
import { canonicalJson, nutritionCandidateFromEvidence, nutritionCandidateHash, type EvidenceDecisionInput } from "../shared/evidence-decisions";
import { ingredientCandidateHash, type IngredientEvidenceDecisionInput } from "../shared/ingredient-evidence";
import { parseIngredients } from "../shared/ingredients";
import type { SourceManifest } from "../shared/types";

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
  artifactName: "open-food-facts-snapshot-123",
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
      mode: "sample",
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

    const resumed = await extractRobotoffIngredientApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
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
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [ingredientPrediction] }), { status: 200 }),
    });
    await writeFile(result.candidatesPath, `${await readFile(result.candidatesPath, "utf8")} `, "utf8");
    await expect(validateRobotoffIngredientArtifact(outputDirectory)).rejects.toThrow("checksum mismatch");
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
    const nutrition = first.payload.nutritionPer100g;
    const postconditions = [
      { success: true, results: decisionRows },
      { success: true, results: [{
        product_id: first.productId,
        source_record_id: first.sourceRecordId,
        status: "verified",
        authority: 100,
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
    ];
    expect(validateReviewPostconditions(parsed, postconditions)).toMatchObject({
      decisions: 2,
      verifiedFacts: 1,
      verifiedOutcomes: 1,
      unresolvedCandidates: 0,
    });
    expect(() => validateReviewPostconditions(parsed, [
      postconditions[0], postconditions[1], postconditions[2], postconditions[3], postconditions[4],
      { success: true, results: [{ id: "rev_still_open" }] },
    ])).toThrow("remain unresolved");
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
  });

  it("accepts checksummed unverified community evidence and review-only label candidates", async () => {
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
    }))).resolves.toMatchObject({
      validatedStagedRecords: 1,
      contract: { expectedSource: "open_food_facts_robotoff", evidenceKind: "review_only" },
    });

    const rejectedDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-rejected-review-"));
    const rejectedReview = structuredClone(reviewProduct);
    rejectedReview.validationIssues = [{ code: "robotoff_unsupported_volume_basis", severity: "error", field: "nutrition" }];
    await writeAutomaticArtifact({ directory: rejectedDirectory, source: "open_food_facts_robotoff", product: rejectedReview });
    await expect(validateAutomaticPublicationSnapshot(rejectedDirectory, automaticInput({
      workflowName: "Extract label evidence with Robotoff",
      artifactName: "robotoff-label-candidates-123",
    }))).resolves.toMatchObject({ validatedStagedRecords: 1 });

    const emptyReviewDirectory = await mkdtemp(join(tmpdir(), "protein-index-auto-empty-review-"));
    const emptyReview = structuredClone(reviewProduct);
    emptyReview.validationIssues = [];
    await writeAutomaticArtifact({ directory: emptyReviewDirectory, source: "open_food_facts_robotoff", product: emptyReview });
    await expect(validateAutomaticPublicationSnapshot(emptyReviewDirectory, automaticInput({
      workflowName: "Extract label evidence with Robotoff",
      artifactName: "robotoff-label-candidates-123",
    }))).rejects.toThrow("no validation evidence");
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
    const newerCommunity = structuredClone(normalized);
    newerCommunity.nutrition.per100g.calories = 370;
    const automaticSql = await writeImport("open_food_facts", newerCommunity, "2026-07-16T13:00:00.000Z", "automatic", true);
    database.exec(automaticSql);
    expect(database.prepare("SELECT status, authority, calories FROM nutrition_facts").get()).toMatchObject({
      status: "verified",
      authority: 100,
      calories: 999,
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
      exactRunId: null,
      exactRunStatus: null,
      exactRunInputHash: null,
      exactRunSourceComplete: null,
      exactRunStagedRecords: null,
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
      exact_run_id: after.exactRunId,
      exact_run_status: after.exactRunStatus,
      exact_run_input_hash: after.exactRunInputHash,
      exact_run_source_complete: after.exactRunSourceComplete,
      exact_run_staged_records: after.exactRunStagedRecords,
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
    expect(workflow).toContain("validateAutomaticPublicationSnapshot");
    expect(workflow).toContain("applyEvidenceDecisions: !automatic");
    expect(workflow).toContain("Require protected publication credentials");
    expect(workflow).toContain("-z \"$CLOUDFLARE_API_TOKEN\"");
    expect(workflow).toContain("-z \"$CLOUDFLARE_ACCOUNT_ID\"");
    expect(workflow).toContain("artifact.digest");
    expect(workflow).toContain("artifact.size_in_bytes");
    expect(workflow).toContain("group: protein-index-production-publication");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("--automatic");
    expect(workflow).toContain("--skip-migrations");
    expect(workflow).not.toContain("migrations apply");
    expect(workflow).not.toContain("wrangler deploy");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("/api/health");
    expect(workflow).toContain("/api/products?scope=all");
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
    });
    expect(declaredLiquid.staged?.nutrition.basis).toBe("per_100ml");
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
    expect(converted.candidates[0]?.nutritionPer100g.fatGrams).toBeCloseTo(8.925, 6);
    const ambiguous = parseRobotoffNutritionEvidence(response, { ...context, servingSizeGrams: null });
    expect(ambiguous.candidates).toHaveLength(0);
    expect(ambiguous.issues.some(({ code }) => code === "robotoff_ambiguous_serving_basis")).toBe(true);
  });

  it("rejects legacy volume servings instead of treating millilitres as grams", async () => {
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
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [prediction(22, "20", {
        "energy-kcal_100g": nutrient(155, "kcal"),
        proteins_100g: nutrient(4.5, "g"),
      })] }), { status: 200 }),
    });
    expect(result.outcomes).toEqual({ candidate: 0, no_prediction: 0, rejected: 1, failed: 0 });
    const staged = JSON.parse((await readFile(result.stagedPath, "utf8")).trim()) as { validationIssues: Array<{ code: string }> };
    expect(staged.validationIssues).toContainEqual(expect.objectContaining({ code: "robotoff_unsupported_volume_basis" }));
    const sqlPath = join(directory, "robotoff-import.sql");
    await emitImportSql({ stagedPath: result.stagedPath, manifestPath: result.manifestPath, outputPath: sqlPath });
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("Superseded by corrected source evidence");
    expect(sql).toContain("json_extract(evidence_json, '$.code') = 'robotoff_nutrition_candidate'");
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

  it("does not assume grams for unitless sodium", () => {
    const response = { image_predictions: [prediction(21, "19", {
      "energy-kcal_100g": nutrient(316, "kcal"),
      proteins_100g: nutrient(52.9, "g"),
      sodium_100g: nutrient(11.1, ""),
    })] };
    const result = parseRobotoffNutritionEvidence(response, context);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.nutritionPer100g.sodiumMg).toBeNull();
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
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
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
    expect(report).toMatchObject({ requestedBarcodes: 1, accountedBarcodes: 1, fetchedBarcodes: 1, resumedBarcodes: 0 });

    const resumed = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
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
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [] }), { status: 200 }),
    });
    expect(result.outcomes).toEqual({ candidate: 0, no_prediction: 1, rejected: 0, failed: 0 });
    expect(await readFile(result.stagedPath, "utf8")).toBe("");
    const exclusion = JSON.parse((await readFile(result.exclusionsPath, "utf8")).trim()) as { status: string; reasons: string[] };
    expect(exclusion).toEqual(expect.objectContaining({ status: "no_prediction", reasons: ["no_nutrition_extraction_prediction"] }));
  });
});
