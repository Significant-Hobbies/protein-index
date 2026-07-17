import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildFixtureStage } from "../scripts/fixtures";
import { emitImportSql, identityEvidenceHash } from "../scripts/reconcile";
import { identityEvidenceDecisionId, type IdentityEvidenceDecision } from "../shared/identity-evidence";
import type { SourceManifest, StagedProduct } from "../shared/types";

const firstAt = "2026-07-17T10:00:00.000Z";

async function databaseWithMigrations(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
  return database;
}

async function fixtureProduct(): Promise<StagedProduct> {
  const directory = await mkdtemp(join(tmpdir(), "protein-index-identity-fixture-"));
  const fixture = await buildFixtureStage(directory);
  const line = (await readFile(fixture.stagedPath, "utf8")).trim().split("\n")[0];
  if (!line) throw new Error("Expected a fixture product");
  const product = JSON.parse(line) as StagedProduct;
  return {
    ...product,
    source: "identity_source_a",
    sourceRecordId: "identity-record-a",
    sourceUrl: "https://example.invalid/source-a",
    observedAt: firstAt,
    contentHash: createHash("sha256").update("identity-source-a-v1").digest("hex"),
    offers: [],
    ratings: [],
  };
}

async function importSql(product: StagedProduct, completedAt: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "protein-index-identity-replay-"));
  const stagedPath = join(directory, "staged.jsonl");
  const manifestPath = join(directory, "manifest.json");
  const outputPath = join(directory, "import.sql");
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source: product.source,
    sourceKind: product.sourceKind,
    sourceAuthority: product.sourceAuthority,
    sourceLicenseUrl: product.sourceLicenseUrl,
    sourceRetentionNotes: product.sourceRetentionNotes,
    adapterVersion: "identity-replay-v1",
    input: `${product.source}:${product.sourceRecordId}:${completedAt}`,
    inputHash: createHash("sha256").update(`${product.contentHash}:${completedAt}`).digest("hex"),
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

async function seedDecision(
  database: DatabaseSync,
  product: StagedProduct,
  decidedAt: string,
): Promise<IdentityEvidenceDecision> {
  const source = database.prepare(`SELECT id, product_id, source_id,
    source_record_id, identity_hash, observed_at
    FROM source_records WHERE source_id = ? AND source_record_id = ?`)
    .get(product.source, product.sourceRecordId) as {
      id: string;
      product_id: string;
      source_id: string;
      source_record_id: string;
      identity_hash: string;
      observed_at: string;
    } | undefined;
  if (!source) throw new Error("Expected an imported identity source");
  const binding = {
    productId: source.product_id,
    sourceId: source.source_id,
    sourceRecordKey: source.source_record_id,
    sourceRecordId: source.id,
    identityHash: source.identity_hash,
  };
  const decision: IdentityEvidenceDecision = {
    id: await identityEvidenceDecisionId(binding),
    ...binding,
    evidenceUrl: product.sourceUrl!,
    sourceObservedAt: source.observed_at,
    rationale: `Exact ${product.source} package identity`,
    decidedBy: "reconciliation_test",
    decidedAt,
  };
  database.prepare(`INSERT INTO identity_evidence_decisions
    (id, product_id, source_id, source_record_key, source_record_id, identity_hash,
     evidence_url, source_observed_at, rationale, decided_by, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      decision.id,
      decision.productId,
      decision.sourceId,
      decision.sourceRecordKey,
      decision.sourceRecordId,
      decision.identityHash,
      decision.evidenceUrl,
      decision.sourceObservedAt,
      decision.rationale,
      decision.decidedBy,
      decision.decidedAt,
    );
  return decision;
}

function projectDecision(database: DatabaseSync, decision: IdentityEvidenceDecision): void {
  database.prepare(`INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, source_record_id, evidence_url, observed_at,
     verified_at, decided_by, notes)
    VALUES (?, 'identity', 'verified', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, field_family) DO UPDATE SET
      outcome = excluded.outcome, source_record_id = excluded.source_record_id,
      evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
      verified_at = excluded.verified_at, decided_by = excluded.decided_by,
      notes = excluded.notes`)
    .run(
      decision.productId,
      decision.sourceRecordId,
      decision.evidenceUrl,
      decision.sourceObservedAt,
      decision.decidedAt,
      decision.decidedBy,
      decision.rationale,
    );
}

function outcome(database: DatabaseSync, productId: string): Record<string, unknown> | undefined {
  return database.prepare(`SELECT outcome, source_record_id, evidence_url, observed_at,
    verified_at, decided_by, notes FROM evidence_outcomes
    WHERE product_id = ? AND field_family = 'identity'`).get(productId) as Record<string, unknown> | undefined;
}

describe("identity evidence reconciliation replay", () => {
  it("replays unchanged evidence without duplicating or mutating immutable decisions", async () => {
    const database = await databaseWithMigrations();
    const product = await fixtureProduct();
    const sql = await importSql(product, firstAt);
    database.exec(sql);
    const decision = await seedDecision(database, product, "2026-07-17T10:05:00.000Z");
    projectDecision(database, decision);
    const beforeDecision = database.prepare("SELECT * FROM identity_evidence_decisions WHERE id = ?")
      .get(decision.id);
    const beforeOutcome = outcome(database, decision.productId);

    database.exec(sql);

    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT * FROM identity_evidence_decisions WHERE id = ?").get(decision.id))
      .toEqual(beforeDecision);
    expect(outcome(database, decision.productId)).toEqual(beforeOutcome);
    database.close();
  });

  it("does not restore a projection after the reviewed evidence URL stops matching", async () => {
    const database = await databaseWithMigrations();
    const product = await fixtureProduct();
    database.exec(await importSql(product, firstAt));
    const decision = await seedDecision(database, product, "2026-07-17T10:05:00.000Z");
    projectDecision(database, decision);

    const changedUrl = {
      ...structuredClone(product),
      sourceUrl: "https://example.invalid/source-a-replaced",
      observedAt: "2026-07-17T10:30:00.000Z",
    };
    database.exec(await importSql(changedUrl, changedUrl.observedAt));

    expect(outcome(database, decision.productId)).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM current_identity_evidence_decisions").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 1 });
    database.close();
  });

  it("revokes only the named stale projection after identity drift or source relinking", async () => {
    const driftDatabase = await databaseWithMigrations();
    const original = await fixtureProduct();
    driftDatabase.exec(await importSql(original, firstAt));
    const driftDecision = await seedDecision(driftDatabase, original, "2026-07-17T10:05:00.000Z");
    projectDecision(driftDatabase, driftDecision);
    const drifted = {
      ...structuredClone(original),
      name: `${original.name} reformulated`,
      observedAt: "2026-07-17T11:00:00.000Z",
      contentHash: createHash("sha256").update("identity-source-a-v2").digest("hex"),
    };
    driftDatabase.exec(await importSql(drifted, drifted.observedAt));
    expect(outcome(driftDatabase, driftDecision.productId)).toBeUndefined();
    expect(driftDatabase.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions WHERE id = ?")
      .get(driftDecision.id)).toEqual({ count: 1 });
    expect(driftDatabase.prepare("SELECT identity_hash FROM source_records WHERE id = ?")
      .get(driftDecision.sourceRecordId)).toEqual({ identity_hash: identityEvidenceHash(drifted) });
    driftDatabase.close();

    const relinkDatabase = await databaseWithMigrations();
    relinkDatabase.exec(await importSql(original, firstAt));
    const relinkDecision = await seedDecision(relinkDatabase, original, "2026-07-17T10:05:00.000Z");
    projectDecision(relinkDatabase, relinkDecision);
    relinkDatabase.prepare(`INSERT INTO products
      (id, brand, brand_normalized, name, name_normalized, category, classifier_version,
       created_at, updated_at, is_active)
      VALUES ('prd_identity_relinked', 'Relinked', 'relinked', 'Relinked product',
        'relinked product', 'other', 'protein-v1', ?, ?, 1)`)
      .run(firstAt, firstAt);
    relinkDatabase.prepare(`INSERT INTO identity_decisions
      (id, source_id, source_record_key, source_record_id, identity_hash, decision,
       target_product_id, rationale, decided_by, decided_at, active)
      VALUES ('idn_identity_relinked', ?, ?, ?, ?, 'match', 'prd_identity_relinked',
        'Exact manual relinking', 'reconciliation_test', ?, 1)`)
      .run(
        relinkDecision.sourceId,
        relinkDecision.sourceRecordKey,
        relinkDecision.sourceRecordId,
        relinkDecision.identityHash,
        "2026-07-17T10:10:00.000Z",
      );
    relinkDatabase.exec(await importSql(original, "2026-07-17T10:15:00.000Z"));
    expect(relinkDatabase.prepare("SELECT product_id FROM source_records WHERE id = ?")
      .get(relinkDecision.sourceRecordId)).toEqual({ product_id: "prd_identity_relinked" });
    expect(outcome(relinkDatabase, relinkDecision.productId)).toBeUndefined();
    expect(relinkDatabase.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions WHERE id = ?")
      .get(relinkDecision.id)).toEqual({ count: 1 });
    relinkDatabase.close();
  });

  it("falls back to another exact source and does not revive a decision for a newer observation", async () => {
    const database = await databaseWithMigrations();
    const sourceA = await fixtureProduct();
    const sourceB = {
      ...structuredClone(sourceA),
      source: "identity_source_b",
      sourceRecordId: "identity-record-b",
      sourceUrl: "https://example.invalid/source-b",
      contentHash: createHash("sha256").update("identity-source-b-v1").digest("hex"),
    };
    database.exec(await importSql(sourceA, firstAt));
    database.exec(await importSql(sourceB, "2026-07-17T10:01:00.000Z"));
    const decisionB = await seedDecision(database, sourceB, "2026-07-17T10:05:00.000Z");
    const decisionA = await seedDecision(database, sourceA, "2026-07-17T10:10:00.000Z");
    projectDecision(database, decisionA);

    const driftedA = {
      ...structuredClone(sourceA),
      name: `${sourceA.name} changed identity`,
      observedAt: "2026-07-17T11:00:00.000Z",
      contentHash: createHash("sha256").update("identity-source-a-drift").digest("hex"),
    };
    const driftSql = await importSql(driftedA, driftedA.observedAt);
    database.exec(driftSql);
    expect(outcome(database, decisionA.productId)).toMatchObject({
      outcome: "verified",
      source_record_id: decisionB.sourceRecordId,
      evidence_url: decisionB.evidenceUrl,
    });
    database.exec(driftSql);
    expect(outcome(database, decisionA.productId)).toMatchObject({
      source_record_id: decisionB.sourceRecordId,
      evidence_url: decisionB.evidenceUrl,
    });

    const restoredA = {
      ...structuredClone(sourceA),
      observedAt: "2026-07-17T12:00:00.000Z",
      contentHash: createHash("sha256").update("identity-source-a-restored").digest("hex"),
    };
    database.exec(await importSql(restoredA, restoredA.observedAt));
    expect(outcome(database, decisionA.productId)).toMatchObject({
      outcome: "verified",
      source_record_id: decisionB.sourceRecordId,
      evidence_url: decisionB.evidenceUrl,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM identity_evidence_decisions").get())
      .toEqual({ count: 2 });
    database.close();
  });
});
