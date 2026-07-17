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
      `content-${input.id}`,
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
}): Promise<void> {
  await env.DB.prepare(`INSERT INTO review_items
    (id, type, priority, status, source_record_id, product_id,
      candidate_product_ids_json, evidence_json, created_at)
    VALUES (?, ?, ?, 'open', ?, ?, '[]', '{}', ?)`)
    .bind(input.id, input.type, input.priority ?? 50, input.sourceRecordId, input.productId, observedAt)
    .run();
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
    id: id("candidate-source"),
    sourceId,
    productId: ids.candidate,
    sourceUrl: "https://example.invalid/candidate-source",
  });
  await review({
    id: id("candidate-review"),
    productId: ids.candidate,
    sourceRecordId: id("candidate-source"),
    type: "nutrition_validation",
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
      lane: "label_evidence_review",
      labelUrl: "https://example.invalid/nutrition-label.jpg",
    });
    expect(byId.get(ids.source)).toMatchObject({ state: "outstanding", lane: "source_evidence_needed" });

    const outstanding = await ledger("family=nutrition&state=outstanding&q=ledger+matrix&pageSize=100");
    const laneRank = new Map([
      ["evidence_inconsistent", 0],
      ["conflict_resolution", 1],
      ["review_ready", 2],
      ["structured_evidence_review", 3],
      ["label_evidence_review", 4],
      ["source_evidence_needed", 5],
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
      id: "ledger-family-ingredient-source",
      sourceId: ingredientSource,
      productId: products.ingredientCandidate,
      sourceUrl: "https://example.invalid/ingredient-candidate",
    });
    await review({
      id: "ledger-family-ingredient-review",
      productId: products.ingredientCandidate,
      sourceRecordId: "ledger-family-ingredient-source",
      type: "ingredient_conflict",
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
      lane: "label_evidence_review",
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
      primaryReviewId: "ledger-family-identity-review",
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
      openCandidateCount: 2,
      openReviewCount: 3,
      primaryReviewId: "ledger-multiply-gap",
    });
    expect(second.items).toEqual(first.items);
    const exactReview = await json<{ items: Array<{ id: string }> }>(await worker.fetch(
      "http://localhost/api/reviews?status=open&type=coverage_gap&id=ledger-multiply-gap&page=1&pageSize=50",
    ));
    expect(exactReview.items.map(({ id }) => id)).toEqual(["ledger-multiply-gap"]);
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
