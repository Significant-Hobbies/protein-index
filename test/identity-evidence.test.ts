import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalIdentityEvidenceDecision,
  identityEvidenceBindingMatches,
  identityEvidenceDecisionDisposition,
  identityEvidenceDecisionId,
  validateIdentityEvidenceDecision,
  type IdentityEvidenceDecision,
  type IdentityEvidenceDecisionPayload,
} from "../shared/identity-evidence";

const at = "2026-07-17T00:00:00.000Z";
const identityHash = "a".repeat(64);

const payload: IdentityEvidenceDecisionPayload = {
  productId: "product",
  sourceId: "source",
  sourceRecordKey: "record-key",
  sourceRecordId: "record",
  identityHash,
  evidenceUrl: "https://example.invalid/source",
  sourceObservedAt: at,
  rationale: "The exact package label confirms this product identity.",
  decidedBy: "local_operator",
};

async function decision(overrides: Partial<IdentityEvidenceDecision> = {}): Promise<IdentityEvidenceDecision> {
  return {
    id: await identityEvidenceDecisionId(payload),
    ...payload,
    decidedAt: "2026-07-17T00:05:00.000Z",
    ...overrides,
  };
}

async function applyAllMigrations(database: DatabaseSync): Promise<void> {
  const migrations = (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const migration of migrations) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
}

async function applyMigrationsThrough(database: DatabaseSync, lastMigration: string): Promise<void> {
  const migrations = (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql") && name <= lastMigration)
    .sort();
  for (const migration of migrations) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
}

async function seedCurrentBinding(database: DatabaseSync): Promise<void> {
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
      (id, source_id, source_record_id, product_id, content_hash, identity_hash,
       source_url, observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
    VALUES ('record', 'source', 'record-key', 'product', '${"b".repeat(64)}',
      '${identityHash}', '${payload.evidenceUrl}', '${at}', 'run', 'run', '{}', 'exact_gtin');
    INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id,
       field_family, source_image_id, source_image_revision, requested_url,
       effective_url, content_sha256, byte_length, media_type, fetched_at)
    VALUES ('identity-label', 'record', '${"b".repeat(64)}', 'product',
      'nutrition', 'identity-panel', '1',
      'https://example.invalid/a-different-label.jpg',
      'https://example.invalid/a-different-label.jpg', '${"c".repeat(64)}',
      1024, 'image/jpeg', '${at}');
  `);
}

function insertDecision(database: DatabaseSync, value: IdentityEvidenceDecision): void {
  database.prepare(`INSERT OR IGNORE INTO identity_evidence_decisions
    (id, product_id, source_id, source_record_key, source_record_id, identity_hash,
     evidence_url, source_observed_at, rationale, decided_by, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      value.id,
      value.productId,
      value.sourceId,
      value.sourceRecordKey,
      value.sourceRecordId,
      value.identityHash,
      value.evidenceUrl,
      value.sourceObservedAt,
      value.rationale,
      value.decidedBy,
      value.decidedAt,
    );
}

describe("identity evidence decision helpers", () => {
  it("canonicalizes and validates one deterministic exact-bound decision", async () => {
    const current = await decision();
    const binding = {
      productId: payload.productId,
      sourceId: payload.sourceId,
      sourceRecordKey: payload.sourceRecordKey,
      sourceRecordId: payload.sourceRecordId,
      identityHash: payload.identityHash,
    };
    expect(await validateIdentityEvidenceDecision(current)).toEqual([]);
    expect(await identityEvidenceDecisionId(binding)).toBe(current.id);
    expect(canonicalIdentityEvidenceDecision({
      ...current,
      rationale: `  ${current.rationale}  `,
      evidenceUrl: "https://EXAMPLE.invalid/source",
    })).toEqual(current);
    expect(identityEvidenceBindingMatches(current, payload)).toBe(true);
    expect(identityEvidenceBindingMatches(current, { ...payload, identityHash: "c".repeat(64) })).toBe(false);
  });

  it("rejects malformed, non-canonical, and non-deterministic decisions", async () => {
    const current = await decision();
    expect(await validateIdentityEvidenceDecision({
      ...current,
      id: "ied_not-deterministic",
      evidenceUrl: "http://example.invalid/label.jpg",
      identityHash: "ABC",
      rationale: "  no  ",
      sourceObservedAt: "yesterday",
      unexpected: true,
    })).toEqual(expect.arrayContaining([
      "identityEvidenceDecision.unexpected is not supported",
      "identityHash must be a lowercase SHA-256 digest",
      "evidenceUrl must use HTTPS without embedded credentials",
      "sourceObservedAt must be a canonical ISO timestamp",
      "rationale must contain between 3 and 2000 characters",
    ]));
  });

  it("classifies new, identical, and conflicting attempts without comparing retry time", async () => {
    const existing = await decision();
    expect(identityEvidenceDecisionDisposition(null, existing)).toBe("insert");
    expect(identityEvidenceDecisionDisposition(existing, {
      ...existing,
      decidedAt: "2026-07-17T00:10:00.000Z",
      sourceObservedAt: "2026-07-18T00:00:00.000Z",
    })).toBe("idempotent");
    expect(identityEvidenceDecisionDisposition(existing, {
      ...existing,
      evidenceUrl: "https://example.invalid/a-different-label.jpg",
    })).toBe("conflict");
    expect(identityEvidenceDecisionDisposition(existing, {
      ...existing,
      rationale: "A different immutable review assertion.",
    })).toBe("conflict");
  });
});

describe("identity evidence decision migration", () => {
  it("preserves invalid legacy history but removes its projection when provenance enforcement upgrades", async () => {
    const database = new DatabaseSync(":memory:");
    await applyMigrationsThrough(database, "0012_current_label_revision.sql");
    await seedCurrentBinding(database);
    const invalid = await decision({ evidenceUrl: "https://unrelated.example/legacy-proof.jpg" });
    insertDecision(database, invalid);
    database.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url,
       observed_at, verified_at, decided_by, notes)
      VALUES (?, 'identity', 'verified', ?, ?, ?, ?, ?, ?)`)
      .run(
        invalid.productId,
        invalid.sourceRecordId,
        invalid.evidenceUrl,
        invalid.sourceObservedAt,
        invalid.decidedAt,
        invalid.decidedBy,
        invalid.rationale,
      );

    database.exec(await readFile("migrations/0013_identity_evidence_provenance.sql", "utf8"));

    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 1 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM evidence_outcomes
      WHERE field_family = 'identity'`).get()).toEqual({ count: 0 });
    database.close();
  });

  it("stores one exact current decision, permits exact replay, and rejects conflicts or mutation", async () => {
    const database = new DatabaseSync(":memory:");
    await applyAllMigrations(database);
    await seedCurrentBinding(database);
    const current = await decision();

    insertDecision(database, current);
    insertDecision(database, { ...current, decidedAt: "2026-07-17T00:10:00.000Z" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 1 });
    expect(database.prepare(`SELECT evidence_url, rationale, decided_at
      FROM identity_evidence_decisions WHERE id = ?`).get(current.id)).toEqual({
      evidence_url: current.evidenceUrl,
      rationale: current.rationale,
      decided_at: current.decidedAt,
    });

    expect(() => insertDecision(database, {
      ...current,
      evidenceUrl: "https://example.invalid/a-different-label.jpg",
    })).toThrow("identity evidence decision conflict");
    expect(() => database.prepare("UPDATE identity_evidence_decisions SET rationale = ? WHERE id = ?")
      .run("Changed history", current.id)).toThrow("identity evidence decisions are immutable");
    expect(() => database.prepare("DELETE FROM identity_evidence_decisions WHERE id = ?")
      .run(current.id)).toThrow("identity evidence decisions are immutable");

    const indexes = database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'identity_evidence_decisions'
        AND name LIKE 'idx_identity_evidence_decisions_%'
      ORDER BY name`).all().map((row) => row.name);
    expect(indexes).toEqual([
      "idx_identity_evidence_decisions_product",
      "idx_identity_evidence_decisions_replay",
    ]);
    database.close();
  });

  it("rejects stale and malformed source bindings", async () => {
    const database = new DatabaseSync(":memory:");
    await applyAllMigrations(database);
    await seedCurrentBinding(database);
    const current = await decision();

    expect(() => insertDecision(database, {
      ...current,
      sourceObservedAt: "2026-07-17T00:01:00.000Z",
    })).toThrow("identity evidence current source binding mismatch");
    expect(() => insertDecision(database, {
      ...current,
      id: `ied_${"f".repeat(24)}`,
      identityHash: "not-a-hash",
    })).toThrow();
    expect(() => insertDecision(database, {
      ...current,
      id: `ied_${"e".repeat(24)}`,
      evidenceUrl: "http://example.invalid/label.jpg",
    })).toThrow();
    expect(() => insertDecision(database, {
      ...current,
      id: `ied_${"d".repeat(24)}`,
      evidenceUrl: "https://unrelated.example/label.jpg",
    })).toThrow("identity evidence current source binding mismatch");
    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("revokes a label-bound identity projection when the current image revision changes", async () => {
    const database = new DatabaseSync(":memory:");
    await applyAllMigrations(database);
    await seedCurrentBinding(database);
    const current = await decision({
      evidenceUrl: "https://example.invalid/a-different-label.jpg",
    });
    insertDecision(database, current);
    database.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url,
       observed_at, verified_at, decided_by, notes)
      VALUES (?, 'identity', 'verified', ?, ?, ?, ?, ?, ?)`).run(
      current.productId,
      current.sourceRecordId,
      current.evidenceUrl,
      current.sourceObservedAt,
      current.decidedAt,
      current.decidedBy,
      current.rationale,
    );

    database.exec(`INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id,
       field_family, source_image_id, source_image_revision, requested_url,
       effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES ('identity-label-v2', 'record', '${"b".repeat(64)}', 'product',
        'nutrition', 'identity-panel', '2',
        'https://example.invalid/identity-label-v2.jpg',
        'https://example.invalid/identity-label-v2.jpg', '${"d".repeat(64)}',
        1024, 'image/jpeg', '2026-07-17T00:10:00.000Z')`);

    expect(database.prepare("SELECT id FROM current_label_evidence_assets").all())
      .toEqual([{ id: "identity-label-v2" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM current_identity_evidence_decisions").get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM evidence_outcomes
      WHERE product_id = 'product' AND field_family = 'identity'`).get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("removes the old product projection immediately when its source record is relinked", async () => {
    const database = new DatabaseSync(":memory:");
    await applyAllMigrations(database);
    await seedCurrentBinding(database);
    const current = await decision();
    insertDecision(database, current);
    database.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url,
       observed_at, verified_at, decided_by, notes)
      VALUES (?, 'identity', 'verified', ?, ?, ?, ?, ?, ?)`).run(
      current.productId,
      current.sourceRecordId,
      current.evidenceUrl,
      current.sourceObservedAt,
      current.decidedAt,
      current.decidedBy,
      current.rationale,
    );
    database.exec(`
      INSERT INTO products
        (id, brand, brand_normalized, name, name_normalized, category,
         marketed_reasons_json, nutrition_reasons_json, classifier_version,
         completeness_missing_json, created_at, updated_at)
      VALUES ('replacement-product', 'Brand', 'brand', 'Replacement', 'replacement',
        'other', '[]', '[]', 'protein-v1', '[]', '${at}', '${at}');
      UPDATE source_records SET product_id = 'replacement-product' WHERE id = 'record';
    `);

    expect(database.prepare(`SELECT COUNT(*) AS count FROM evidence_outcomes
      WHERE product_id = 'product' AND field_family = 'identity'`).get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM current_identity_evidence_decisions").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 1 });
    database.close();
  });
});
