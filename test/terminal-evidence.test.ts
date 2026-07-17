import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalTerminalEvidenceDecision,
  compareTerminalEvidenceReplay,
  terminalEvidenceBindingsShareLineage,
  type TerminalEvidenceDecisionInput,
  type TerminalLabelEvidenceBinding,
  type TerminalSourceEvidenceBinding,
  validateTerminalEvidenceDecision,
  validateTerminalEvidenceSupersession,
} from "../shared/terminal-evidence";

const at = "2026-07-17T10:00:00.000Z";
const hash = (character: string): string => character.repeat(64);

async function databaseWithEvidence(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  const migrations = (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) database.exec(await readFile(join("migrations", migration), "utf8"));
  database.exec(`
    INSERT INTO sources
      (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
       retention_notes, created_at)
    VALUES ('source', 'Source', 'official', 100, 100, 100, 'terminal fixture', '${at}');
    INSERT INTO ingestion_runs
      (id, source_id, adapter_version, mode, input_identifier, input_hash, records_read,
       india_records, staged_records, invalid_records, duplicate_records,
       source_complete, market_complete, status, started_at, completed_at)
    VALUES ('run', 'source', 'fixture-v1', 'sample', 'fixture', '${hash("0")}', 1, 1, 1, 0, 0,
      1, 0, 'completed', '${at}', '${at}');
    INSERT INTO products
      (id, gtin, brand, brand_normalized, name, name_normalized, category,
       marketed_reasons_json, nutrition_reasons_json, classifier_version,
       completeness_missing_json, created_at, updated_at)
    VALUES ('product', '08900000000001', 'Brand', 'brand', 'Product', 'product', 'other',
      '[]', '[]', 'protein-v1', '[]', '${at}', '${at}');
    INSERT INTO source_records
      (id, source_id, source_record_id, product_id, content_hash, source_url, observed_at,
       first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
    VALUES ('record', 'source', 'record-key', 'product', '${hash("1")}',
      'https://example.com/product', '${at}', 'run', 'run', '{}', 'exact_gtin');
    INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id,
       field_family, source_image_id, requested_url, effective_url, content_sha256,
       byte_length, media_type, fetched_at)
    VALUES ('label', 'record', '${hash("1")}', 'product', 'nutrition', 'image-1',
      'https://example.com/label.jpg', 'https://example.com/label.jpg', '${hash("2")}',
      2048, 'image/jpeg', '${at}');
  `);
  return database;
}

function labelEvidence(): TerminalLabelEvidenceBinding {
  return {
    kind: "label",
    sourceId: "source",
    sourceRecordKey: "record-key",
    sourceRecordId: "record",
    sourceContentHash: hash("1"),
    productId: "product",
    fieldFamily: "nutrition",
    labelAssetId: "label",
    labelContentSha256: hash("2"),
  };
}

function sourceEvidence(): TerminalSourceEvidenceBinding {
  const { kind: _kind, labelAssetId: _asset, labelContentSha256: _hash, ...source } = labelEvidence();
  return { kind: "source", ...source };
}

function decision(overrides: Partial<TerminalEvidenceDecisionInput> = {}): TerminalEvidenceDecisionInput {
  return {
    id: "terminal-decision-one",
    idempotencyKey: "terminal:request:one",
    outcome: "not_declared",
    evidence: labelEvidence(),
    rationale: "The complete panel contains no nutrition declaration.",
    decidedBy: "local-reviewer",
    decidedAt: at,
    supersedesDecisionId: null,
    ...overrides,
  };
}

function insertDecision(database: DatabaseSync, input: TerminalEvidenceDecisionInput, orIgnore = false): void {
  const evidence = input.evidence;
  database.prepare(`INSERT ${orIgnore ? "OR IGNORE " : ""}INTO terminal_evidence_decisions
    (id, idempotency_key, source_id, source_record_key, source_record_id,
     source_content_hash, product_id, field_family, outcome, evidence_kind,
     label_asset_id, label_content_sha256, rationale, decided_by, decided_at,
     supersedes_decision_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.idempotencyKey,
      evidence.sourceId,
      evidence.sourceRecordKey,
      evidence.sourceRecordId,
      evidence.sourceContentHash,
      evidence.productId,
      evidence.fieldFamily,
      input.outcome,
      evidence.kind,
      evidence.kind === "label" ? evidence.labelAssetId : null,
      evidence.kind === "label" ? evidence.labelContentSha256 : null,
      input.rationale,
      input.decidedBy,
      input.decidedAt,
      input.supersedesDecisionId,
    );
}

describe("terminal evidence canonical contract", () => {
  it("validates exact source and label bindings without accepting loose evidence", () => {
    const valid = decision();
    expect(validateTerminalEvidenceDecision(valid)).toEqual([]);
    expect(validateTerminalEvidenceDecision(decision({
      id: "terminal-source-decision",
      idempotencyKey: "terminal:source:one",
      evidence: sourceEvidence(),
    }))).toEqual([]);
    expect(canonicalTerminalEvidenceDecision(valid)).toEqual(valid);
    expect(validateTerminalEvidenceDecision({
      ...valid,
      outcome: "missing",
      idempotencyKey: "short",
      evidence: {
        ...valid.evidence,
        sourceContentHash: "ABC",
        labelContentSha256: "not-a-hash",
        evidenceUrl: "https://unrecognized.invalid/proof",
      },
      rationale: " ",
      decidedAt: "today",
    })).toEqual(expect.arrayContaining([
      "idempotencyKey must be 8-200 URL-safe characters",
      "outcome is not supported",
      "evidence.evidenceUrl is not supported",
      "evidence.sourceContentHash must be a lowercase SHA-256 digest",
      "evidence.labelContentSha256 must be a lowercase SHA-256 digest",
      "rationale must be 3-2000 characters",
      "decidedAt must be a valid timestamp",
    ]));
  });

  it("classifies exact idempotent replay separately from collisions", () => {
    const existing = decision();
    expect(compareTerminalEvidenceReplay(
      decision({ id: "new-generated-id", decidedAt: "2026-07-17T10:01:00.000Z" }),
      existing,
    )).toBe("replay");
    expect(compareTerminalEvidenceReplay(decision({ outcome: "not_applicable" }), existing)).toBe("collision");
    expect(compareTerminalEvidenceReplay(decision({
      id: "other-id",
      idempotencyKey: "terminal:request:other",
    }), existing)).toBe("distinct");
  });

  it("requires exact same-lineage supersession and rejects competing corrections", () => {
    const previous = decision();
    const next = decision({
      id: "terminal-decision-two",
      idempotencyKey: "terminal:request:two",
      outcome: "not_applicable",
      supersedesDecisionId: previous.id,
    });
    expect(terminalEvidenceBindingsShareLineage(next.evidence, previous.evidence)).toBe(true);
    expect(validateTerminalEvidenceSupersession(next, previous)).toEqual([]);
    expect(validateTerminalEvidenceSupersession({
      ...next,
      evidence: { ...labelEvidence(), labelContentSha256: hash("3") },
    }, previous)).toContain("a superseding decision must use the same exact evidence lineage");
    expect(validateTerminalEvidenceSupersession({
      ...next,
      id: "competing",
      idempotencyKey: "terminal:request:competing",
    }, previous, next))
      .toContain("the previous decision already has a competing successor");
  });
});

describe("terminal evidence migration", () => {
  it("enforces exact current bindings, idempotent replay, supersession, and immutable history", async () => {
    const database = await databaseWithEvidence();
    const original = decision();
    insertDecision(database, original);

    insertDecision(database, decision({
      id: "retry-generated-id",
      decidedAt: "2026-07-17T10:01:00.000Z",
    }), true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM terminal_evidence_decisions").get())
      .toEqual({ count: 1 });
    expect(() => insertDecision(database, decision({ outcome: "not_applicable" }), true))
      .toThrow("replay collision");
    expect(() => insertDecision(database, decision({
      id: "implicit-correction",
      idempotencyKey: "terminal:request:implicit",
      outcome: "not_applicable",
    }))).toThrow("explicit supersession");

    const corrected = decision({
      id: "terminal-decision-two",
      idempotencyKey: "terminal:request:two",
      outcome: "not_applicable",
      supersedesDecisionId: original.id,
    });
    insertDecision(database, corrected);
    expect(database.prepare(`SELECT id, outcome, supersedes_decision_id
      FROM terminal_evidence_decisions ORDER BY decided_at, id`).all()).toEqual([
      { id: original.id, outcome: "not_declared", supersedes_decision_id: null },
      { id: corrected.id, outcome: "not_applicable", supersedes_decision_id: original.id },
    ]);
    expect(() => insertDecision(database, decision({
      id: "competing-correction",
      idempotencyKey: "terminal:request:competing",
      outcome: "not_declared",
      supersedesDecisionId: original.id,
    }))).toThrow("already superseded");
    expect(() => database.exec("UPDATE terminal_evidence_decisions SET rationale = 'changed' WHERE id = 'terminal-decision-one'"))
      .toThrow("immutable");
    expect(() => database.exec("DELETE FROM terminal_evidence_decisions WHERE id = 'terminal-decision-one'"))
      .toThrow("immutable");

    database.close();
  });

  it("stores source evidence without manufacturing label bindings and provides current-head indexes", async () => {
    const database = await databaseWithEvidence();
    insertDecision(database, decision({
      id: "terminal-source-decision",
      idempotencyKey: "terminal:source:one",
      outcome: "not_applicable",
      evidence: sourceEvidence(),
    }));
    expect(database.prepare(`SELECT evidence_kind, label_asset_id, label_content_sha256
      FROM terminal_evidence_decisions`).get()).toEqual({
      evidence_kind: "source",
      label_asset_id: null,
      label_content_sha256: null,
    });
    expect(database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'terminal_evidence_decisions'
        AND name LIKE 'idx_terminal_evidence_decisions_%'
      ORDER BY name`).all().map((row) => row.name)).toEqual([
      "idx_terminal_evidence_decisions_current",
      "idx_terminal_evidence_decisions_label_binding",
      "idx_terminal_evidence_decisions_source_binding",
    ]);
    database.close();
  });

  it("rejects malformed source and label evidence before preserving a row", async () => {
    const database = await databaseWithEvidence();
    expect(() => insertDecision(database, decision({
      evidence: { ...decision().evidence, sourceContentHash: hash("9") },
    }))).toThrow("source binding mismatch");
    expect(() => insertDecision(database, decision({
      id: "wrong-label",
      idempotencyKey: "terminal:request:wrong-label",
      evidence: { ...labelEvidence(), labelContentSha256: hash("9") },
    }))).toThrow("label binding mismatch");
    expect(database.prepare("SELECT COUNT(*) AS count FROM terminal_evidence_decisions").get())
      .toEqual({ count: 0 });
    database.close();
  });
});
