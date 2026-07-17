import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildFixtureStage } from "../scripts/fixtures";
import {
  emitImportSql,
  ingestionRunIdForManifest,
  type ExtractionImportInput,
} from "../scripts/reconcile";
import type { ExtractionRun, LabelEvidenceAsset } from "../shared/extraction-outcomes";
import type { SourceManifest, StagedProduct } from "../shared/types";

const hash = (character: string): string => character.repeat(64);
const firstAt = "2026-07-17T10:00:00.000Z";

async function databaseWithMigrations(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(await readFile(join("migrations", migration), "utf8"));
  }
  return database;
}

async function baseProduct(): Promise<StagedProduct> {
  const directory = await mkdtemp(join(tmpdir(), "protein-index-terminal-base-"));
  const { stagedPath } = await buildFixtureStage(directory);
  const [line] = (await readFile(stagedPath, "utf8")).trim().split("\n");
  if (!line) throw new Error("Expected a fixture product");
  const product = JSON.parse(line) as StagedProduct;
  return {
    ...product,
    offers: [],
    ratings: [],
    nutrients: [],
    nutrition: { ...product.nutrition, status: "missing", confidence: "low", labelVerifiedAt: null },
    ingredients: {
      ...product.ingredients,
      raw: "",
      normalized: [],
      allergens: [],
      additives: [],
      status: "missing",
      confidence: "low",
    },
    completeness: 30,
    completenessMissing: ["nutrition", "ingredients"],
    validationIssues: [],
  };
}

interface ReplayOptions {
  at: string;
  inputHash?: string;
  parent?: { runId: string; inputHash: string };
  labelAsset?: LabelEvidenceAsset;
}

async function replaySql(product: StagedProduct, options: ReplayOptions): Promise<{
  sql: string;
  manifest: SourceManifest;
  runId: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "protein-index-terminal-replay-"));
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
    adapterVersion: "terminal-replay-test-v1",
    input: `fixture:${product.sourceRecordId}:${options.at}`,
    inputHash: options.inputHash ?? createHash("sha256").update(`${product.contentHash}:${options.at}`).digest("hex"),
    inputBytes: 1,
    sourceUpdatedAt: options.at,
    startedAt: options.at,
    completedAt: options.at,
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

  let extraction: ExtractionImportInput | undefined;
  if (options.parent && options.labelAsset) {
    const labelAssetsPath = join(directory, "label-assets.jsonl");
    const extractionAttemptsPath = join(directory, "extraction-attempts.jsonl");
    const extractionAttemptLabelsPath = join(directory, "extraction-attempt-labels.jsonl");
    const run: ExtractionRun = {
      id: `extraction-${options.labelAsset.id}`,
      ingestionRunId: ingestionRunIdForManifest(manifest),
      fieldFamily: "nutrition",
      requestSchemaHash: hash("a"),
      artifactDigest: createHash("sha256").update(options.labelAsset.id).digest("hex"),
      adapterVersion: manifest.adapterVersion,
      modelName: "terminal-replay-test",
      modelVersion: "1",
      parentSourceRunId: options.parent.runId,
      parentSourceInputHash: options.parent.inputHash,
      repository: "protein-index",
      workflow: "terminal-replay-test",
      branch: "test",
      headSha: "b".repeat(40),
      sourceComplete: true,
      status: "accepted",
      startedAt: options.at,
      completedAt: options.at,
      acceptedAt: options.at,
      manifest: { fixture: true },
    };
    await writeFile(labelAssetsPath, `${JSON.stringify(options.labelAsset)}\n`, "utf8");
    await writeFile(extractionAttemptsPath, "", "utf8");
    await writeFile(extractionAttemptLabelsPath, "", "utf8");
    extraction = { run, labelAssetsPath, extractionAttemptsPath, extractionAttemptLabelsPath };
  }

  await emitImportSql({ stagedPath, manifestPath, outputPath, extraction });
  return { sql: await readFile(outputPath, "utf8"), manifest, runId: ingestionRunIdForManifest(manifest) };
}

describe("source ingredient replay", () => {
  it("replaces stale unverified nested ingredient nodes before inserting a revised source record", async () => {
    const database = await databaseWithMigrations();
    const product = await baseProduct();
    const first: StagedProduct = {
      ...product,
      contentHash: hash("a"),
      sourceAuthority: { ...product.sourceAuthority, ingredients: 20 },
      ingredients: {
        ...product.ingredients,
        raw: "Blend (A)",
        normalized: [{
          raw: "Blend",
          normalizedName: "blend",
          percentage: null,
          position: 0,
          children: [{ raw: "A", normalizedName: "a", percentage: null, position: 0, children: [] }],
        }],
        status: "unverified",
        confidence: "medium",
      },
    };
    const second: StagedProduct = {
      ...first,
      contentHash: hash("b"),
      ingredients: {
        ...first.ingredients,
        raw: "Blend (B)",
        normalized: [{
          raw: "Blend",
          normalizedName: "blend",
          percentage: null,
          position: 0,
          children: [{ raw: "B", normalizedName: "b", percentage: null, position: 0, children: [] }],
        }],
      },
    };
    const firstReplay = await replaySql(first, { at: firstAt, inputHash: hash("1") });
    const secondReplay = await replaySql(second, { at: "2026-07-17T11:00:00.000Z", inputHash: hash("2") });

    database.exec(firstReplay.sql);
    database.exec(secondReplay.sql);

    expect(database.prepare(`SELECT raw_text, normalized_name, position FROM product_ingredients
      ORDER BY parent_id IS NOT NULL, position, raw_text`).all()).toEqual([
      { raw_text: "Blend", normalized_name: "blend", position: 0 },
      { raw_text: "B", normalized_name: "b", position: 0 },
    ]);
  });
});

interface SourceBinding {
  id: string;
  source_id: string;
  source_record_id: string;
  product_id: string;
  content_hash: string;
}

function sourceBinding(database: DatabaseSync, source: string, key: string): SourceBinding {
  const record = database.prepare(`SELECT id, source_id, source_record_id, product_id, content_hash
    FROM source_records WHERE source_id = ? AND source_record_id = ?`).get(source, key) as SourceBinding | undefined;
  if (!record) throw new Error("Expected an imported source binding");
  return record;
}

function insertDecision(
  database: DatabaseSync,
  id: string,
  binding: SourceBinding,
  options: { kind?: "source" | "label"; label?: LabelEvidenceAsset; at?: string } = {},
): void {
  const kind = options.kind ?? "source";
  database.prepare(`INSERT INTO terminal_evidence_decisions
    (id, idempotency_key, source_id, source_record_key, source_record_id,
      source_content_hash, product_id, field_family, outcome, evidence_kind,
      label_asset_id, label_content_sha256, rationale, decided_by, decided_at)
    VALUES ($id, $idempotencyKey, $sourceId, $sourceRecordKey, $sourceRecordId,
      $sourceContentHash, $productId, 'nutrition', 'not_declared', $kind,
      $labelAssetId, $labelContentSha256,
      'The exact current evidence contains no declared nutrition.', 'test_operator', $decidedAt)`)
    .run({
      $id: id,
      $idempotencyKey: `terminal:reconcile:${id}`,
      $sourceId: binding.source_id,
      $sourceRecordKey: binding.source_record_id,
      $sourceRecordId: binding.id,
      $sourceContentHash: binding.content_hash,
      $productId: binding.product_id,
      $kind: kind,
      $labelAssetId: kind === "label" ? options.label?.id ?? null : null,
      $labelContentSha256: kind === "label" ? options.label?.contentSha256 ?? null : null,
      $decidedAt: options.at ?? firstAt,
    });
}

function immutableHistory(database: DatabaseSync): unknown[] {
  return database.prepare(`SELECT id, idempotency_key, source_id, source_record_key,
    source_record_id, source_content_hash, product_id, field_family, outcome,
    evidence_kind, label_asset_id, label_content_sha256, rationale, decided_by,
    decided_at, supersedes_decision_id
    FROM terminal_evidence_decisions ORDER BY id`).all();
}

describe("terminal evidence reconciliation through real source replay", () => {
  it("preserves immutable decisions and falls back to an agreeing current source after content drift", async () => {
    const database = await databaseWithMigrations();
    const seed = await baseProduct();
    const preferred = {
      ...seed,
      source: "terminal_preferred",
      sourceKind: "official" as const,
      sourceRecordId: "preferred-record",
      sourceUrl: "https://preferred.example/product",
      contentHash: hash("1"),
      sourceAuthority: { identity: 100, nutrition: 100, ingredients: 100 },
      observedAt: firstAt,
    };
    const fallback = {
      ...seed,
      source: "terminal_fallback",
      sourceKind: "brand" as const,
      sourceRecordId: "fallback-record",
      sourceUrl: "https://fallback.example/product",
      contentHash: hash("2"),
      sourceAuthority: { identity: 100, nutrition: 100, ingredients: 100 },
      observedAt: firstAt,
    };
    const preferredReplay = await replaySql(preferred, { at: firstAt });
    const fallbackReplay = await replaySql(fallback, { at: "2026-07-17T10:01:00.000Z" });
    database.exec(preferredReplay.sql);
    database.exec(fallbackReplay.sql);
    const preferredBinding = sourceBinding(database, preferred.source, preferred.sourceRecordId);
    const fallbackBinding = sourceBinding(database, fallback.source, fallback.sourceRecordId);
    insertDecision(database, "terminal-preferred", preferredBinding, { at: "2026-07-17T10:04:00.000Z" });
    insertDecision(database, "terminal-fallback", fallbackBinding, { at: "2026-07-17T10:03:00.000Z" });
    const before = immutableHistory(database);

    expect(database.prepare(`SELECT source_record_id, notes FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'nutrition'`).get(preferredBinding.product_id)).toEqual({
      source_record_id: preferredBinding.id,
      notes: "terminal_evidence_decision:terminal-preferred",
    });

    database.exec(preferredReplay.sql);
    expect(immutableHistory(database)).toEqual(before);
    expect(database.prepare(`SELECT notes FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'nutrition'`).get(preferredBinding.product_id)).toEqual({
      notes: "terminal_evidence_decision:terminal-preferred",
    });

    const changed = {
      ...preferred,
      contentHash: hash("3"),
      observedAt: "2026-07-17T11:00:00.000Z",
    };
    const changedReplay = await replaySql(changed, { at: changed.observedAt });
    database.exec(changedReplay.sql);
    expect(immutableHistory(database)).toEqual(before);
    expect(database.prepare(`SELECT source_record_id, notes FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'nutrition'`).get(preferredBinding.product_id)).toEqual({
      source_record_id: fallbackBinding.id,
      notes: "terminal_evidence_decision:terminal-fallback",
    });
    expect(database.prepare(`SELECT id FROM current_terminal_evidence_decisions ORDER BY id`).all())
      .toEqual([{ id: "terminal-fallback" }]);

    database.exec(changedReplay.sql);
    expect(immutableHistory(database)).toEqual(before);
    expect(database.prepare(`SELECT notes FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'nutrition'`).get(preferredBinding.product_id)).toEqual({
      notes: "terminal_evidence_decision:terminal-fallback",
    });
  });

  it("removes the exact projection but never rewrites history when replay relinks the source product", async () => {
    const database = await databaseWithMigrations();
    const seed = await baseProduct();
    const product = {
      ...seed,
      source: "terminal_relink",
      sourceKind: "official" as const,
      sourceRecordId: "relink-record",
      sourceUrl: "https://relink.example/product",
      contentHash: hash("4"),
      sourceAuthority: { identity: 100, nutrition: 100, ingredients: 100 },
      observedAt: firstAt,
    };
    const replay = await replaySql(product, { at: firstAt });
    database.exec(replay.sql);
    const binding = sourceBinding(database, product.source, product.sourceRecordId);
    const identity = database.prepare("SELECT identity_hash FROM source_records WHERE id = ?")
      .get(binding.id) as { identity_hash: string };
    insertDecision(database, "terminal-before-relink", binding);
    const before = immutableHistory(database);

    database.prepare("UPDATE products SET gtin = NULL WHERE id = ?").run(binding.product_id);
    database.prepare(`INSERT INTO products
      (id, gtin, brand, brand_normalized, name, name_normalized, category,
        marketed_reasons_json, nutrition_reasons_json, classifier_version,
        completeness, completeness_missing_json, identity_authority, created_at, updated_at)
      SELECT 'prd_terminal_relinked', ?, brand, brand_normalized, name, name_normalized,
        category, marketed_reasons_json, nutrition_reasons_json, classifier_version,
        completeness, completeness_missing_json, identity_authority, created_at, updated_at
      FROM products WHERE id = ?`).run(product.gtin, binding.product_id);
    database.prepare(`INSERT INTO identity_decisions
      (id, source_id, source_record_key, source_record_id, identity_hash, decision,
        target_product_id, rationale, decided_by, decided_at, active)
      VALUES ('identity-terminal-relink', ?, ?, ?, ?, 'match', 'prd_terminal_relinked',
        'Exact identity review selected another canonical product', 'test_operator', ?, 1)`)
      .run(product.source, product.sourceRecordId, binding.id, identity.identity_hash, firstAt);

    database.exec(replay.sql);
    expect(sourceBinding(database, product.source, product.sourceRecordId).product_id)
      .toBe("prd_terminal_relinked");
    expect(immutableHistory(database)).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS count FROM current_terminal_evidence_decisions").get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM evidence_outcomes
      WHERE decided_by = 'terminal_evidence_projection'`).get()).toEqual({ count: 0 });
  });

  it("invalidates an exact label decision when a newer immutable label arrives through extraction replay", async () => {
    const database = await databaseWithMigrations();
    const seed = await baseProduct();
    const product = {
      ...seed,
      source: "open_food_facts_robotoff",
      sourceKind: "open_data" as const,
      sourceRecordId: "robotoff-label-record",
      sourceUrl: "https://world.openfoodfacts.org/product/terminal-label",
      contentHash: hash("5"),
      sourceAuthority: { identity: 80, nutrition: 80, ingredients: 70 },
      observedAt: firstAt,
    };
    const parent = await replaySql(product, { at: firstAt, inputHash: hash("6") });
    database.exec(parent.sql);
    const binding = sourceBinding(database, product.source, product.sourceRecordId);
    const firstLabel: LabelEvidenceAsset = {
      id: "terminal-label-v1",
      subjectSourceRecordId: binding.id,
      subjectSourceContentHash: binding.content_hash,
      productId: binding.product_id,
      fieldFamily: "nutrition",
      sourceImageId: "nutrition-panel",
      sourceImageRevision: "1",
      requestedUrl: "https://images.example/nutrition.jpg",
      effectiveUrl: "https://images.example/nutrition-v1.jpg",
      contentSha256: hash("7"),
      byteLength: 2048,
      mediaType: "image/jpeg",
      fetchedAt: "2026-07-17T10:10:00.000Z",
    };
    const firstLabelReplay = await replaySql(product, {
      at: "2026-07-17T10:10:00.000Z",
      parent: { runId: parent.runId, inputHash: parent.manifest.inputHash! },
      labelAsset: firstLabel,
    });
    database.exec(firstLabelReplay.sql);
    insertDecision(database, "terminal-label-decision", binding, {
      kind: "label",
      label: firstLabel,
      at: "2026-07-17T10:11:00.000Z",
    });
    const before = immutableHistory(database);

    database.exec(firstLabelReplay.sql);
    expect(immutableHistory(database)).toEqual(before);
    expect(database.prepare(`SELECT notes FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'nutrition'`).get(binding.product_id)).toEqual({
      notes: "terminal_evidence_decision:terminal-label-decision",
    });

    const secondLabel: LabelEvidenceAsset = {
      ...firstLabel,
      id: "terminal-label-v2",
      sourceImageRevision: "2",
      effectiveUrl: "https://images.example/nutrition-v2.jpg",
      contentSha256: hash("8"),
      fetchedAt: "2026-07-17T10:20:00.000Z",
    };
    const secondLabelReplay = await replaySql(product, {
      at: secondLabel.fetchedAt,
      parent: { runId: firstLabelReplay.runId, inputHash: firstLabelReplay.manifest.inputHash! },
      labelAsset: secondLabel,
    });
    database.exec(secondLabelReplay.sql);
    expect(immutableHistory(database)).toEqual(before);
    expect(database.prepare("SELECT id FROM current_label_evidence_assets").all())
      .toEqual([{ id: "terminal-label-v2" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM current_terminal_evidence_decisions").get())
      .toEqual({ count: 0 });
    expect(database.prepare(`SELECT COUNT(*) AS count FROM evidence_outcomes
      WHERE decided_by = 'terminal_evidence_projection'`).get()).toEqual({ count: 0 });
  });
});
