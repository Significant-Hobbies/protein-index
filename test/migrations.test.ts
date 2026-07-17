import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateExtractionAttempt,
  validateExtractionAttemptLabel,
  validateExtractionRun,
  validateLabelEvidenceAsset,
} from "../shared/extraction-outcomes";

const at = "2026-07-17T00:00:00.000Z";
const hash = (character: string): string => character.repeat(64);

async function applyAllMigrations(database: DatabaseSync): Promise<void> {
  const migrations = (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) database.exec(await readFile(join("migrations", migration), "utf8"));
}

function seedExtractionSubject(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO sources
      (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
       retention_notes, created_at)
    VALUES ('source', 'Source', 'fixture', 100, 100, 100, 'migration fixture', '${at}');
    INSERT INTO ingestion_runs
      (id, source_id, adapter_version, mode, input_identifier, input_hash, records_read,
       india_records, staged_records, invalid_records, duplicate_records,
       source_complete, market_complete, status, started_at, completed_at)
    VALUES
      ('parent-run', 'source', 'fixture-v1', 'sample', 'parent', '${hash("0")}', 1, 1, 1, 0, 0,
        1, 0, 'completed', '${at}', '${at}'),
      ('extract-run', 'source', 'robotoff-v8', 'sample', 'extract', '${hash("1")}', 1, 1, 1, 0, 0,
        1, 0, 'completed', '${at}', '${at}');
    INSERT INTO products
      (id, gtin, brand, brand_normalized, name, name_normalized, category,
       marketed_reasons_json, nutrition_reasons_json, classifier_version,
       completeness_missing_json, created_at, updated_at)
    VALUES ('product', '08900000000001', 'Brand', 'brand', 'Product', 'product', 'other',
      '[]', '[]', 'protein-v1', '[]', '${at}', '${at}');
    INSERT INTO source_records
      (id, source_id, source_record_id, product_id, content_hash, observed_at,
       first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
    VALUES ('record', 'source', 'record-key', 'product', '${hash("2")}', '${at}',
      'parent-run', 'parent-run', '{}', 'exact_gtin');
  `);
}

function seedAcceptedExtractionRun(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO extraction_runs
      (id, ingestion_run_id, field_family, request_schema_hash, artifact_digest,
       adapter_version, model_name, model_version, parent_source_run_id,
       parent_source_input_hash, repository, workflow, branch, head_sha,
       source_complete, status, started_at, completed_at, accepted_at, manifest_json)
    VALUES ('ledger-run', 'extract-run', 'nutrition', '${hash("3")}', '${hash("4")}',
      'robotoff-v8', 'nutrition_extractor', 'nutrition_extractor-2.0', 'parent-run',
      '${hash("0")}', 'owner/protein-index', 'extract-robotoff', 'main', '${"5".repeat(40)}',
      1, 'accepted', '${at}', '${at}', '${at}', '{}');
  `);
}

function seedLabelAsset(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id,
       field_family, source_image_id, source_image_revision, requested_url,
       effective_url, content_sha256, byte_length, media_type, fetched_at)
    VALUES ('asset', 'record', '${hash("2")}', 'product', 'nutrition', 'image-1', 'rev-1',
      'https://images.openfoodfacts.org/label.jpg',
      'https://images.openfoodfacts.org/label.jpg', '${hash("6")}', 4096, 'image/jpeg', '${at}');
  `);
}

function insertAttempt(database: DatabaseSync, input: {
  id: string;
  status?: "candidate" | "no_prediction" | "rejected" | "failed";
  isCurrent?: number;
}): void {
  const status = input.status ?? "candidate";
  const counts = status === "candidate"
    ? [1, 1, 0, 0]
    : status === "no_prediction"
      ? [0, 0, 0, 0]
      : status === "rejected"
        ? [1, 0, 1, 0]
        : [0, 0, 0, 1];
  database.prepare(`INSERT INTO extraction_attempts
    (id, extraction_run_id, subject_source_record_id, subject_source_record_key,
     subject_source_content_hash, product_id, field_family, response_evidence_hash,
     status, prediction_count, candidate_count, rejection_count, failure_count,
     conflict_count, reasons_json, attempted_at, is_current)
    VALUES (?, 'ledger-run', 'record', 'record-key', ?, 'product', 'nutrition', ?,
      ?, ?, ?, ?, ?, 0, '[]', ?, ?)`)
    .run(input.id, hash("2"), hash("7"), status, ...counts, at, input.isCurrent ?? 0);
}

describe("evidence decision migrations", () => {
  it("preserves legacy decisions and admits only redundant nutrition evidence", async () => {
    const database = new DatabaseSync(":memory:");
    const migrations = (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const migration of migrations.filter((name) => name < "0008_")) {
      database.exec(await readFile(join("migrations", migration), "utf8"));
    }

    const at = "2026-07-17T00:00:00.000Z";
    database.exec(`
      INSERT INTO sources
        (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
         retention_notes, created_at)
      VALUES ('source', 'Source', 'fixture', 100, 100, 100, 'migration fixture', '${at}');
      INSERT INTO ingestion_runs
        (id, source_id, adapter_version, mode, input_identifier, records_read,
         india_records, staged_records, invalid_records, duplicate_records,
         source_complete, market_complete, status, started_at, completed_at)
      VALUES ('run', 'source', 'fixture-v1', 'sample', 'fixture', 1, 1, 1, 0, 0,
        1, 0, 'completed', '${at}', '${at}');
      INSERT INTO products
        (id, gtin, brand, brand_normalized, name, name_normalized, category,
         marketed_reasons_json, nutrition_reasons_json, classifier_version,
         completeness_missing_json, created_at, updated_at)
      VALUES ('product', '08900000000001', 'Brand', 'brand', 'Product', 'product', 'other',
        '[]', '[]', 'protein-v1', '[]', '${at}', '${at}');
      INSERT INTO source_records
        (id, source_id, source_record_id, product_id, content_hash, observed_at,
         first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
      VALUES ('record', 'source', 'record-key', 'product', 'content-hash', '${at}',
        'run', 'run', '{}', 'exact_gtin');
      INSERT INTO evidence_decisions
        (id, source_id, source_record_key, source_record_id, source_content_hash,
         product_id, candidate_hash, field_family, decision, payload_json,
         evidence_url, rationale, decided_by, decided_at, active)
      VALUES ('legacy', 'source', 'record-key', 'record', 'content-hash', 'product',
        '${"a".repeat(64)}', 'nutrition', 'verify', '{}',
        'https://example.invalid/label.jpg', 'Legacy verified evidence', 'reviewer', '${at}', 1);
    `);

    database.exec(await readFile(join("migrations", "0008_redundant_evidence_decisions.sql"), "utf8"));

    expect(database.prepare("SELECT decision FROM evidence_decisions WHERE id = 'legacy'").get())
      .toEqual({ decision: "verify" });
    const indexes = database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'evidence_decisions' AND name LIKE 'idx_evidence_decisions_%'
      ORDER BY name`).all().map((row) => row.name);
    expect(indexes).toEqual([
      "idx_evidence_decisions_active_candidate",
      "idx_evidence_decisions_product",
      "idx_evidence_decisions_replay",
    ]);

    const insert = database.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash,
       product_id, candidate_hash, field_family, decision, payload_json,
       evidence_url, rationale, decided_by, decided_at, active)
      VALUES (?, 'source', ?, 'record', 'content-hash', 'product', ?, ?, ?, '{}',
        'https://example.invalid/label.jpg', 'Exact duplicate label evidence', 'reviewer', ?, 1)`);
    expect(() => insert.run("redundant", "redundant-key", "b".repeat(64), "nutrition", "redundant", at))
      .not.toThrow();
    expect(() => insert.run("ingredient-redundant", "ingredient-key", "c".repeat(64), "ingredients", "redundant", at))
      .toThrow();
    expect(() => insert.run("unsupported", "unsupported-key", "d".repeat(64), "nutrition", "approve", at))
      .toThrow();

    database.close();
  });
});

describe("extraction outcome contracts", () => {
  const run = {
    id: "ledger-run",
    ingestionRunId: "extract-run",
    fieldFamily: "nutrition",
    requestSchemaHash: hash("3"),
    artifactDigest: hash("4"),
    adapterVersion: "robotoff-v8",
    modelName: "nutrition_extractor",
    modelVersion: "nutrition_extractor-2.0",
    parentSourceRunId: "parent-run",
    parentSourceInputHash: hash("0"),
    repository: "owner/protein-index",
    workflow: "extract-robotoff",
    branch: "main",
    headSha: "5".repeat(40),
    sourceComplete: true,
    status: "accepted",
    startedAt: at,
    completedAt: at,
    acceptedAt: at,
    manifest: { schemaVersion: 1, files: ["labels.jsonl"] },
  } as const;
  const asset = {
    id: "asset",
    subjectSourceRecordId: "record",
    subjectSourceContentHash: hash("2"),
    productId: "product",
    fieldFamily: "nutrition",
    sourceImageId: "image-1",
    sourceImageRevision: "rev-1",
    requestedUrl: "https://images.openfoodfacts.org/label.jpg",
    effectiveUrl: "https://images.openfoodfacts.org/label.jpg",
    contentSha256: hash("6"),
    byteLength: 4096,
    mediaType: "image/jpeg",
    fetchedAt: at,
  } as const;
  const attempt = {
    id: "attempt",
    extractionRunId: "ledger-run",
    subjectSourceRecordId: "record",
    subjectSourceRecordKey: "record-key",
    subjectSourceContentHash: hash("2"),
    productId: "product",
    fieldFamily: "nutrition",
    responseEvidenceHash: hash("7"),
    status: "candidate",
    predictionCount: 1,
    candidateCount: 2,
    rejectionCount: 0,
    failureCount: 0,
    conflictCount: 1,
    reasons: [],
    attemptedAt: at,
    isCurrent: true,
  } as const;
  const attemptLabel = {
    id: "attempt-label",
    attemptId: "attempt",
    labelAssetId: "asset",
    role: "prediction",
    outcome: "candidate",
    predictionCount: 1,
    candidateCount: 2,
    rejectionCount: 0,
    failureCount: 0,
    conflictCount: 1,
    candidateHashes: [hash("8"), hash("9")],
    reasons: [],
  } as const;

  it("accepts complete strict records including multiple entity candidates per prediction", () => {
    expect(validateExtractionRun(run)).toEqual([]);
    expect(validateLabelEvidenceAsset(asset)).toEqual([]);
    expect(validateExtractionAttempt(attempt)).toEqual([]);
    expect(validateExtractionAttemptLabel(attemptLabel)).toEqual([]);
  });

  it("rejects unsafe URLs, malformed hashes, inconsistent counts, statuses, and JSON values", () => {
    expect(validateExtractionRun({ ...run, requestSchemaHash: "ABC", manifest: { invalid: Number.NaN } }))
      .toEqual(expect.arrayContaining([
        "requestSchemaHash must be a lowercase SHA-256 digest",
        "manifest must be a finite, acyclic JSON object",
      ]));
    expect(validateExtractionRun({ ...run, unexpected: true })).toContain("extractionRun.unexpected is not supported");
    expect(validateLabelEvidenceAsset({ ...asset, requestedUrl: "https://user:pass@example.com/label.jpg", byteLength: 0 }))
      .toEqual(expect.arrayContaining([
        "requestedUrl must use HTTPS without embedded credentials",
        "byteLength must be a positive safe integer",
      ]));
    expect(validateExtractionAttempt({
      ...attempt,
      status: "no_prediction",
      candidateCount: 1,
      reasons: "[]",
    })).toEqual(expect.arrayContaining([
      "no_prediction outcomes require zero prediction, candidate, rejection, and failure counts",
      "reasons must be a JSON array of reason codes",
    ]));
    expect(validateExtractionAttemptLabel({
      ...attemptLabel,
      role: "prediction",
      outcome: "no_prediction",
      predictionCount: 0,
      candidateCount: 0,
      conflictCount: 0,
      candidateHashes: [],
    })).toContain("prediction labels cannot have no_prediction outcomes");
    expect(validateExtractionAttemptLabel({ ...attemptLabel, candidateHashes: [hash("8"), hash("8")] }))
      .toContain("candidateHashes must not contain duplicates");
  });
});

describe("extraction outcome migration", () => {
  it("enforces immutable source/hash bindings, strict constraints, and one current attempt", async () => {
    const database = new DatabaseSync(":memory:");
    await applyAllMigrations(database);
    seedExtractionSubject(database);
    expect(() => database.exec(`INSERT INTO extraction_runs
      (id, ingestion_run_id, field_family, request_schema_hash, artifact_digest,
       adapter_version, model_name, model_version, parent_source_run_id,
       parent_source_input_hash, repository, workflow, branch, head_sha,
       source_complete, status, started_at, completed_at, accepted_at, manifest_json)
      VALUES ('bad-lineage', 'extract-run', 'nutrition', '${hash("3")}', '${hash("4")}',
        'fixture-v1', 'nutrition_extractor', 'nutrition_extractor-2.0', 'parent-run',
        '${hash("f")}', 'owner/protein-index', 'extract-robotoff', 'main', '${"5".repeat(40)}',
        1, 'accepted', '${at}', '${at}', '${at}', '{}')`))
      .toThrow("parent source lineage mismatch");
    seedAcceptedExtractionRun(database);
    seedLabelAsset(database);

    expect(() => database.exec(`INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id, field_family,
       source_image_id, requested_url, effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES ('bad-asset', 'record', '${hash("f")}', 'product', 'nutrition', 'image-2',
        'http://example.com/label.jpg', 'https://example.com/label.jpg', '${hash("a")}', 10, 'image/jpeg', '${at}')`))
      .toThrow();

    insertAttempt(database, { id: "attempt-1", isCurrent: 1 });
    expect(() => insertAttempt(database, { id: "attempt-2", isCurrent: 1 })).toThrow();
    database.exec("UPDATE extraction_attempts SET is_current = 0 WHERE id = 'attempt-1'");
    insertAttempt(database, { id: "attempt-2", isCurrent: 1 });
    expect(database.prepare("SELECT id, is_current FROM extraction_attempts ORDER BY id").all()).toEqual([
      { id: "attempt-1", is_current: 0 },
      { id: "attempt-2", is_current: 1 },
    ]);

    expect(() => database.exec("UPDATE extraction_attempts SET status = 'rejected' WHERE id = 'attempt-1'"))
      .toThrow("immutable except for current state");
    expect(() => database.exec("DELETE FROM extraction_attempts WHERE id = 'attempt-1'"))
      .toThrow("extraction attempts are immutable");
    expect(() => database.exec("DELETE FROM label_evidence_assets WHERE id = 'asset'"))
      .toThrow("label evidence assets are immutable");
    expect(() => database.exec("UPDATE extraction_runs SET workflow = 'other' WHERE id = 'ledger-run'"))
      .toThrow("extraction runs are immutable");

    expect(() => database.exec(`INSERT INTO extraction_attempts
      (id, extraction_run_id, subject_source_record_id, subject_source_record_key,
       subject_source_content_hash, product_id, field_family, response_evidence_hash,
       status, prediction_count, candidate_count, rejection_count, failure_count,
       conflict_count, reasons_json, attempted_at, is_current)
      VALUES ('bad-json', 'ledger-run', 'record', 'record-key', '${hash("2")}', 'product',
        'nutrition', '${hash("7")}', 'candidate', 1, 2, 0, 0, 0, '{}', '${at}', 0)`))
      .toThrow();

    database.close();
  });

  it("retains historical label assets when the subject source content changes", async () => {
    const database = new DatabaseSync(":memory:");
    await applyAllMigrations(database);
    seedExtractionSubject(database);
    seedAcceptedExtractionRun(database);
    seedLabelAsset(database);

    database.exec(`
      UPDATE source_records
      SET content_hash = '${hash("e")}'
      WHERE id = 'record';
      INSERT INTO label_evidence_assets
        (id, subject_source_record_id, subject_source_content_hash, product_id,
         field_family, source_image_id, source_image_revision, requested_url,
         effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES ('asset-v2', 'record', '${hash("e")}', 'product', 'nutrition', 'image-1', 'rev-1',
        'https://images.openfoodfacts.org/label.jpg',
        'https://images.openfoodfacts.org/label.jpg', '${hash("6")}', 4096, 'image/jpeg', '${at}');
    `);

    expect(database.prepare(`SELECT id, subject_source_content_hash
      FROM label_evidence_assets ORDER BY id`).all()).toEqual([
      { id: "asset", subject_source_content_hash: hash("2") },
      { id: "asset-v2", subject_source_content_hash: hash("e") },
    ]);

    database.close();
  });

  it("retains per-label outcomes without promoting terminal evidence and enforces exact decision links", async () => {
    const database = new DatabaseSync(":memory:");
    await applyAllMigrations(database);
    seedExtractionSubject(database);
    seedAcceptedExtractionRun(database);
    seedLabelAsset(database);
    insertAttempt(database, { id: "candidate-attempt", isCurrent: 1 });
    insertAttempt(database, { id: "no-prediction-attempt", status: "no_prediction" });
    insertAttempt(database, { id: "rejected-attempt", status: "rejected" });
    insertAttempt(database, { id: "failed-attempt", status: "failed" });

    database.exec(`
      INSERT INTO extraction_attempt_labels
        (id, attempt_id, label_asset_id, role, outcome, prediction_count, candidate_count,
         rejection_count, failure_count, conflict_count, candidate_hashes_json, reasons_json)
      VALUES ('candidate-label', 'candidate-attempt', 'asset', 'prediction', 'candidate',
        1, 2, 0, 0, 0, '["${hash("a")}","${hash("b")}"]', '[]');
      INSERT INTO source_records
        (id, source_id, source_record_id, product_id, content_hash, observed_at,
         first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
      VALUES ('candidate-record', 'source', 'candidate-key', 'product', '${hash("c")}', '${at}',
        'extract-run', 'extract-run',
        '{"extractionAttemptId":"candidate-attempt","labelAssetId":"asset","labelContentSha256":"${hash("6")}","candidateHash":"${hash("a")}"}',
        'exact_gtin');
    `);

    const exactDecision = database.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash,
       product_id, candidate_hash, field_family, decision, payload_json,
       evidence_url, rationale, decided_by, decided_at, active,
       extraction_attempt_id, label_asset_id)
      VALUES (?, 'source', ?, 'candidate-record', '${hash("c")}', 'product', ?,
        'nutrition', 'reject', '{}', 'https://images.openfoodfacts.org/label.jpg',
        'Exact label rejection', 'reviewer', '${at}', 1, ?, ?)`);
    expect(() => exactDecision.run("exact-decision", "candidate-key", hash("a"), "candidate-attempt", "asset"))
      .not.toThrow();
    expect(() => exactDecision.run("partial-link", "partial-key", hash("a"), "candidate-attempt", null))
      .toThrow("extraction linkage must be complete");
    expect(() => exactDecision.run("wrong-source-key", "not-candidate-key", hash("a"), "candidate-attempt", "asset"))
      .toThrow("extraction linkage mismatch");
    expect(() => exactDecision.run("wrong-candidate", "wrong-key", hash("d"), "candidate-attempt", "asset"))
      .toThrow("extraction linkage mismatch");

    expect(() => database.exec("INSERT OR IGNORE INTO extraction_runs SELECT * FROM extraction_runs WHERE id = 'ledger-run'"))
      .not.toThrow();
    expect(() => database.exec(`INSERT OR IGNORE INTO extraction_runs
      SELECT id, ingestion_run_id, field_family, request_schema_hash, artifact_digest,
        adapter_version, model_name, model_version, parent_source_run_id,
        parent_source_input_hash, repository, 'drifted-workflow', branch, head_sha,
        source_complete, status, started_at, completed_at, accepted_at, manifest_json
      FROM extraction_runs WHERE id = 'ledger-run'`)).toThrow("extraction run replay collision");
    expect(() => database.exec("INSERT OR IGNORE INTO extraction_attempts SELECT * FROM extraction_attempts WHERE id = 'candidate-attempt'"))
      .not.toThrow();
    expect(() => database.exec(`INSERT OR IGNORE INTO extraction_attempts
      SELECT id, extraction_run_id, subject_source_record_id, subject_source_record_key,
        subject_source_content_hash, product_id, field_family, '${hash("8")}', status,
        prediction_count, candidate_count, rejection_count, failure_count, conflict_count,
        reasons_json, attempted_at, is_current
      FROM extraction_attempts WHERE id = 'candidate-attempt'`)).toThrow("extraction attempt replay collision");

    database.exec("UPDATE extraction_attempts SET is_current = 0 WHERE id = 'candidate-attempt'");
    database.exec("UPDATE source_records SET raw_evidence_json = '{}' WHERE id = 'candidate-record'");
    expect(() => database.exec("UPDATE evidence_decisions SET active = 0 WHERE id = 'exact-decision'"))
      .not.toThrow();
    expect(() => database.exec("UPDATE evidence_decisions SET active = 1 WHERE id = 'exact-decision'"))
      .toThrow("extraction linkage mismatch");
    expect(() => database.exec("UPDATE evidence_decisions SET extraction_attempt_id = NULL, label_asset_id = NULL WHERE id = 'exact-decision'"))
      .toThrow("extraction linkage is immutable");
    expect(() => exactDecision.run("stale-link", "stale-key", hash("a"), "candidate-attempt", "asset"))
      .toThrow("extraction linkage mismatch");

    expect(database.prepare("SELECT COUNT(*) AS count FROM extraction_attempts").get()).toEqual({ count: 4 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM evidence_outcomes").get()).toEqual({ count: 0 });
    expect(() => database.exec(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, evidence_url, observed_at, verified_at, decided_by, notes)
      VALUES ('product', 'nutrition', 'no_prediction', 'https://example.com/label.jpg',
        '${at}', '${at}', 'extractor', 'Automated outcome')`)).toThrow();

    database.close();
  });
});
