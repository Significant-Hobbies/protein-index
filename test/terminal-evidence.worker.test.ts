import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  RecordTerminalEvidenceInput,
  RecordTerminalEvidenceResponse,
  TerminalEvidenceErrorResponse,
  TerminalEvidenceOptionsResponse,
} from "../shared/terminal-evidence";
import type { CompletionLedgerResponse, ProductDetailResponse } from "../shared/api";

const worker = exports.default;
const at = "2026-07-17T14:00:00.000Z";
const hash = (character: string): string => character.repeat(64);

async function json<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json() as Promise<T>;
}

async function seedProduct(id: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO products
    (id, brand, brand_normalized, name, name_normalized, category,
     classifier_version, created_at, updated_at, is_active)
    VALUES (?, 'Terminal Test', 'terminal test', ?, ?, 'other', 'protein-v1', ?, ?, 1)`)
    .bind(id, id, id.replaceAll("-", " "), at, at).run();
}

async function seedSource(input: {
  id: string;
  productId: string;
  authority: number;
  kind?: "official" | "brand" | "open_data";
  contentHash?: string;
}): Promise<void> {
  const run = await env.DB.prepare("SELECT id FROM ingestion_runs ORDER BY started_at LIMIT 1")
    .first<{ id: string }>();
  if (!run) throw new Error("Expected fixture ingestion run");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sources
      (id, name, kind, identity_authority, nutrition_authority, ingredient_authority,
       retention_notes, created_at)
      VALUES (?, ?, ?, 100, ?, ?, 'Terminal evidence fixture', ?)`)
      .bind(input.id, input.id, input.kind ?? "official", input.authority, input.authority, at),
    env.DB.prepare(`INSERT INTO source_records
      (id, source_id, source_record_id, product_id, source_url, content_hash,
       identity_hash, observed_at, first_seen_run_id, last_seen_run_id,
       raw_evidence_json, resolution_rule)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'exact_gtin')`)
      .bind(
        `${input.id}-record`,
        input.id,
        `${input.id}-key`,
        input.productId,
        `https://example.invalid/${input.id}`,
        input.contentHash ?? hash("a"),
        hash("9"),
        at,
        run.id,
        run.id,
      ),
  ]);
}

async function seedLabel(input: {
  id: string;
  sourceId: string;
  productId: string;
  family?: "nutrition" | "ingredients";
  contentSha?: string;
  fetchedAt?: string;
}): Promise<void> {
  const source = await env.DB.prepare("SELECT id, content_hash FROM source_records WHERE id = ?")
    .bind(`${input.sourceId}-record`).first<{ id: string; content_hash: string }>();
  if (!source) throw new Error("Expected terminal source record");
  await env.DB.prepare(`INSERT INTO label_evidence_assets
    (id, subject_source_record_id, subject_source_content_hash, product_id,
     field_family, source_image_id, source_image_revision, requested_url,
     effective_url, content_sha256, byte_length, media_type, fetched_at)
    VALUES (?, ?, ?, ?, ?, 'panel-1', 'rev-1', ?, ?, ?, 2048, 'image/jpeg', ?)`)
    .bind(
      input.id,
      source.id,
      source.content_hash,
      input.productId,
      input.family ?? "nutrition",
      `https://example.invalid/${input.id}.jpg`,
      `https://example.invalid/${input.id}.jpg`,
      input.contentSha ?? hash("b"),
      input.fetchedAt ?? at,
    ).run();
}

async function options(
  productId: string,
  family: "nutrition" | "ingredients" = "nutrition",
): Promise<TerminalEvidenceOptionsResponse> {
  const response = await worker.fetch(
    `http://localhost/api/products/${productId}/terminal-evidence?family=${family}`,
  );
  expect(response.status).toBe(200);
  return json<TerminalEvidenceOptionsResponse>(response);
}

function inputFromOption(
  option: TerminalEvidenceOptionsResponse["items"][number],
  input: Partial<RecordTerminalEvidenceInput> = {},
): RecordTerminalEvidenceInput {
  return {
    family: "nutrition",
    outcome: "not_declared",
    evidenceId: option.evidenceId,
    sourceContentHash: option.sourceContentHash,
    labelContentSha256: option.labelContentSha256,
    idempotencyKey: `terminal:${option.evidenceId.replace(":", ".")}`,
    rationale: "The complete current evidence contains no nutrition declaration.",
    supersedesDecisionId: null,
    ...input,
  };
}

async function postDecision(
  productId: string,
  input: RecordTerminalEvidenceInput | Record<string, unknown>,
): Promise<Response> {
  return worker.fetch(`http://localhost/api/products/${productId}/terminal-evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function completion(productId: string): Promise<CompletionLedgerResponse["items"][number]> {
  const response = await worker.fetch(
    `http://localhost/api/completion-ledger?family=nutrition&state=all&q=${encodeURIComponent(productId)}&pageSize=10`,
  );
  expect(response.status).toBe(200);
  const result = await json<CompletionLedgerResponse>(response);
  const item = result.items.find(({ product }) => product.id === productId);
  if (!item) throw new Error(`Expected completion row ${productId}`);
  return item;
}

describe("terminal evidence Worker contract", () => {
  it("enumerates only bounded current server evidence and keeps the review API local", async () => {
    const productId = "terminal-worker-enumeration";
    await seedProduct(productId);
    await seedSource({ id: "terminal-enumeration-source", productId, authority: 100 });
    await seedLabel({ id: "terminal-enumeration-label", sourceId: "terminal-enumeration-source", productId });

    const first = await worker.fetch(
      `http://localhost/api/products/${productId}/terminal-evidence?family=nutrition&page=1&pageSize=1`,
    );
    expect(first.status).toBe(200);
    const result = await json<TerminalEvidenceOptionsResponse>(first);
    expect(result.items).toHaveLength(1);
    expect(result.pagination).toEqual({ page: 1, pageSize: 1, total: 2, pages: 2 });
    expect(result.history).toEqual([]);
    expect(result.contradiction).toEqual({
      hasConflict: false,
      outcomes: [],
      factStatus: null,
      legacyProjection: false,
    });

    expect((await worker.fetch(
      `http://localhost/api/products/${productId}/terminal-evidence?family=nutrition&pageSize=101`,
    )).status).toBe(400);
    expect((await worker.fetch(
      `https://protein.example/api/products/${productId}/terminal-evidence?family=nutrition`,
    )).status).toBe(403);
  });

  it("exposes exact terminal ingredient evidence instead of a misleading raw status", async () => {
    const productId = "terminal-worker-ingredient-detail";
    await seedProduct(productId);
    await seedSource({ id: "terminal-ingredient-detail-source", productId, authority: 100 });
    const source = (await options(productId, "ingredients")).items.find(({ kind }) => kind === "source");
    if (!source) throw new Error("Expected authoritative ingredient source evidence");
    const response = await postDecision(productId, inputFromOption(source, {
      family: "ingredients",
      outcome: "not_declared",
      idempotencyKey: "terminal:worker:ingredient:detail",
      rationale: "The current authoritative record does not declare an ingredient statement.",
    }));
    expect(response.status).toBe(201);
    const detailResponse = await worker.fetch(`http://localhost/api/products/${productId}`);
    expect(detailResponse.status).toBe(200);
    const detail = await json<ProductDetailResponse>(detailResponse);
    expect(detail).toMatchObject({
      ingredientStatus: "missing",
      ingredientTerminalOutcome: "not_declared",
      ingredientEvidenceUrl: "https://example.invalid/terminal-ingredient-detail-source",
      ingredientEvidenceKind: "source",
    });
  });

  it("does not let community source metadata close a gap while retaining exact label evidence", async () => {
    const productId = "terminal-worker-community-boundary";
    await seedProduct(productId);
    await seedSource({
      id: "terminal-community-source",
      productId,
      authority: 40,
      kind: "open_data",
    });
    await seedLabel({
      id: "terminal-community-label",
      sourceId: "terminal-community-source",
      productId,
    });

    const listed = await options(productId);
    expect(listed.items.map(({ kind }) => kind)).toEqual(["label"]);
    const label = listed.items[0];
    if (!label) throw new Error("Expected exact retained label evidence");

    expect((await postDecision(productId, inputFromOption(label, {
      idempotencyKey: "terminal:worker:community:label",
    }))).status).toBe(201);
    expect(await completion(productId)).toMatchObject({
      state: "terminal_unavailable",
      lane: null,
      terminalOutcome: "not_declared",
    });
  });

  it("records exact label evidence idempotently and rejects stale, arbitrary, and remote input", async () => {
    const productId = "terminal-worker-label";
    await seedProduct(productId);
    await seedSource({ id: "terminal-label-source", productId, authority: 100 });
    await seedLabel({ id: "terminal-label-asset", sourceId: "terminal-label-source", productId });
    const listed = await options(productId);
    const label = listed.items.find(({ kind }) => kind === "label");
    if (!label) throw new Error("Expected current label option");
    const body = inputFromOption(label, { idempotencyKey: "terminal:worker:label" });

    const created = await postDecision(productId, body);
    expect(created.status).toBe(201);
    const createdBody = await json<RecordTerminalEvidenceResponse>(created);
    expect(createdBody).toMatchObject({ status: "created", decision: { outcome: "not_declared" } });
    const replay = await postDecision(productId, body);
    expect(replay.status).toBe(200);
    expect(await json<RecordTerminalEvidenceResponse>(replay)).toMatchObject({
      status: "existing",
      decision: { id: createdBody.decision.id },
    });
    expect(await completion(productId)).toMatchObject({
      state: "terminal_unavailable",
      lane: null,
      terminalOutcome: "not_declared",
    });

    const stale = await postDecision(productId, { ...body, sourceContentHash: hash("f") });
    expect(stale.status).toBe(409);
    expect(await json<TerminalEvidenceErrorResponse>(stale)).toMatchObject({
      error: { code: "stale_evidence", details: { evidenceId: body.evidenceId } },
    });
    expect((await postDecision(productId, { ...body, evidenceUrl: "https://arbitrary.invalid/proof" })).status).toBe(400);
    const remote = await worker.fetch(`https://protein.example/api/products/${productId}/terminal-evidence`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(remote.status).toBe(403);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM terminal_evidence_decisions
      WHERE product_id = ?`).bind(productId).first<{ count: number }>()).toEqual({ count: 1 });
  });

  it("preserves superseded history and fails conflicting current sources closed", async () => {
    const productId = "terminal-worker-contradiction";
    await seedProduct(productId);
    await seedSource({ id: "terminal-conflict-a", productId, authority: 100 });
    await seedSource({ id: "terminal-conflict-b", productId, authority: 100, contentHash: hash("c") });
    const listed = await options(productId);
    const sourceA = listed.items.find(({ evidenceId }) => evidenceId === "source:terminal-conflict-a-record");
    const sourceB = listed.items.find(({ evidenceId }) => evidenceId === "source:terminal-conflict-b-record");
    if (!sourceA || !sourceB) throw new Error("Expected independent source options");
    const originalResponse = await postDecision(productId, inputFromOption(sourceA, {
      idempotencyKey: "terminal:worker:conflict:a1",
    }));
    const original = await json<RecordTerminalEvidenceResponse>(originalResponse);
    const correctionBody = inputFromOption(sourceA, {
      outcome: "not_applicable",
      idempotencyKey: "terminal:worker:conflict:a2",
      supersedesDecisionId: original.decision.id,
    });
    expect((await postDecision(productId, correctionBody)).status).toBe(201);
    expect((await postDecision(productId, {
      ...inputFromOption(sourceA, { idempotencyKey: "terminal:worker:conflict:competing" }),
      supersedesDecisionId: original.decision.id,
    })).status).toBe(409);
    expect((await postDecision(productId, inputFromOption(sourceB, {
      idempotencyKey: "terminal:worker:conflict:b1",
    }))).status).toBe(201);

    const current = await options(productId);
    expect(current.contradiction).toMatchObject({
      hasConflict: true,
      outcomes: ["not_applicable", "not_declared"],
    });
    expect(current.history).toHaveLength(3);
    expect(current.history.find(({ decision }) => decision.id === original.decision.id)).toMatchObject({
      current: false,
      stale: false,
      superseded: true,
    });
    expect(await completion(productId)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
    expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'nutrition'`).bind(productId).first<{ count: number }>())
      .toEqual({ count: 0 });
  });

  it("falls back across sources and invalidates source, product, label, and verified-fact drift", async () => {
    const productId = "terminal-worker-drift";
    const otherProductId = "terminal-worker-drift-other";
    await seedProduct(productId);
    await seedProduct(otherProductId);
    await seedSource({ id: "terminal-drift-a", productId, authority: 100 });
    await seedSource({ id: "terminal-drift-b", productId, authority: 100, contentHash: hash("c") });
    const listed = await options(productId);
    const sourceA = listed.items.find(({ evidenceId }) => evidenceId === "source:terminal-drift-a-record");
    const sourceB = listed.items.find(({ evidenceId }) => evidenceId === "source:terminal-drift-b-record");
    if (!sourceA || !sourceB) throw new Error("Expected fallback evidence");
    expect((await postDecision(productId, inputFromOption(sourceA, {
      idempotencyKey: "terminal:worker:drift:a",
    }))).status).toBe(201);
    expect((await postDecision(productId, inputFromOption(sourceB, {
      idempotencyKey: "terminal:worker:drift:b",
    }))).status).toBe(201);

    await env.DB.prepare("UPDATE source_records SET content_hash = ? WHERE id = 'terminal-drift-a-record'")
      .bind(hash("d")).run();
    expect(await env.DB.prepare(`SELECT source_record_id FROM evidence_outcomes
      WHERE product_id = ? AND field_family = 'nutrition'`).bind(productId).first())
      .toEqual({ source_record_id: "terminal-drift-b-record" });
    expect(await completion(productId)).toMatchObject({ state: "terminal_unavailable", lane: null });

    await env.DB.prepare("UPDATE source_records SET product_id = ? WHERE id = 'terminal-drift-b-record'")
      .bind(otherProductId).run();
    expect(await completion(productId)).toMatchObject({ state: "outstanding", lane: "evidence_inconsistent" });
    await env.DB.prepare("UPDATE source_records SET product_id = ? WHERE id = 'terminal-drift-b-record'")
      .bind(productId).run();
    expect(await completion(productId)).toMatchObject({ state: "terminal_unavailable", lane: null });

    await env.DB.prepare(`INSERT INTO nutrition_facts
      (product_id, status, confidence, authority, basis, preparation_state,
       calories, protein_grams, observed_at, updated_at)
      VALUES (?, 'verified', 'high', 100, 'per_100g', 'as_sold', 300, 20, ?, ?)`)
      .bind(productId, at, at).run();
    expect(await completion(productId)).toMatchObject({ state: "outstanding", lane: "evidence_inconsistent" });

    await env.DB.prepare("UPDATE source_records SET content_hash = ? WHERE id = 'terminal-drift-b-record'")
      .bind(hash("e")).run();
    await env.DB.prepare("UPDATE nutrition_facts SET source_record_id = ? WHERE product_id = ?")
      .bind("terminal-drift-b-record", productId).run();
    expect(await completion(productId)).toMatchObject({ state: "verified", lane: null });
    expect(await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM terminal_evidence_decisions WHERE product_id = ?) AS historical_terminal,
      (SELECT COUNT(*) FROM current_terminal_evidence_decisions WHERE product_id = ?) AS current_terminal,
      (SELECT COUNT(*) FROM current_verified_nutrition_facts WHERE product_id = ?) AS current_verified`)
      .bind(productId, productId, productId).first())
      .toEqual({ historical_terminal: 2, current_terminal: 0, current_verified: 1 });

    const labelProduct = "terminal-worker-label-drift";
    await seedProduct(labelProduct);
    await seedSource({ id: "terminal-label-drift-source", productId: labelProduct, authority: 100 });
    await seedLabel({
      id: "terminal-label-drift-v1",
      sourceId: "terminal-label-drift-source",
      productId: labelProduct,
      contentSha: hash("1"),
      fetchedAt: "2026-07-17T14:00:00.000Z",
    });
    const firstLabel = (await options(labelProduct)).items.find(({ kind }) => kind === "label");
    if (!firstLabel) throw new Error("Expected first label");
    expect((await postDecision(labelProduct, inputFromOption(firstLabel, {
      idempotencyKey: "terminal:worker:label-drift",
    }))).status).toBe(201);
    await seedLabel({
      id: "terminal-label-drift-v2",
      sourceId: "terminal-label-drift-source",
      productId: labelProduct,
      contentSha: hash("2"),
      fetchedAt: "2026-07-17T15:00:00.000Z",
    });
    const labelHistory = await options(labelProduct);
    expect(labelHistory.history[0]).toMatchObject({ current: false, stale: true, superseded: false });
    expect(await completion(labelProduct)).toMatchObject({ state: "outstanding", lane: "evidence_inconsistent" });
  });
});
