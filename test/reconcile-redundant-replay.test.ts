import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseRobotoffNutritionEvidence, type RobotoffProductContext } from "../scripts/adapters/robotoff";
import { emitImportSql } from "../scripts/reconcile";
import { canonicalJson, canonicalNutritionCandidate, nutritionCandidateHash, nutritionCandidateValues } from "../shared/evidence-decisions";
import type { SourceManifest, StagedProduct } from "../shared/types";

const timestamp = "2026-07-17T10:00:00.000Z";
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
  nutritionImageUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/nutrition.jpg",
};

function candidateProduct(): StagedProduct {
  const result = parseRobotoffNutritionEvidence({
    image_predictions: [{
      id: 17,
      type: "nutrition_extraction",
      model_name: "nutrition_extractor",
      model_version: "nutrition_extractor-2.0",
      timestamp,
      image: {
        image_id: "17",
        source_image: "/890/000/000/0012/17.jpg",
        uploaded_at: timestamp,
      },
      data: {
        nutrients: {
          "energy-kcal_100g": { value: "365", unit: "kcal", score: 0.98 },
          proteins_100g: { value: "24", unit: "g", score: 0.98 },
          carbohydrates_100g: { value: "46.5", unit: "g", score: 0.98 },
          sugars_100g: { value: "4", unit: "g", score: 0.98 },
          fat_100g: { value: "8.9", unit: "g", score: 0.98 },
          "saturated-fat_100g": { value: "2", unit: "g", score: 0.98 },
          fiber_100g: { value: "5", unit: "g", score: 0.98 },
          sodium_100g: { value: "250", unit: "mg", score: 0.98 },
        },
      },
    }],
  }, context);
  const product = result.staged[0];
  if (!product) throw new Error("Expected a Robotoff candidate fixture");
  return product;
}

async function databaseWithMigrations(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
  return database;
}

async function importSql(product: StagedProduct, completedAt = timestamp): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "protein-index-redundant-replay-"));
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
    adapterVersion: "redundant-replay-test",
    input: "fixture",
    inputHash: createHash("sha256").update(product.contentHash).digest("hex"),
    inputBytes: 1,
    sourceUpdatedAt: completedAt,
    startedAt: completedAt,
    completedAt,
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
  await emitImportSql({ stagedPath, manifestPath, outputPath });
  return readFile(outputPath, "utf8");
}

interface SeededDecision {
  candidateHash: string;
  productId: string;
  reviewId: string;
  sourceRecordId: string;
}

async function seedResolvedRedundantDecision(database: DatabaseSync, product: StagedProduct, sql: string): Promise<SeededDecision> {
  database.exec(sql);
  const issue = product.validationIssues.find(({ code }) => code === "robotoff_nutrition_candidate");
  const candidate = issue?.details?.candidate;
  if (!candidate || typeof candidate !== "object") throw new Error("Expected candidate evidence");
  const canonicalCandidate = canonicalNutritionCandidate(candidate as Parameters<typeof canonicalNutritionCandidate>[0]);
  const candidateHash = await nutritionCandidateHash(canonicalCandidate);
  const source = database.prepare("SELECT id, product_id FROM source_records WHERE source_id = ? AND source_record_id = ?")
    .get(product.source, product.sourceRecordId) as { id: string; product_id: string } | undefined;
  if (!source) throw new Error("Expected an imported source record");
  const review = database.prepare("SELECT id FROM review_items WHERE source_record_id = ? AND json_extract(evidence_json, '$.details.candidateHash') = ?")
    .get(source.id, candidateHash) as { id: string } | undefined;
  const run = database.prepare("SELECT id FROM ingestion_runs ORDER BY started_at DESC LIMIT 1").get() as { id: string } | undefined;
  if (!review || !run) throw new Error("Expected imported product, run, and review");

  database.prepare(`INSERT INTO source_records
    (id, source_id, source_record_id, product_id, source_url, content_hash, observed_at,
      first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule, identity_hash)
    VALUES (?, ?, 'selected-label', ?, ?, 'selected-content', ?, ?, ?, '{}', 'manual_verify', 'selected-identity')`)
    .run("src_selected_redundant_replay", product.source, source.product_id, canonicalCandidate.imageUrl, timestamp, run.id, run.id);
  const nutrition = nutritionCandidateValues(canonicalCandidate);
  database.prepare(`INSERT INTO nutrition_facts
    (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
      calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams,
      saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
    VALUES (?, 'src_selected_redundant_replay', 'verified', 'high', 100, 'per_100g', 'as_sold',
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(source.product_id, nutrition.calories, nutrition.proteinGrams, nutrition.carbohydrateGrams,
      nutrition.sugarGrams, nutrition.fatGrams, nutrition.saturatedFatGrams, nutrition.fibreGrams,
      nutrition.sodiumMg, timestamp, timestamp, timestamp);
  database.prepare(`INSERT INTO evidence_decisions
    (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
      candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
      decided_by, decided_at, active)
    VALUES ('evd_redundant_replay', ?, ?, ?, ?, ?, ?, 'nutrition', 'redundant', ?, ?,
      'Additional label exactly matches selected nutrition', 'test_operator', ?, 1)`)
    .run(product.source, product.sourceRecordId, source.id, product.contentHash, source.product_id,
      candidateHash, canonicalJson(canonicalCandidate), canonicalCandidate.imageUrl, timestamp);
  database.prepare(`UPDATE review_items SET status = 'resolved', decision = 'redundant_nutrition',
    decision_rationale = 'Additional label exactly matches selected nutrition',
    decision_evidence_url = ?, decided_by = 'test_operator', resolved_at = ? WHERE id = ?`)
    .run(canonicalCandidate.imageUrl, timestamp, review.id);
  return { candidateHash, productId: source.product_id, reviewId: review.id, sourceRecordId: source.id };
}

describe("redundant evidence reconciliation replay", () => {
  it("keeps unchanged redundant evidence terminal and reopens the same review after projection drift", async () => {
    const database = await databaseWithMigrations();
    const product = candidateProduct();
    const sql = await importSql(product);
    const seeded = await seedResolvedRedundantDecision(database, product, sql);

    database.exec(sql);
    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_redundant_replay'").get()).toEqual({ active: 1 });
    expect(database.prepare("SELECT status, decision FROM review_items WHERE id = ?").get(seeded.reviewId))
      .toEqual({ status: "resolved", decision: "redundant_nutrition" });

    database.prepare("UPDATE nutrition_facts SET protein_grams = protein_grams + 1 WHERE product_id = ?").run(seeded.productId);
    database.exec(sql);
    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_redundant_replay'").get()).toEqual({ active: 0 });
    expect(database.prepare(`SELECT status, decision, decision_rationale, decision_evidence_url,
      decided_by, resolved_at FROM review_items WHERE id = ?`).get(seeded.reviewId)).toEqual({
      status: "open",
      decision: null,
      decision_rationale: null,
      decision_evidence_url: null,
      decided_by: null,
      resolved_at: null,
    });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM review_items
      WHERE json_extract(evidence_json, '$.code') = 'robotoff_nutrition_candidate'`).get()).toEqual({ count: 1 });
  });

  it("rebinds the reopened deterministic review to the current canonical product", async () => {
    const database = await databaseWithMigrations();
    const product = candidateProduct();
    const sql = await importSql(product);
    const seeded = await seedResolvedRedundantDecision(database, product, sql);
    const source = database.prepare("SELECT identity_hash FROM source_records WHERE id = ?").get(seeded.sourceRecordId) as { identity_hash: string };

    database.prepare("UPDATE products SET gtin = NULL WHERE id = ?").run(seeded.productId);
    database.prepare(`INSERT INTO products
      (id, gtin, brand, brand_normalized, name, name_normalized, category, marketed_reasons_json,
        nutrition_reasons_json, classifier_version, completeness, completeness_missing_json,
        identity_authority, created_at, updated_at)
      SELECT 'prd_rebound', ?, brand, brand_normalized, name, name_normalized, category,
        marketed_reasons_json, nutrition_reasons_json, classifier_version, completeness,
        completeness_missing_json, identity_authority, created_at, updated_at
      FROM products WHERE id = ?`)
      .run(product.gtin, seeded.productId);
    database.prepare(`INSERT INTO source_records
      (id, source_id, source_record_id, product_id, source_url, content_hash, observed_at,
        first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule, identity_hash)
      SELECT 'src_selected_rebound', source_id, 'selected-label-rebound', 'prd_rebound', source_url,
        'selected-rebound-content', observed_at, first_seen_run_id, last_seen_run_id, '{}',
        'manual_verify', 'selected-rebound-identity'
      FROM source_records WHERE id = 'src_selected_redundant_replay'`).run();
    database.prepare(`INSERT INTO nutrition_facts
      (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
        calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
        fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
      SELECT 'prd_rebound', 'src_selected_rebound', status, confidence, authority, basis,
        preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams,
        saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at
      FROM nutrition_facts WHERE product_id = ?`).run(seeded.productId);
    database.prepare(`INSERT INTO identity_decisions
      (id, source_id, source_record_key, source_record_id, identity_hash, decision,
        target_product_id, rationale, decided_by, decided_at, active)
      VALUES ('identity_rebound', ?, ?, ?, ?, 'match', 'prd_rebound',
        'Rebound after identity review', 'test_operator', ?, 1)`)
      .run(product.source, product.sourceRecordId, seeded.sourceRecordId, source.identity_hash, timestamp);

    database.exec(sql);
    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_redundant_replay'").get()).toEqual({ active: 0 });
    expect(database.prepare("SELECT status, decision, product_id FROM review_items WHERE id = ?").get(seeded.reviewId))
      .toEqual({ status: "open", decision: null, product_id: "prd_rebound" });
    expect(database.prepare("SELECT product_id FROM source_records WHERE id = ?").get(seeded.sourceRecordId))
      .toEqual({ product_id: "prd_rebound" });
  });

  it("supersedes stale redundant decisions on source-content drift and permits a fresh decision", async () => {
    const database = await databaseWithMigrations();
    const product = candidateProduct();
    const firstSql = await importSql(product);
    const seeded = await seedResolvedRedundantDecision(database, product, firstSql);
    const changed = structuredClone(product);
    changed.contentHash = "f".repeat(64);
    const changedSql = await importSql(changed, "2026-07-17T11:00:00.000Z");

    database.exec(changedSql);
    expect(database.prepare("SELECT active FROM evidence_decisions WHERE id = 'evd_redundant_replay'").get()).toEqual({ active: 0 });
    const open = database.prepare(`SELECT id, product_id FROM review_items
      WHERE status = 'open' AND source_record_id = ? AND json_extract(evidence_json, '$.details.candidateHash') = ?`)
      .get(seeded.sourceRecordId, seeded.candidateHash) as { id: string; product_id: string } | undefined;
    expect(open?.id).toBeTruthy();
    expect(open?.id).not.toBe(seeded.reviewId);
    expect(database.prepare(`SELECT COUNT(*) AS count FROM review_items
      WHERE json_extract(evidence_json, '$.code') = 'robotoff_nutrition_candidate'`).get()).toEqual({ count: 2 });

    database.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      SELECT 'evd_redecided_after_drift', source_id, source_record_key, source_record_id, ?,
        product_id, candidate_hash, field_family, 'reject', payload_json, evidence_url,
        'Fresh review rejects changed source evidence', 'test_operator', ?, 1
      FROM evidence_decisions WHERE id = 'evd_redundant_replay'`)
      .run(changed.contentHash, "2026-07-17T11:30:00.000Z");
    expect(database.prepare("SELECT decision, active FROM evidence_decisions WHERE id = 'evd_redecided_after_drift'").get())
      .toEqual({ decision: "reject", active: 1 });
  });

  it.each(["verify", "reject"] as const)("deactivates drifted legacy %s decisions and permits exact re-review", async (decision) => {
    const database = await databaseWithMigrations();
    const product = candidateProduct();
    const firstSql = await importSql(product);
    await seedResolvedRedundantDecision(database, product, firstSql);
    database.prepare("UPDATE evidence_decisions SET decision = ? WHERE id = 'evd_redundant_replay'").run(decision);
    const changed = structuredClone(product);
    changed.contentHash = "e".repeat(64);
    database.exec(await importSql(changed, "2026-07-17T12:00:00.000Z"));
    expect(database.prepare("SELECT decision, active FROM evidence_decisions WHERE id = 'evd_redundant_replay'").get())
      .toEqual({ decision, active: 0 });
    database.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      SELECT ?, source_id, source_record_key, source_record_id, ?, product_id, candidate_hash,
        field_family, ?, payload_json, evidence_url, 'Exact re-review after source drift',
        'test_operator', '2026-07-17T12:30:00.000Z', 1
      FROM evidence_decisions WHERE id = 'evd_redundant_replay'`)
      .run(`evd_redecided_${decision}`, changed.contentHash, decision);
    expect(database.prepare("SELECT decision, active FROM evidence_decisions WHERE id = ?").get(`evd_redecided_${decision}`))
      .toEqual({ decision, active: 1 });
  });
});
