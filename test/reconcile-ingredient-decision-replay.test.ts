import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseRobotoffIngredientEvidence } from "../scripts/adapters/robotoff-ingredients";
import { buildFixtureStage } from "../scripts/fixtures";
import { emitImportSql } from "../scripts/reconcile";
import { ingredientCandidateHash, type IngredientCandidate } from "../shared/ingredient-evidence";
import { parseIngredients } from "../shared/ingredients";
import type { SourceManifest, StagedProduct } from "../shared/types";

const firstAt = "2026-07-17T10:00:00.000Z";
const changedAt = "2026-07-17T11:00:00.000Z";
const hash = (character: string): string => character.repeat(64);

interface CandidateFixture {
  candidate: IngredientCandidate;
  candidateHash: string;
  product: StagedProduct;
}

interface SourceBinding {
  id: string;
  product_id: string;
}

async function databaseWithMigrations(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
  return database;
}

async function candidateFixture(input: {
  contentHash: string;
  entityText?: string;
  exactLink?: { attemptId: string; assetId: string; labelHash: string };
}): Promise<CandidateFixture> {
  const directory = await mkdtemp(join(tmpdir(), "protein-index-ingredient-base-"));
  const { stagedPath } = await buildFixtureStage(directory);
  const [line] = (await readFile(stagedPath, "utf8")).trim().split("\n");
  if (!line) throw new Error("Expected a fixture product");
  const base = JSON.parse(line) as StagedProduct;
  if (!base.gtin) throw new Error("Expected a GTIN fixture");
  const imagePath = `/${base.gtin.slice(0, 3)}/${base.gtin.slice(3, 6)}/${base.gtin.slice(6, 9)}/${base.gtin.slice(9)}/2.jpg`;
  const parsed = parseRobotoffIngredientEvidence({
    image_predictions: [{
      id: 10477207,
      type: "ner",
      model_name: "ingredient_detection",
      model_version: "ingredient-detection-1.0",
      timestamp: firstAt,
      image: {
        barcode: base.gtin,
        uploaded_at: firstAt,
        image_id: "2",
        source_image: imagePath,
      },
      data: {
        entities: [{
          lang: { lang: "en", confidence: 0.99 },
          text: input.entityText ?? "Milk solids, cocoa, sugar",
          score: 0.99,
          ingredients: [
            { id: "en:milk", text: "Milk solids", in_taxonomy: true },
            { id: "en:cocoa", text: "Cocoa", in_taxonomy: true },
            { id: "en:sugar", text: "Sugar", in_taxonomy: true },
          ],
          bounding_box: [10, 20, 300, 400],
          ingredients_n: 3,
          known_ingredients_n: 3,
          unknown_ingredients_n: 0,
        }],
      },
    }],
  }, {
    code: base.gtin,
    ingredientImageUrl: new URL(imagePath.replace(/^\//, ""), "https://images.openfoodfacts.org/images/products/").toString(),
  });
  const candidate = parsed.candidates[0];
  if (!candidate) throw new Error("Expected an ingredient candidate");
  const candidateHash = await ingredientCandidateHash(candidate);
  const exactEvidence = input.exactLink ? {
    extractionAttemptId: input.exactLink.attemptId,
    labelAssetId: input.exactLink.assetId,
    labelContentSha256: input.exactLink.labelHash,
  } : {};
  const product: StagedProduct = {
    ...base,
    source: "open_food_facts_robotoff_ingredients",
    sourceKind: "open_data",
    sourceAuthority: { identity: 20, nutrition: 0, ingredients: 20 },
    sourceLicenseUrl: "https://world.openfoodfacts.org/terms-of-use",
    sourceRetentionNotes: "Open-data ingredient extraction fixture.",
    sourceRecordId: `${base.gtin}:${candidate.predictionId}:${candidate.entityIndex}`,
    sourceUrl: candidate.imageUrl,
    observedAt: candidate.observedAt,
    contentHash: input.contentHash,
    imageUrl: null,
    nutritionImageUrl: null,
    ingredientImageUrl: candidate.imageUrl,
    offers: [],
    ratings: [],
    nutrition: {
      ...base.nutrition,
      status: "missing",
      confidence: "low",
      labelVerifiedAt: null,
    },
    nutrients: [],
    ingredients: {
      ...base.ingredients,
      raw: null,
      normalized: [],
      allergens: [],
      additives: [],
      status: "missing",
      confidence: "low",
      source: "open_food_facts_robotoff_ingredients",
      observedAt: candidate.observedAt,
    },
    rawEvidence: { candidate, candidateHash, ...exactEvidence },
    validationIssues: [{
      code: "robotoff_ingredient_candidate",
      message: "Robotoff produced a review-only ingredient candidate.",
      severity: "warning",
      field: "ingredients",
      details: { candidate, candidateHash, ...exactEvidence },
    }],
  };
  return { candidate, candidateHash, product };
}

async function importSql(product: StagedProduct, at: string): Promise<{ runId: string; sql: string }> {
  const directory = await mkdtemp(join(tmpdir(), "protein-index-ingredient-replay-"));
  const stagedPath = join(directory, "staged-products.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const outputPath = join(directory, "import.sql");
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source: product.source,
    sourceKind: product.sourceKind,
    sourceAuthority: product.sourceAuthority,
    sourceLicenseUrl: product.sourceLicenseUrl,
    sourceRetentionNotes: product.sourceRetentionNotes,
    adapterVersion: "ingredient-supersession-test-v1",
    input: `fixture:${product.sourceRecordId}:${at}`,
    inputHash: createHash("sha256").update(`${product.contentHash}:${at}`).digest("hex"),
    inputBytes: 1,
    sourceUpdatedAt: at,
    startedAt: at,
    completedAt: at,
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
  await writeFile(stagedPath, `${JSON.stringify(product)}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const emitted = await emitImportSql({ stagedPath, manifestPath, outputPath });
  return { runId: emitted.runId, sql: await readFile(outputPath, "utf8") };
}

function sourceBinding(database: DatabaseSync, product: StagedProduct): SourceBinding {
  const binding = database.prepare(`SELECT id, product_id FROM source_records
    WHERE source_id = ? AND source_record_id = ?`).get(product.source, product.sourceRecordId) as SourceBinding | undefined;
  if (!binding) throw new Error("Expected an imported ingredient source record");
  return binding;
}

function insertVerifiedDecision(
  database: DatabaseSync,
  input: CandidateFixture,
  binding: SourceBinding,
  options: { id: string; attemptId?: string; assetId?: string; at?: string },
): void {
  const reviewedText = input.candidate.entityText;
  database.prepare(`INSERT INTO evidence_decisions
    (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
      candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
      decided_by, decided_at, active, extraction_attempt_id, label_asset_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ingredients', 'verify', ?, ?,
      'Reviewer confirmed the exact ingredient declaration', 'test_operator', ?, 1, ?, ?)`).run(
    options.id,
    input.product.source,
    input.product.sourceRecordId,
    binding.id,
    input.product.contentHash,
    binding.product_id,
    input.candidateHash,
    JSON.stringify({ candidate: input.candidate, reviewedText, normalizedIngredients: parseIngredients(reviewedText) }),
    input.candidate.imageUrl,
    options.at ?? firstAt,
    options.attemptId ?? null,
    options.assetId ?? null,
  );
}

function seedExactExtraction(
  database: DatabaseSync,
  input: CandidateFixture,
  binding: SourceBinding,
  runId: string,
  exactLink: { attemptId: string; assetId: string; labelHash: string },
): void {
  const ingestion = database.prepare("SELECT input_hash FROM ingestion_runs WHERE id = ?")
    .get(runId) as { input_hash: string } | undefined;
  if (!ingestion) throw new Error("Expected the current ingestion run");
  const extractionRunId = "xrn_ingredient_supersession";
  database.prepare(`INSERT INTO extraction_runs
    (id, ingestion_run_id, field_family, request_schema_hash, artifact_digest,
      adapter_version, model_name, model_version, parent_source_run_id,
      parent_source_input_hash, repository, workflow, branch, head_sha,
      source_complete, status, started_at, completed_at, accepted_at, manifest_json)
    VALUES (?, ?, 'ingredients', ?, ?, 'ingredient-supersession-test-v1',
      'ingredient_detection', 'ingredient-detection-1.0', ?, ?, 'test/protein-index',
      'ingredient-supersession-test', 'main', ?, 1, 'accepted', ?, ?, ?, '{}')`).run(
    extractionRunId,
    runId,
    hash("1"),
    hash("2"),
    runId,
    ingestion.input_hash,
    "3".repeat(40),
    changedAt,
    changedAt,
    changedAt,
  );
  database.prepare(`INSERT INTO label_evidence_assets
    (id, subject_source_record_id, subject_source_content_hash, product_id, field_family,
      source_image_id, requested_url, effective_url, content_sha256, byte_length,
      media_type, fetched_at)
    VALUES (?, ?, ?, ?, 'ingredients', ?, ?, ?, ?, 1024, 'image/jpeg', ?)`).run(
    exactLink.assetId,
    binding.id,
    input.product.contentHash,
    binding.product_id,
    input.candidate.imageId,
    input.candidate.imageUrl,
    input.candidate.imageUrl,
    exactLink.labelHash,
    changedAt,
  );
  database.prepare(`INSERT INTO extraction_attempts
    (id, extraction_run_id, subject_source_record_id, subject_source_record_key,
      subject_source_content_hash, product_id, field_family, response_evidence_hash,
      status, prediction_count, candidate_count, rejection_count, failure_count,
      conflict_count, reasons_json, attempted_at, is_current)
    VALUES (?, ?, ?, ?, ?, ?, 'ingredients', ?, 'candidate', 1, 1, 0, 0, 0, '[]', ?, 1)`).run(
    exactLink.attemptId,
    extractionRunId,
    binding.id,
    input.product.sourceRecordId,
    input.product.contentHash,
    binding.product_id,
    hash("4"),
    changedAt,
  );
  database.prepare(`INSERT INTO extraction_attempt_labels
    (id, attempt_id, label_asset_id, role, outcome, prediction_count, candidate_count,
      rejection_count, failure_count, conflict_count, candidate_hashes_json, reasons_json)
    VALUES ('xal_ingredient_supersession', ?, ?, 'requested', 'candidate', 1, 1, 0, 0, 0, ?, '[]')`).run(
    exactLink.attemptId,
    exactLink.assetId,
    JSON.stringify([input.candidateHash]),
  );
}

function projectionState(database: DatabaseSync, binding: SourceBinding): Record<string, unknown> {
  return database.prepare(`SELECT
    (SELECT status FROM ingredient_statements WHERE product_id = ?) AS status,
    (SELECT COUNT(*) FROM product_ingredients WHERE product_id = ? AND source_record_id = ?) AS ingredients,
    (SELECT COUNT(*) FROM field_observations WHERE product_id = ? AND source_record_id = ?
      AND field_path = 'ingredients.raw' AND selected = 1) AS selected,
    (SELECT COUNT(*) FROM evidence_outcomes WHERE product_id = ? AND field_family = 'ingredients') AS outcomes`)
    .get(binding.product_id, binding.product_id, binding.id, binding.product_id, binding.id, binding.product_id) as Record<string, unknown>;
}

describe("ingredient decision supersession through source replay", () => {
  it("invalidates before deactivation, admits one exact replacement, and replays idempotently", async () => {
    const database = await databaseWithMigrations();
    const initial = await candidateFixture({ contentHash: hash("a") });
    const initialImport = await importSql(initial.product, firstAt);
    database.exec(initialImport.sql);
    const binding = sourceBinding(database, initial.product);
    insertVerifiedDecision(database, initial, binding, { id: "evd_ingredient_predecessor" });

    database.exec(initialImport.sql);
    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_ingredient_predecessor'").get())
      .toEqual({ active: 1 });
    expect(projectionState(database, binding)).toEqual({ status: "verified", ingredients: 3, selected: 1, outcomes: 1 });

    database.exec(`CREATE TEMP TRIGGER ingredient_deactivation_requires_invalid_projection
      BEFORE UPDATE OF active ON evidence_decisions
      WHEN OLD.field_family = 'ingredients' AND OLD.active = 1 AND NEW.active = 0
      BEGIN
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM ingredient_statements
          WHERE product_id = OLD.product_id AND source_record_id = OLD.source_record_id AND status <> 'conflict'
        ) THEN RAISE(ABORT, 'ingredient statement was not invalidated before decision deactivation') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM product_ingredients
          WHERE product_id = OLD.product_id AND source_record_id = OLD.source_record_id
        ) THEN RAISE(ABORT, 'ingredient nodes were not invalidated before decision deactivation') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM field_observations
          WHERE product_id = OLD.product_id AND source_record_id = OLD.source_record_id
            AND field_path = 'ingredients.raw' AND selected = 1
        ) THEN RAISE(ABORT, 'ingredient observation was not invalidated before decision deactivation') END;
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM evidence_outcomes
          WHERE product_id = OLD.product_id AND field_family = 'ingredients'
        ) THEN RAISE(ABORT, 'ingredient outcome was not invalidated before decision deactivation') END;
      END;`);

    const exactLink = {
      attemptId: `xat_${"b".repeat(24)}`,
      assetId: `lbl_${"c".repeat(24)}`,
      labelHash: hash("d"),
    };
    const current = await candidateFixture({ contentHash: hash("e"), exactLink });
    const currentImport = await importSql(current.product, changedAt);
    database.exec(currentImport.sql);
    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_ingredient_predecessor'").get())
      .toEqual({ active: 0 });
    expect(projectionState(database, binding)).toEqual({ status: "conflict", ingredients: 0, selected: 0, outcomes: 0 });

    seedExactExtraction(database, current, binding, currentImport.runId, exactLink);
    insertVerifiedDecision(database, current, binding, {
      id: "evd_ingredient_exact_replacement",
      attemptId: exactLink.attemptId,
      assetId: exactLink.assetId,
      at: changedAt,
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM evidence_decisions
      WHERE source_id = ? AND source_record_key = ? AND candidate_hash = ?
        AND field_family = 'ingredients' AND active = 1`).get(
      current.product.source,
      current.product.sourceRecordId,
      current.candidateHash,
    )).toEqual({ count: 1 });

    database.exec(currentImport.sql);
    const afterFirstReplay = projectionState(database, binding);
    database.exec(currentImport.sql);
    expect(projectionState(database, binding)).toEqual(afterFirstReplay);
    expect(afterFirstReplay).toEqual({ status: "verified", ingredients: 3, selected: 1, outcomes: 1 });
    expect(database.prepare(`SELECT id, active, extraction_attempt_id, label_asset_id
      FROM evidence_decisions ORDER BY decided_at, id`).all()).toEqual([
      {
        id: "evd_ingredient_predecessor",
        active: 0,
        extraction_attempt_id: null,
        label_asset_id: null,
      },
      {
        id: "evd_ingredient_exact_replacement",
        active: 1,
        extraction_attempt_id: exactLink.attemptId,
        label_asset_id: exactLink.assetId,
      },
    ]);
  });

  it("deactivates a predecessor when only the ingredient candidate changes", async () => {
    const database = await databaseWithMigrations();
    const initial = await candidateFixture({ contentHash: hash("f") });
    const initialImport = await importSql(initial.product, firstAt);
    database.exec(initialImport.sql);
    const binding = sourceBinding(database, initial.product);
    insertVerifiedDecision(database, initial, binding, { id: "evd_ingredient_candidate_predecessor" });
    database.exec(initialImport.sql);

    const changed = await candidateFixture({
      contentHash: initial.product.contentHash,
      entityText: "Milk solids, cocoa, sugar, salt",
    });
    expect(changed.candidateHash).not.toBe(initial.candidateHash);
    database.exec((await importSql(changed.product, changedAt)).sql);

    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_ingredient_candidate_predecessor'").get())
      .toEqual({ active: 0 });
    expect(projectionState(database, binding)).toEqual({ status: "conflict", ingredients: 0, selected: 0, outcomes: 0 });
  });

  it("does not retain an unlinked legacy decision when the current candidate has exact label proof", async () => {
    const database = await databaseWithMigrations();
    const exactLink = {
      attemptId: `xat_${"e".repeat(24)}`,
      assetId: `lbl_${"f".repeat(24)}`,
      labelHash: hash("1"),
    };
    const current = await candidateFixture({ contentHash: hash("2"), exactLink });
    const imported = await importSql(current.product, firstAt);
    expect(imported.sql).toContain(`d.extraction_attempt_id = '${exactLink.attemptId}'`);
    database.exec(imported.sql);
    const binding = sourceBinding(database, current.product);
    insertVerifiedDecision(database, current, binding, { id: "evd_ingredient_unlinked_legacy" });
    seedExactExtraction(database, current, binding, imported.runId, exactLink);
    const deactivation = imported.sql.split("\n").find((statement) => statement.startsWith("UPDATE evidence_decisions AS d SET active = 0") && statement.includes("field_family = 'ingredients'"));
    if (!deactivation) throw new Error("Expected ingredient decision deactivation statement");
    expect(deactivation).toContain(`d.extraction_attempt_id = '${exactLink.attemptId}'`);
    database.exec(imported.sql);

    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_ingredient_unlinked_legacy'").get())
      .toEqual({ active: 0 });
    expect(projectionState(database, binding)).toEqual({ status: null, ingredients: 0, selected: 0, outcomes: 0 });
  });
});
