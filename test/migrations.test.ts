import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
