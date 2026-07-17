import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitGuardedSuccessorPublication, expectedVerifiedProductState, parseVerifiedProductState, verifiedProductStateQuery, writeExpectedVerifiedProductState } from "../scripts/guarded-publication";
import { writeReviewDecisionBundle } from "../scripts/review-bundles";
import { nutritionCandidateFromEvidence, nutritionCandidateHash, type EvidenceDecisionInput } from "../shared/evidence-decisions";
import { canonicalJson } from "../shared/evidence-decisions";

const productId = `prd_${"a".repeat(24)}`;
const sourceRecordId = `src_${"b".repeat(24)}`;

function productState(productIds: string[]): unknown {
  return [{ success: true, results: productIds.map((id) => ({ product_id: id })) }];
}

function sql(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE source_records (id TEXT PRIMARY KEY, source_id TEXT, source_record_id TEXT, content_hash TEXT, product_id TEXT);
    CREATE TABLE evidence_decisions (id TEXT PRIMARY KEY, source_id TEXT, source_record_key TEXT, source_record_id TEXT, source_content_hash TEXT, product_id TEXT, candidate_hash TEXT, field_family TEXT, decision TEXT, payload_json TEXT, evidence_url TEXT, rationale TEXT, decided_by TEXT, decided_at TEXT, active INTEGER, extraction_attempt_id TEXT, label_asset_id TEXT);
    CREATE TABLE nutrition_facts (product_id TEXT PRIMARY KEY, status TEXT, authority INTEGER);
    CREATE TABLE ingredient_statements (product_id TEXT PRIMARY KEY, status TEXT, authority INTEGER);
    CREATE TABLE review_items (status TEXT, evidence_json TEXT);`);
  return db;
}

async function decision(): Promise<EvidenceDecisionInput> {
  const candidate = nutritionCandidateFromEvidence({
    code: "robotoff_nutrition_candidate",
    details: { candidate: {
      predictionId: "prediction-1",
      barcode: "08900000000012",
      imageId: "2",
      imageUrl: "https://images.openfoodfacts.org/fixture.jpg",
      modelName: "nutrition_extractor",
      modelVersion: "nutrition_extractor-2.0",
      observedAt: "2026-07-18T00:00:00.000Z",
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
  if (!candidate) throw new Error("Expected nutrition fixture candidate");
  return {
    id: "evd_reattest_fixture",
    sourceId: "open_food_facts_robotoff",
    sourceRecordKey: "08900000000012:prediction-1",
    sourceRecordId,
    sourceContentHash: "d".repeat(64),
    productId,
    candidateHash: await nutritionCandidateHash(candidate),
    extractionAttemptId: `xat_${"e".repeat(24)}`,
    labelAssetId: `lbl_${"f".repeat(24)}`,
    fieldFamily: "nutrition",
    decision: "verify",
    payload: candidate,
    evidenceUrl: candidate.imageUrl,
    rationale: "Re-attested against the exact label.",
    decidedBy: "sarthak",
    decidedAt: "2026-07-18T00:00:00.000Z",
  };
}

describe("guarded successor publication", () => {
  it("parses an exact sorted verified-product state", () => {
    expect(verifiedProductStateQuery("nutrition")).toContain("FROM nutrition_facts");
    expect(verifiedProductStateQuery("ingredients")).toContain("FROM ingredient_statements");
    expect(parseVerifiedProductState("nutrition", productState([productId]))).toEqual({ fieldFamily: "nutrition", productIds: [productId] });
    expect(() => parseVerifiedProductState("nutrition", productState([productId, productId]))).toThrow(/sorted/);
  });

  it("emits fail-closed pre-state, source, immutable, candidate, and final-set guards", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-index-guarded-publication-"));
    const reviewed = await decision();
    const bundle = await writeReviewDecisionBundle({ decisions: [reviewed], outputRoot: root, createdAt: "2026-07-18T00:00:00.000Z" });
    const artifact = join(root, "artifact.sql");
    const successor = join(root, "successor.sql");
    const output = join(root, "guarded.sql");
    await writeFile(artifact, "UPDATE source_records SET observed_at = observed_at, content_hash = 'BEGIN is label text';\n", "utf8");
    await writeFile(successor, "UPDATE review_items SET status = status;\n", "utf8");
    const nutrition = parseVerifiedProductState("nutrition", productState([productId]));
    const ingredients = parseVerifiedProductState("ingredients", productState([`prd_${"1".repeat(24)}`]));
    await emitGuardedSuccessorPublication({
      fieldFamily: "nutrition",
      artifactSqlPath: artifact,
      successorSqlPath: successor,
      outputPath: output,
      successor: bundle,
      before: { nutrition, ingredients },
      expectedAfter: { nutrition, ingredients },
      expectedDecisionCount: 1,
      expectedVerifyCount: 1,
    });
    const sql = await readFile(output, "utf8");
    expect(sql).not.toContain("TEMP TABLE");
    expect(sql).toContain("json_extract('not valid JSON', '$')");
    expect(sql).toContain("pre_or_idempotent_state");
    expect(sql).toContain(`source_${reviewed.id}`);
    expect(sql).toContain(`decision_${reviewed.id}`);
    expect(sql).toContain(`candidate_${reviewed.id}`);
    expect(sql).toContain("final_nutrition_set");
    expect(sql).toContain("final_ingredient_set");
    expect(sql).toContain("unresolved_successor_candidates");
  });

  it("derives a portable exact final verified-product state from a family-pure successor bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-index-guarded-publication-final-state-"));
    const bundle = await writeReviewDecisionBundle({ decisions: [await decision()], outputRoot: root, createdAt: "2026-07-18T00:00:00.000Z" });
    expect(expectedVerifiedProductState(bundle, "nutrition")).toEqual({ fieldFamily: "nutrition", productIds: [productId] });
    const output = join(root, "final-state.json");
    await writeExpectedVerifiedProductState(bundle, "nutrition", output);
    await expect(readFile(output, "utf8")).resolves.toContain(productId);
  });

  it("rejects transaction-wrapped fragments and final-set/count mismatches before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-index-guarded-publication-invalid-"));
    const bundle = await writeReviewDecisionBundle({ decisions: [await decision()], outputRoot: root, createdAt: "2026-07-18T00:00:00.000Z" });
    const artifact = join(root, "artifact.sql");
    const successor = join(root, "successor.sql");
    const output = join(root, "guarded.sql");
    await writeFile(artifact, "BEGIN; SELECT 1; COMMIT;\n", "utf8");
    await writeFile(successor, "SELECT 1;\n", "utf8");
    const nutrition = parseVerifiedProductState("nutrition", productState([productId]));
    const ingredients = parseVerifiedProductState("ingredients", productState([`prd_${"1".repeat(24)}`]));
    await expect(emitGuardedSuccessorPublication({
      fieldFamily: "nutrition",
      artifactSqlPath: artifact,
      successorSqlPath: successor,
      outputPath: output,
      successor: bundle,
      before: { nutrition, ingredients },
      expectedAfter: { nutrition, ingredients },
      expectedDecisionCount: 1,
      expectedVerifyCount: 1,
    })).rejects.toThrow(/transaction-free/);
  });

  it("commits a clean composed release and rolls back a failing one when the caller uses a transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-index-guarded-publication-transaction-"));
    const reviewed = await decision();
    const bundle = await writeReviewDecisionBundle({ decisions: [reviewed], outputRoot: root, createdAt: "2026-07-18T00:00:00.000Z" });
    const nutrition = parseVerifiedProductState("nutrition", productState([productId]));
    const ingredients = parseVerifiedProductState("ingredients", productState([`prd_${"1".repeat(24)}`]));
    const artifact = join(root, "artifact.sql");
    const successor = join(root, "successor.sql");
    const output = join(root, "guarded.sql");
    const insertDecision = `INSERT INTO evidence_decisions (id, source_id, source_record_key, source_record_id, source_content_hash, product_id, candidate_hash, field_family, decision, payload_json, evidence_url, rationale, decided_by, decided_at, active, extraction_attempt_id, label_asset_id) VALUES (${sql(reviewed.id)}, ${sql(reviewed.sourceId)}, ${sql(reviewed.sourceRecordKey)}, ${sql(reviewed.sourceRecordId)}, ${sql(reviewed.sourceContentHash)}, ${sql(reviewed.productId)}, ${sql(reviewed.candidateHash)}, 'nutrition', 'verify', ${sql(canonicalJson(reviewed.payload))}, ${sql(reviewed.evidenceUrl)}, ${sql(reviewed.rationale)}, ${sql(reviewed.decidedBy)}, ${sql(reviewed.decidedAt)}, 1, ${sql(reviewed.extractionAttemptId ?? null)}, ${sql(reviewed.labelAssetId ?? null)});`;
    await writeFile(artifact, "UPDATE source_records SET content_hash = content_hash;\n", "utf8");
    await writeFile(successor, `${insertDecision}\n`, "utf8");
    await emitGuardedSuccessorPublication({
      fieldFamily: "nutrition",
      artifactSqlPath: artifact,
      successorSqlPath: successor,
      outputPath: output,
      successor: bundle,
      before: { nutrition, ingredients },
      expectedAfter: { nutrition, ingredients },
      expectedDecisionCount: 1,
      expectedVerifyCount: 1,
    });
    const db = database();
    db.prepare("INSERT INTO source_records VALUES (?, ?, ?, ?, ?)").run(sourceRecordId, reviewed.sourceId, reviewed.sourceRecordKey, reviewed.sourceContentHash, productId);
    db.prepare("INSERT INTO nutrition_facts VALUES (?, 'verified', 100)").run(productId);
    db.prepare("INSERT INTO ingredient_statements VALUES (?, 'verified', 100)").run(`prd_${"1".repeat(24)}`);
    db.exec(`BEGIN;\n${await readFile(output, "utf8")}\nCOMMIT;`);
    expect(db.prepare("SELECT id FROM evidence_decisions").all()).toEqual([{ id: reviewed.id }]);

    const failingArtifact = join(root, "failing-artifact.sql");
    const failingSuccessor = join(root, "failing-successor.sql");
    const failingOutput = join(root, "failing-guarded.sql");
    await writeFile(failingArtifact, `UPDATE source_records SET content_hash = ${sql("0".repeat(64))};\n`, "utf8");
    await writeFile(failingSuccessor, "UPDATE review_items SET status = status;\n", "utf8");
    await emitGuardedSuccessorPublication({
      fieldFamily: "nutrition",
      artifactSqlPath: failingArtifact,
      successorSqlPath: failingSuccessor,
      outputPath: failingOutput,
      successor: bundle,
      before: { nutrition, ingredients },
      expectedAfter: { nutrition, ingredients },
      expectedDecisionCount: 1,
      expectedVerifyCount: 1,
    });
    const failingDb = database();
    failingDb.prepare("INSERT INTO source_records VALUES (?, ?, ?, ?, ?)").run(sourceRecordId, reviewed.sourceId, reviewed.sourceRecordKey, reviewed.sourceContentHash, productId);
    failingDb.prepare("INSERT INTO nutrition_facts VALUES (?, 'verified', 100)").run(productId);
    failingDb.prepare("INSERT INTO ingredient_statements VALUES (?, 'verified', 100)").run(`prd_${"1".repeat(24)}`);
    try {
      failingDb.exec(`BEGIN;\n${await readFile(failingOutput, "utf8")}\nCOMMIT;`);
      throw new Error("Expected guarded publication to fail");
    } catch (error) {
      if ((error as Error).message === "Expected guarded publication to fail") throw error;
      failingDb.exec("ROLLBACK;");
    }
    expect(failingDb.prepare("SELECT content_hash FROM source_records WHERE id = ?").get(sourceRecordId))
      .toEqual({ content_hash: reviewed.sourceContentHash });
    expect(failingDb.prepare("SELECT COUNT(*) AS count FROM evidence_decisions").get()).toEqual({ count: 0 });
  });
});
