import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CompletionFamily, CompletionLedgerResponse, CoverageResponse } from "../shared/api";
import { completionSummaryQuery } from "../worker/completion";

const worker = exports.default;
const observedAt = "2026-07-17T12:00:00.000Z";

async function json<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json() as Promise<T>;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function productStatement(input: {
  id: string;
  name: string;
  active?: boolean;
  nutritionImageUrl?: string | null;
  ingredientImageUrl?: string | null;
}) {
  return env.DB.prepare(`INSERT INTO products
    (id, brand, brand_normalized, name, name_normalized, category, nutrition_image_url,
      ingredient_image_url, classifier_version, created_at, updated_at, is_active)
    VALUES (?, 'Ledger Test', 'ledger test', ?, ?, 'other', ?, ?, 'protein-v1', ?, ?, ?)`)
    .bind(
      input.id,
      input.name,
      normalized(input.name),
      input.nutritionImageUrl ?? null,
      input.ingredientImageUrl ?? null,
      observedAt,
      observedAt,
      input.active === false ? 0 : 1,
    );
}

function nutritionStatement(
  productId: string,
  status: "missing" | "unverified" | "verified" | "conflict",
  authority: number,
) {
  return env.DB.prepare(`INSERT INTO nutrition_facts
    (product_id, status, confidence, authority, basis, preparation_state, calories,
      protein_grams, observed_at, updated_at)
    VALUES (?, ?, ?, ?, 'per_100g', 'as_sold', 400, 20, ?, ?)`)
    .bind(productId, status, status === "verified" ? "high" : "low", authority, observedAt, observedAt);
}

function ingredientStatement(
  productId: string,
  status: "missing" | "unverified" | "verified" | "conflict",
  authority: number,
) {
  return env.DB.prepare(`INSERT INTO ingredient_statements
    (product_id, raw_text, language, status, confidence, authority, observed_at, updated_at)
    VALUES (?, 'Test ingredient', 'en', ?, ?, ?, ?, ?)`)
    .bind(productId, status, status === "verified" ? "high" : "low", authority, observedAt, observedAt);
}

function outcomeStatement(
  productId: string,
  family: CompletionFamily,
  outcome: "verified" | "not_applicable" | "not_declared",
  evidenceUrl = "https://example.invalid/current-label.jpg",
) {
  return env.DB.prepare(`INSERT INTO evidence_outcomes
    (product_id, field_family, outcome, evidence_url, observed_at, verified_at, decided_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'completion_test', 'Exact test evidence')`)
    .bind(productId, family, outcome, evidenceUrl, observedAt, observedAt);
}

async function ensureRobotoffSource(family: "nutrition" | "ingredients"): Promise<string> {
  const sourceId = family === "nutrition"
    ? "open_food_facts_robotoff"
    : "open_food_facts_robotoff_ingredients";
  await env.DB.prepare(`INSERT OR IGNORE INTO sources
    (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
      retention_notes, created_at)
    VALUES (?, ?, 'open_data', 0, 20, 20, 'Review evidence only', ?)`)
    .bind(sourceId, `Completion ${family} source`, observedAt).run();
  return sourceId;
}

async function sourceRecord(input: {
  id: string;
  sourceId: string;
  productId: string;
  sourceUrl: string;
  observedAt?: string;
}): Promise<void> {
  const run = await env.DB.prepare("SELECT id FROM ingestion_runs ORDER BY started_at LIMIT 1")
    .first<{ id: string }>();
  if (!run) throw new Error("Expected fixture ingestion run");
  await env.DB.prepare(`INSERT INTO source_records
    (id, source_id, source_record_id, product_id, source_url, content_hash, identity_hash,
      observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'exact_gtin')`)
    .bind(
      input.id,
      input.sourceId,
      `${input.productId}:${input.id}`,
      input.productId,
      input.sourceUrl,
      "a".repeat(64),
      `identity-${input.id}`,
      input.observedAt ?? observedAt,
      run.id,
      run.id,
    ).run();
}

async function review(input: {
  id: string;
  productId: string;
  sourceRecordId: string;
  type: "identity" | "nutrition_validation" | "ingredient_conflict" | "coverage_gap";
  priority?: number;
  evidence?: Record<string, unknown>;
}): Promise<void> {
  await env.DB.prepare(`INSERT INTO review_items
    (id, type, priority, status, source_record_id, product_id,
      candidate_product_ids_json, evidence_json, created_at)
    VALUES (?, ?, ?, 'open', ?, ?, '[]', ?, ?)`)
    .bind(input.id, input.type, input.priority ?? 50, input.sourceRecordId, input.productId, JSON.stringify(input.evidence ?? {}), observedAt)
    .run();
}

async function currentExtraction(input: {
  id: string;
  family: "nutrition" | "ingredients";
  productId: string;
  subjectSourceRecordId: string;
  derivedSourceRecordId?: string;
  outcomes: Array<"candidate" | "no_prediction" | "rejected" | "failed">;
}): Promise<{ attemptId: string; labelAssetIds: string[]; candidateHash: string; candidateLabelAssetId: string | null }> {
  const subject = await env.DB.prepare(`SELECT sr.source_record_id, sr.content_hash, sr.source_id,
      sr.last_seen_run_id AS parent_run_id, parent.input_hash AS parent_input_hash
    FROM source_records sr
    JOIN ingestion_runs parent ON parent.id = sr.last_seen_run_id
    WHERE sr.id = ? AND parent.status = 'completed' AND parent.source_complete = 1`)
    .bind(input.subjectSourceRecordId).first<{
      source_record_id: string;
      content_hash: string;
      source_id: string;
      parent_run_id: string;
      parent_input_hash: string;
    }>();
  if (!subject?.parent_input_hash) throw new Error("Expected extraction fixture lineage");
  const ingestionRunId = `${input.id}-ingestion`;
  const extractionRunId = `${input.id}-run`;
  const attemptId = `${input.id}-attempt`;
  const candidateHash = "c".repeat(64);
  const artifactDigest = [...input.id].map((character) => character.charCodeAt(0).toString(16))
    .join("").padEnd(64, "0").slice(0, 64);
  const predictionCount = input.outcomes.filter((outcome) => outcome !== "no_prediction").length;
  const candidateCount = input.outcomes.filter((outcome) => outcome === "candidate").length;
  const rejectionCount = input.outcomes.filter((outcome) => outcome === "rejected").length;
  const failureCount = input.outcomes.filter((outcome) => outcome === "failed").length;
  const status = failureCount > 0 && candidateCount === 0
    ? "failed"
    : candidateCount > 0 ? "candidate" : rejectionCount > 0 ? "rejected" : "no_prediction";
  await env.DB.prepare(`INSERT INTO ingestion_runs
    (id, source_id, adapter_version, mode, input_identifier, input_hash, advertised_total,
      records_read, india_records, staged_records, invalid_records, duplicate_records,
      terminal_evidence, source_complete, market_complete, status, started_at, completed_at,
      manifest_json)
    VALUES (?, ?, 'completion-v1', 'sample', ?, ?, 1, 1, 1, 1, 0, 0,
      'end_of_file', 1, 0, 'completed', ?, ?, '{}')`)
    .bind(ingestionRunId, subject.source_id, `fixture:${input.id}`, artifactDigest, observedAt, observedAt).run();
  await env.DB.prepare(`INSERT INTO extraction_runs
    (id, ingestion_run_id, field_family, request_schema_hash, artifact_digest,
      adapter_version, model_name, model_version, parent_source_run_id,
      parent_source_input_hash, repository, workflow, branch, head_sha,
      source_complete, status, started_at, completed_at, accepted_at, manifest_json)
    VALUES (?, ?, ?, ?, ?, 'completion-v1', 'test-model', '1', ?, ?,
      'test/repository', 'completion-test', 'main', ?, 1, 'accepted', ?, ?, ?, '{}')`)
    .bind(extractionRunId, ingestionRunId, input.family, "1".repeat(64), artifactDigest,
      subject.parent_run_id, subject.parent_input_hash, "4".repeat(40), observedAt, observedAt, observedAt).run();
  const labelAssetIds: string[] = [];
  for (const [index, outcome] of input.outcomes.entries()) {
    const assetId = `${input.id}-asset-${index}`;
    labelAssetIds.push(assetId);
    await env.DB.prepare(`INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id, field_family,
        source_image_id, requested_url, effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 128, 'image/jpeg', ?)`)
      .bind(assetId, input.subjectSourceRecordId, subject.content_hash, input.productId, input.family,
        `image-${index}`, `https://example.invalid/${input.id}-${index}.jpg`,
        `https://example.invalid/${input.id}-${index}.jpg`, ((index + 5) % 16).toString(16).repeat(64), observedAt).run();
  }
  await env.DB.prepare(`INSERT INTO extraction_attempts
    (id, extraction_run_id, subject_source_record_id, subject_source_record_key,
      subject_source_content_hash, product_id, field_family, response_evidence_hash,
      status, prediction_count, candidate_count, rejection_count, failure_count,
      conflict_count, reasons_json, attempted_at, is_current)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, 1)`)
    .bind(attemptId, extractionRunId, input.subjectSourceRecordId, subject.source_record_id,
      subject.content_hash, input.productId, input.family, "5".repeat(64), status,
      predictionCount, candidateCount, rejectionCount, failureCount, observedAt).run();
  for (const [index, outcome] of input.outcomes.entries()) {
    const candidate = outcome === "candidate" ? 1 : 0;
    const rejected = outcome === "rejected" ? 1 : 0;
    const failed = outcome === "failed" ? 1 : 0;
    await env.DB.prepare(`INSERT INTO extraction_attempt_labels
      (id, attempt_id, label_asset_id, role, outcome, prediction_count, candidate_count,
        rejection_count, failure_count, conflict_count, candidate_hashes_json, reasons_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '[]')`)
      .bind(`${input.id}-link-${index}`, attemptId, labelAssetIds[index], index === 0 ? "requested" : "prediction",
        outcome, outcome === "no_prediction" ? 0 : 1, candidate, rejected, failed,
        JSON.stringify(candidate ? [candidateHash] : [])).run();
  }
  const candidateIndex = input.outcomes.findIndex((outcome) => outcome === "candidate");
  const bindingIndex = candidateIndex >= 0 ? candidateIndex : 0;
  if (input.derivedSourceRecordId && labelAssetIds[bindingIndex]) {
    await env.DB.prepare("UPDATE source_records SET raw_evidence_json = ? WHERE id = ?")
      .bind(JSON.stringify({
        candidateHash,
        extractionAttemptId: attemptId,
        labelAssetId: labelAssetIds[bindingIndex],
        labelContentSha256: ((bindingIndex + 5) % 16).toString(16).repeat(64),
      }), input.derivedSourceRecordId).run();
  }
  return { attemptId, labelAssetIds, candidateHash, candidateLabelAssetId: candidateIndex >= 0 ? labelAssetIds[candidateIndex] ?? null : null };
}

async function ledger(query = ""): Promise<CompletionLedgerResponse> {
  const response = await worker.fetch(`http://localhost/api/completion-ledger${query ? `?${query}` : ""}`);
  expect(response.status).toBe(200);
  return json<CompletionLedgerResponse>(response);
}

async function seedNutritionPartition(suffix: string) {
  const id = (state: string) => `ledger-matrix-${suffix}-${state}`;
  const ids = {
    verified: id("verified"),
    terminal: id("terminal"),
    stale: id("stale"),
    contradictory: id("contradictory"),
    conflictUnavailable: id("conflict-unavailable"),
    unevidencedTerminal: id("unevidenced-terminal"),
    lowAuthorityVerified: id("low-authority"),
    conflict: id("conflict"),
    candidate: id("candidate"),
    structured: id("structured"),
    label: id("label"),
    source: id("source"),
    inactive: id("inactive"),
  };
  await env.DB.batch([
    productStatement({ id: ids.verified, name: "Ledger matrix verified" }),
    productStatement({ id: ids.terminal, name: "Ledger matrix terminal" }),
    productStatement({ id: ids.stale, name: "Ledger matrix stale" }),
    productStatement({ id: ids.contradictory, name: "Ledger matrix contradictory" }),
    productStatement({ id: ids.conflictUnavailable, name: "Ledger matrix conflict unavailable" }),
    productStatement({ id: ids.unevidencedTerminal, name: "Ledger matrix unevidenced terminal" }),
    productStatement({ id: ids.lowAuthorityVerified, name: "Ledger matrix low authority" }),
    productStatement({ id: ids.conflict, name: "Ledger matrix conflict" }),
    productStatement({ id: ids.candidate, name: "Ledger matrix candidate" }),
    productStatement({ id: ids.structured, name: "Ledger matrix structured" }),
    productStatement({
      id: ids.label,
      name: "Ledger matrix label",
      nutritionImageUrl: "https://example.invalid/nutrition-label.jpg",
    }),
    productStatement({ id: ids.source, name: "Ledger matrix source" }),
    productStatement({ id: ids.inactive, name: "Ledger matrix inactive", active: false }),
    nutritionStatement(ids.verified, "verified", 100),
    nutritionStatement(ids.stale, "unverified", 20),
    nutritionStatement(ids.contradictory, "verified", 100),
    nutritionStatement(ids.conflictUnavailable, "conflict", 20),
    nutritionStatement(ids.lowAuthorityVerified, "verified", 20),
    nutritionStatement(ids.conflict, "conflict", 20),
    nutritionStatement(ids.structured, "unverified", 20),
    outcomeStatement(ids.terminal, "nutrition", "not_declared"),
    outcomeStatement(ids.stale, "nutrition", "verified"),
    outcomeStatement(ids.contradictory, "nutrition", "not_applicable"),
    outcomeStatement(ids.conflictUnavailable, "nutrition", "not_declared"),
    outcomeStatement(ids.unevidencedTerminal, "nutrition", "not_declared", ""),
    outcomeStatement(ids.inactive, "nutrition", "not_declared"),
  ]);

  const sourceId = await ensureRobotoffSource("nutrition");
  await sourceRecord({
    id: id("terminal-unrelated-source"),
    sourceId,
    productId: ids.terminal,
    sourceUrl: "https://example.invalid/unrelated-ranked-source",
  });
  await sourceRecord({
    id: id("candidate-subject"),
    sourceId,
    productId: ids.candidate,
    sourceUrl: "https://example.invalid/candidate-subject",
  });
  await sourceRecord({
    id: id("candidate-source"),
    sourceId,
    productId: ids.candidate,
    sourceUrl: "https://example.invalid/candidate-source",
  });
  const extraction = await currentExtraction({
    id: id("candidate-extraction"),
    family: "nutrition",
    productId: ids.candidate,
    subjectSourceRecordId: id("candidate-subject"),
    derivedSourceRecordId: id("candidate-source"),
    outcomes: ["candidate"],
  });
  await review({
    id: id("candidate-review"),
    productId: ids.candidate,
    sourceRecordId: id("candidate-source"),
    type: "nutrition_validation",
    evidence: { details: {
      extractionAttemptId: extraction.attemptId,
      labelAssetId: extraction.labelAssetIds[0],
      candidateHash: extraction.candidateHash,
    } },
  });
  return ids;
}

describe("completion ledger Worker API", () => {
  it("strictly partitions active products, fails closed, covers every lane, and excludes inactive products", async () => {
    const ids = await seedNutritionPartition("partition");
    const result = await ledger("family=nutrition&state=all&q=ledger+matrix&pageSize=100");

    expect(result.summary.verified + result.summary.terminalUnavailable + result.summary.outstanding)
      .toBe(result.summary.activeProducts);
    expect(result.summary.accounted).toBe(result.summary.activeProducts);
    expect(result.summary.invariantHolds).toBe(true);

    const byId = new Map(result.items.map((item) => [item.product.id, item]));
    expect([...byId]).toHaveLength(12);
    expect(byId.has(ids.inactive)).toBe(false);
    expect(byId.get(ids.verified)).toMatchObject({ state: "verified", lane: null });
    expect(byId.get(ids.terminal)).toMatchObject({
      state: "terminal_unavailable",
      lane: null,
      terminalOutcome: "not_declared",
      sourceUrl: "https://example.invalid/current-label.jpg",
      sourceId: null,
      sourceRecordId: null,
    });
    expect(byId.get(ids.stale)).toMatchObject({ state: "outstanding", lane: "evidence_inconsistent" });
    expect(byId.get(ids.contradictory)).toMatchObject({ state: "outstanding", lane: "evidence_inconsistent" });
    expect(byId.get(ids.conflictUnavailable)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
    expect(byId.get(ids.unevidencedTerminal)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
    expect(byId.get(ids.lowAuthorityVerified)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
    expect(byId.get(ids.conflict)).toMatchObject({ state: "outstanding", lane: "conflict_resolution" });
    expect(byId.get(ids.candidate)).toMatchObject({
      state: "outstanding",
      lane: "review_ready",
      openCandidateCount: 1,
      openReviewCount: 1,
      primaryReviewId: "ledger-matrix-partition-candidate-review",
    });
    expect(byId.get(ids.structured)).toMatchObject({ state: "outstanding", lane: "structured_evidence_review" });
    expect(byId.get(ids.label)).toMatchObject({
      state: "outstanding",
      lane: "run_extraction",
      labelUrl: "https://example.invalid/nutrition-label.jpg",
    });
    expect(byId.get(ids.source)).toMatchObject({ state: "outstanding", lane: "source_evidence_needed" });

    const outstanding = await ledger("family=nutrition&state=outstanding&q=ledger+matrix&pageSize=100");
    const laneRank = new Map([
      ["evidence_inconsistent", 0],
      ["conflict_resolution", 1],
      ["review_ready", 2],
      ["retry_extraction", 3],
      ["run_extraction", 4],
      ["manual_label_review", 5],
      ["structured_evidence_review", 6],
      ["source_evidence_needed", 7],
    ]);
    const ranks = outstanding.items.map(({ lane }) => laneRank.get(lane ?? "") ?? Number.POSITIVE_INFINITY);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
  });

  it("keeps strict family summaries in exact agreement with coverage", async () => {
    await seedNutritionPartition("agreement");
    const coverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    const [identity, nutrition, ingredients] = await Promise.all([
      ledger("family=identity&state=all&pageSize=1"),
      ledger("family=nutrition&state=all&pageSize=1"),
      ledger("family=ingredients&state=all&pageSize=1"),
    ]);

    expect(identity.summary.outstanding).toBe(coverage.completion.outstandingIdentity);
    expect(nutrition.summary.outstanding).toBe(coverage.completion.outstandingNutrition);
    expect(ingredients.summary.outstanding).toBe(coverage.completion.outstandingIngredients);
    for (const { summary } of [identity, nutrition, ingredients]) {
      expect(summary.verified + summary.terminalUnavailable + summary.outstanding).toBe(summary.activeProducts);
      expect(summary.invariantHolds).toBe(true);
    }
    expect(coverage.completion.status).toBe("incomplete");
  });

  it("applies family-specific strict evidence rules to ingredients and identity", async () => {
    const products = {
      ingredientVerified: "ledger-family-ingredient-verified",
      ingredientTerminal: "ledger-family-ingredient-terminal",
      ingredientCandidate: "ledger-family-ingredient-candidate",
      ingredientLabel: "ledger-family-ingredient-label",
      identityVerified: "ledger-family-identity-verified",
      identityUnavailable: "ledger-family-identity-unavailable",
      identityReview: "ledger-family-identity-review",
    };
    await env.DB.batch([
      productStatement({ id: products.ingredientVerified, name: "Ledger family ingredient verified" }),
      productStatement({ id: products.ingredientTerminal, name: "Ledger family ingredient terminal" }),
      productStatement({ id: products.ingredientCandidate, name: "Ledger family ingredient candidate" }),
      productStatement({
        id: products.ingredientLabel,
        name: "Ledger family ingredient label",
        ingredientImageUrl: "https://example.invalid/ingredient-label.jpg",
      }),
      productStatement({ id: products.identityVerified, name: "Ledger family identity verified" }),
      productStatement({ id: products.identityUnavailable, name: "Ledger family identity unavailable" }),
      productStatement({ id: products.identityReview, name: "Ledger family identity review" }),
      ingredientStatement(products.ingredientVerified, "verified", 100),
      outcomeStatement(products.ingredientTerminal, "ingredients", "not_applicable"),
      outcomeStatement(products.identityVerified, "identity", "verified"),
      outcomeStatement(products.identityUnavailable, "identity", "not_declared"),
    ]);
    const ingredientSource = await ensureRobotoffSource("ingredients");
    await sourceRecord({
      id: "ledger-family-ingredient-subject",
      sourceId: ingredientSource,
      productId: products.ingredientCandidate,
      sourceUrl: "https://example.invalid/ingredient-subject",
    });
    await sourceRecord({
      id: "ledger-family-ingredient-source",
      sourceId: ingredientSource,
      productId: products.ingredientCandidate,
      sourceUrl: "https://example.invalid/ingredient-candidate",
    });
    const ingredientExtraction = await currentExtraction({
      id: "ledger-family-ingredient-extraction",
      family: "ingredients",
      productId: products.ingredientCandidate,
      subjectSourceRecordId: "ledger-family-ingredient-subject",
      derivedSourceRecordId: "ledger-family-ingredient-source",
      outcomes: ["candidate"],
    });
    await review({
      id: "ledger-family-ingredient-review",
      productId: products.ingredientCandidate,
      sourceRecordId: "ledger-family-ingredient-source",
      type: "ingredient_conflict",
      evidence: { details: {
        extractionAttemptId: ingredientExtraction.attemptId,
        labelAssetId: ingredientExtraction.labelAssetIds[0],
        candidateHash: ingredientExtraction.candidateHash,
      } },
    });
    await sourceRecord({
      id: "ledger-family-identity-source",
      sourceId: ingredientSource,
      productId: products.identityReview,
      sourceUrl: "https://example.invalid/identity-source",
    });
    await review({
      id: "ledger-family-identity-review",
      productId: products.identityReview,
      sourceRecordId: "ledger-family-identity-source",
      type: "identity",
    });

    const ingredients = await ledger("family=ingredients&state=all&q=ledger+family+ingredient&pageSize=100");
    const ingredientById = new Map(ingredients.items.map((item) => [item.product.id, item]));
    expect(ingredientById.get(products.ingredientVerified)).toMatchObject({ state: "verified", lane: null });
    expect(ingredientById.get(products.ingredientTerminal)).toMatchObject({
      state: "terminal_unavailable",
      lane: null,
      terminalOutcome: "not_applicable",
    });
    expect(ingredientById.get(products.ingredientCandidate)).toMatchObject({
      state: "outstanding",
      lane: "review_ready",
      openCandidateCount: 1,
      primaryReviewId: "ledger-family-ingredient-review",
    });
    expect(ingredientById.get(products.ingredientLabel)).toMatchObject({
      state: "outstanding",
      lane: "run_extraction",
      labelUrl: "https://example.invalid/ingredient-label.jpg",
    });

    const identity = await ledger("family=identity&state=all&q=ledger+family+identity&pageSize=100");
    const identityById = new Map(identity.items.map((item) => [item.product.id, item]));
    expect(identityById.get(products.identityVerified)).toMatchObject({ state: "verified", lane: null });
    expect(identityById.get(products.identityUnavailable)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
    expect(identityById.get(products.identityReview)).toMatchObject({
      state: "outstanding",
      lane: "source_evidence_needed",
      openReviewCount: 1,
      openCandidateCount: 0,
      primaryReviewId: null,
      primaryActionId: products.identityReview,
    });
  });

  it("does not multiply a product with multiple sources and reviews", async () => {
    const productId = "ledger-multiply-product";
    await env.DB.batch([
      productStatement({
        id: productId,
        name: "Ledger multiply unique",
        nutritionImageUrl: "https://example.invalid/multiply-label.jpg",
      }),
    ]);
    const robotoff = await ensureRobotoffSource("nutrition");
    await sourceRecord({
      id: "ledger-multiply-source-a",
      sourceId: robotoff,
      productId,
      sourceUrl: "https://example.invalid/source-a",
      observedAt: "2026-07-17T10:00:00.000Z",
    });
    await sourceRecord({
      id: "ledger-multiply-source-b",
      sourceId: robotoff,
      productId,
      sourceUrl: "https://example.invalid/source-b",
      observedAt: "2026-07-17T11:00:00.000Z",
    });
    await sourceRecord({
      id: "ledger-multiply-source-c",
      sourceId: robotoff,
      productId,
      sourceUrl: "https://example.invalid/source-c",
      observedAt: "2026-07-17T11:00:00.000Z",
    });
    await sourceRecord({
      id: "ledger-multiply-subject",
      sourceId: robotoff,
      productId,
      sourceUrl: "https://example.invalid/subject",
    });
    const extraction = await currentExtraction({
      id: "ledger-multiply-extraction",
      family: "nutrition",
      productId,
      subjectSourceRecordId: "ledger-multiply-subject",
      derivedSourceRecordId: "ledger-multiply-source-a",
      outcomes: ["candidate"],
    });
    await review({
      id: "ledger-multiply-review-b",
      productId,
      sourceRecordId: "ledger-multiply-source-b",
      type: "nutrition_validation",
      priority: 50,
    });
    await review({
      id: "ledger-multiply-review-a",
      productId,
      sourceRecordId: "ledger-multiply-source-a",
      type: "nutrition_validation",
      priority: 80,
      evidence: { details: {
        extractionAttemptId: extraction.attemptId,
        labelAssetId: extraction.labelAssetIds[0],
        candidateHash: extraction.candidateHash,
      } },
    });
    await review({
      id: "ledger-multiply-gap",
      productId,
      sourceRecordId: "ledger-multiply-source-c",
      type: "coverage_gap",
      priority: 90,
    });

    const first = await ledger("family=nutrition&state=outstanding&q=ledger+multiply&pageSize=100");
    const second = await ledger("family=nutrition&state=outstanding&q=ledger+multiply&pageSize=100");
    expect(first.pagination.total).toBe(1);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      product: { id: productId },
      lane: "review_ready",
      openCandidateCount: 1,
      openReviewCount: 3,
      primaryReviewId: "ledger-multiply-review-a",
      primaryActionId: "ledger-multiply-review-a",
    });
    expect(second.items).toEqual(first.items);
    const exactReview = await json<{ items: Array<{ id: string }> }>(await worker.fetch(
      "http://localhost/api/reviews?status=open&type=nutrition_validation&id=ledger-multiply-review-a&page=1&pageSize=50",
    ));
    expect(exactReview.items.map(({ id }) => id)).toEqual(["ledger-multiply-review-a"]);
  });

  it("routes current mixed label outcomes, exposes bounded exact labels, and fails stale hashes closed", async () => {
    const sourceId = await ensureRobotoffSource("nutrition");
    const products = {
      mixed: "ledger-outcome-mixed",
      retry: "ledger-outcome-retry",
      manual: "ledger-outcome-manual",
      stale: "ledger-outcome-stale",
    };
    await env.DB.batch(Object.entries(products).map(([name, id]) => productStatement({
      id,
      name: `Ledger outcome ${name}`,
      nutritionImageUrl: `https://example.invalid/${name}-label.jpg`,
    })));
    for (const [name, productId] of Object.entries(products)) {
      await sourceRecord({
        id: `${productId}-subject`,
        sourceId,
        productId,
        sourceUrl: `https://example.invalid/${name}-subject`,
      });
      await sourceRecord({
        id: `${productId}-derived`,
        sourceId,
        productId,
        sourceUrl: `https://example.invalid/${name}-derived`,
      });
    }
    const mixed = await currentExtraction({
      id: "ledger-outcome-mixed-extraction",
      family: "nutrition",
      productId: products.mixed,
      subjectSourceRecordId: `${products.mixed}-subject`,
      derivedSourceRecordId: `${products.mixed}-derived`,
      outcomes: ["no_prediction", "candidate", "failed"],
    });
    await review({
      id: "ledger-outcome-mixed-review",
      productId: products.mixed,
      sourceRecordId: `${products.mixed}-derived`,
      type: "nutrition_validation",
      evidence: { details: {
        extractionAttemptId: mixed.attemptId,
        labelAssetId: mixed.candidateLabelAssetId,
        candidateHash: mixed.candidateHash,
      } },
    });
    await currentExtraction({
      id: "ledger-outcome-retry-extraction",
      family: "nutrition",
      productId: products.retry,
      subjectSourceRecordId: `${products.retry}-subject`,
      outcomes: ["failed"],
    });
    await currentExtraction({
      id: "ledger-outcome-manual-extraction",
      family: "nutrition",
      productId: products.manual,
      subjectSourceRecordId: `${products.manual}-subject`,
      outcomes: ["no_prediction", "rejected"],
    });
    const stale = await currentExtraction({
      id: "ledger-outcome-stale-extraction",
      family: "nutrition",
      productId: products.stale,
      subjectSourceRecordId: `${products.stale}-subject`,
      outcomes: ["no_prediction"],
    });
    await env.DB.prepare("UPDATE extraction_attempts SET is_current = 0 WHERE id = ?")
      .bind(stale.attemptId).run();

    const result = await ledger("family=nutrition&state=outstanding&q=ledger+outcome&pageSize=100");
    expect(result.items).toHaveLength(4);
    const byId = new Map(result.items.map((item) => [item.product.id, item]));
    expect(byId.get(products.mixed)).toMatchObject({
      lane: "review_ready",
      primaryReviewId: "ledger-outcome-mixed-review",
      primaryActionId: "ledger-outcome-mixed-review",
      extraction: { labels: 3, candidate: 1, noPrediction: 1, failed: 1, unattempted: 0, stale: 0 },
      labelsTruncated: false,
    });
    expect(byId.get(products.mixed)?.labels.map(({ sourceImageId, outcome }) => [sourceImageId, outcome]))
      .toEqual([["image-0", "no_prediction"], ["image-1", "candidate"], ["image-2", "failed"]]);
    expect(byId.get(products.retry)).toMatchObject({ lane: "retry_extraction", extraction: { failed: 1 } });
    expect(byId.get(products.manual)).toMatchObject({
      lane: "manual_label_review",
      extraction: { labels: 2, noPrediction: 1, rejected: 1 },
    });
    expect(byId.get(products.stale)).toMatchObject({
      lane: "run_extraction",
      extraction: { labels: 0, unattempted: 1, stale: 1 },
      primaryActionId: products.stale,
    });

    const labelPages = await Promise.all([1, 2, 3].map(async (page) => {
      const response = await worker.fetch(`http://localhost/api/completion-ledger/${products.mixed}/labels?family=nutrition&page=${page}&pageSize=1`);
      expect(response.status).toBe(200);
      return json<{ items: Array<{ labelAssetId: string }>; pagination: { total: number; pages: number } }>(response);
    }));
    expect(labelPages.every(({ pagination }) => pagination.total === 3 && pagination.pages === 3)).toBe(true);
    expect(new Set(labelPages.flatMap(({ items }) => items.map(({ labelAssetId }) => labelAssetId))).size).toBe(3);
    for (const query of ["family=identity", "page=0", "pageSize=101"]) {
      const response = await worker.fetch(`http://localhost/api/completion-ledger/${products.mixed}/labels?${query}`);
      expect(response.status).toBe(400);
    }
  });

  it("requires current exact linkage for verified Robotoff provenance", async () => {
    const sourceId = await ensureRobotoffSource("nutrition");
    const linkedProduct = "ledger-verified-linked";
    const legacyProduct = "ledger-verified-legacy";
    await env.DB.batch([
      productStatement({ id: linkedProduct, name: "Ledger verified linked" }),
      productStatement({ id: legacyProduct, name: "Ledger verified legacy" }),
    ]);
    for (const productId of [linkedProduct, legacyProduct]) {
      await sourceRecord({
        id: `${productId}-subject`,
        sourceId,
        productId,
        sourceUrl: `https://example.invalid/${productId}-subject`,
      });
      await sourceRecord({
        id: `${productId}-derived`,
        sourceId,
        productId,
        sourceUrl: `https://example.invalid/${productId}-derived`,
      });
      await env.DB.prepare(`INSERT INTO nutrition_facts
        (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
          calories, protein_grams, observed_at, updated_at)
        VALUES (?, ?, 'verified', 'high', 100, 'per_100g', 'as_sold', 400, 20, ?, ?)`)
        .bind(productId, `${productId}-derived`, observedAt, observedAt).run();
    }
    const extraction = await currentExtraction({
      id: "ledger-verified-linked-extraction",
      family: "nutrition",
      productId: linkedProduct,
      subjectSourceRecordId: `${linkedProduct}-subject`,
      derivedSourceRecordId: `${linkedProduct}-derived`,
      outcomes: ["candidate"],
    });
    await env.DB.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active, extraction_attempt_id, label_asset_id)
      SELECT 'ledger-verified-linked-decision', source_id, source_record_id, id, content_hash, product_id,
        ?, 'nutrition', 'verify', '{}', 'https://example.invalid/verified-label.jpg',
        'Exact current label verification', 'completion_test', ?, 1, ?, ?
      FROM source_records WHERE id = ?`)
      .bind(extraction.candidateHash, observedAt, extraction.attemptId,
        extraction.candidateLabelAssetId, `${linkedProduct}-derived`).run();
    await sourceRecord({
      id: `${legacyProduct}-other-derived`,
      sourceId,
      productId: legacyProduct,
      sourceUrl: `https://example.invalid/${legacyProduct}-other-derived`,
    });
    const otherExtraction = await currentExtraction({
      id: "ledger-verified-legacy-other-extraction",
      family: "nutrition",
      productId: legacyProduct,
      subjectSourceRecordId: `${legacyProduct}-subject`,
      derivedSourceRecordId: `${legacyProduct}-other-derived`,
      outcomes: ["candidate"],
    });
    await env.DB.prepare(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active, extraction_attempt_id, label_asset_id)
      SELECT 'ledger-verified-legacy-other-decision', source_id, source_record_id, id, content_hash, product_id,
        ?, 'nutrition', 'verify', '{}', 'https://example.invalid/other-label.jpg',
        'Exact other-source verification', 'completion_test', ?, 1, ?, ?
      FROM source_records WHERE id = ?`)
      .bind(otherExtraction.candidateHash, observedAt, otherExtraction.attemptId,
        otherExtraction.candidateLabelAssetId, `${legacyProduct}-other-derived`).run();

    const current = await ledger("family=nutrition&state=all&q=ledger+verified&pageSize=100");
    const currentById = new Map(current.items.map((entry) => [entry.product.id, entry]));
    expect(currentById.get(linkedProduct)).toMatchObject({ state: "verified", lane: null });
    expect(currentById.get(legacyProduct)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });

    await env.DB.prepare("UPDATE extraction_attempts SET is_current = 0 WHERE id = ?")
      .bind(extraction.attemptId).run();
    const stale = await ledger("family=nutrition&state=all&q=ledger+verified+linked&pageSize=100");
    expect(stale.items[0]).toMatchObject({
      product: { id: linkedProduct },
      state: "outstanding",
      lane: "evidence_inconsistent",
      extraction: { stale: 1 },
    });
  });

  it("fails terminal-unavailable provenance closed when its source record advances", async () => {
    const productId = "ledger-terminal-source-revision";
    const sourceId = "completion-official-terminal";
    const sourceRecordId = `${productId}-source`;
    await env.DB.batch([
      productStatement({ id: productId, name: "Ledger terminal source revision" }),
      env.DB.prepare(`INSERT OR IGNORE INTO sources
        (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
          retention_notes, created_at)
        VALUES (?, 'Completion official terminal', 'official', 100, 100, 100,
          'Exact authoritative test source', ?)`)
        .bind(sourceId, observedAt),
    ]);
    await sourceRecord({
      id: sourceRecordId,
      sourceId,
      productId,
      sourceUrl: "https://example.invalid/official-terminal",
    });
    await outcomeStatement(productId, "nutrition", "not_declared").run();
    await env.DB.prepare(`UPDATE evidence_outcomes SET source_record_id = ? WHERE product_id = ? AND field_family = 'nutrition'`)
      .bind(sourceRecordId, productId).run();

    const current = await ledger("family=nutrition&state=all&q=ledger+terminal+source+revision&pageSize=10");
    expect(current.items[0]).toMatchObject({ state: "terminal_unavailable", lane: null });

    await env.DB.prepare("UPDATE source_records SET observed_at = '2026-07-18T00:00:00.000Z' WHERE id = ?")
      .bind(sourceRecordId).run();
    const stale = await ledger("family=nutrition&state=all&q=ledger+terminal+source+revision&pageSize=10");
    expect(stale.items[0]).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
  });

  it("paginates a total ordering without duplicates and bounds result rows", async () => {
    const pageIds = ["e", "c", "a", "d", "b"].map((suffix) => `ledger-page-${suffix}`);
    await env.DB.batch(pageIds.map((id) => productStatement({ id, name: "Ledger page identical" })));

    const pages = await Promise.all([1, 2, 3].map((page) => ledger(
      `family=nutrition&state=outstanding&lane=source_evidence_needed&q=ledger+page&page=${page}&pageSize=2`,
    )));
    expect(pages.map(({ items }) => items.length)).toEqual([2, 2, 1]);
    expect(pages.every(({ pagination }) => pagination.total === 5 && pagination.pages === 3)).toBe(true);
    const traversed = pages.flatMap(({ items }) => items.map(({ product }) => product.id));
    expect(traversed).toEqual([...pageIds].sort());
    expect(new Set(traversed).size).toBe(5);

    const bulk = Array.from({ length: 105 }, (_, index) => {
      const suffix = String(index).padStart(3, "0");
      return productStatement({ id: `ledger-bound-${suffix}`, name: `Ledger bound ${suffix}` });
    });
    for (let index = 0; index < bulk.length; index += 50) {
      await env.DB.batch(bulk.slice(index, index + 50));
    }
    const first = await ledger("family=nutrition&state=outstanding&q=ledger+bound&page=1&pageSize=100");
    const second = await ledger("family=nutrition&state=outstanding&q=ledger+bound&page=2&pageSize=100");
    expect(first.items).toHaveLength(100);
    expect(second.items).toHaveLength(5);
    expect(first.pagination).toEqual({ page: 1, pageSize: 100, total: 105, pages: 2 });
  });

  it("keeps completion review accounting set based in the local D1 plan", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${completionSummaryQuery("nutrition")}`)
      .all<{ detail: string }>();
    const details = plan.results.map(({ detail }) => detail).join("\n");
    expect(details).not.toContain("CORRELATED");
    expect(details).toContain("idx_review_status_type_priority");
    expect(details).toContain("idx_products_active_search");
  });

  it("validates every bounded ledger filter", async () => {
    for (const query of [
      "family=unknown",
      "state=unknown",
      "lane=unknown",
      "page=0",
      "page=1.5",
      "pageSize=0",
      "pageSize=101",
      `q=${"x".repeat(201)}`,
      "q=one+two+three+four+five+six+seven+eight+nine+ten+eleven+twelve+thirteen",
    ]) {
      const response = await worker.fetch(`http://localhost/api/completion-ledger?${query}`);
      expect(response.status, query).toBe(400);
      expect(await json<{ error: { code: string } }>(response)).toMatchObject({
        error: { code: "validation_error" },
      });
    }
  });
});
