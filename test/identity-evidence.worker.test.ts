import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CompletionLedgerResponse } from "../shared/api";
import { resolveReview } from "../worker/reviews";

const worker = exports.default;

interface CurrentBinding {
  product_id: string;
  source_record_id: string;
  source_record_key: string;
  identity_hash: string;
  source_url: string;
}

type CurrentBindingRow = Omit<CurrentBinding, "source_url"> & { source_url: string | null };

async function json<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json() as Promise<T>;
}

async function availableBinding(exceptProductId: string | null = null): Promise<CurrentBinding> {
  const row = await env.DB.prepare(`SELECT p.id AS product_id, record.id AS source_record_id,
    record.source_record_id AS source_record_key, record.identity_hash, record.source_url
    FROM products p
    JOIN source_records record ON record.product_id = p.id
    WHERE p.is_active = 1
      AND length(record.identity_hash) = 64
      AND (? IS NULL OR p.id <> ?)
      AND NOT EXISTS (
        SELECT 1 FROM identity_evidence_decisions decision
        WHERE decision.product_id = p.id AND decision.source_record_id = record.id
          AND decision.identity_hash = record.identity_hash
      )
      AND NOT EXISTS (
        SELECT 1 FROM review_items review
        WHERE review.source_record_id = record.id AND review.type = 'identity'
      )
    ORDER BY p.id, record.id LIMIT 1`)
    .bind(exceptProductId, exceptProductId)
    .first<CurrentBindingRow>();
  if (!row) throw new Error("Expected an available exact identity binding");
  if (row.source_url) return { ...row, source_url: row.source_url };
  const sourceUrl = `https://example.invalid/source/${encodeURIComponent(row.source_record_id)}`;
  await env.DB.prepare("UPDATE source_records SET source_url = ? WHERE id = ?")
    .bind(sourceUrl, row.source_record_id).run();
  return { ...row, source_url: sourceUrl };
}

function verifyRequest(
  productId: string,
  body: Record<string, unknown>,
  origin = "http://localhost",
): Promise<Response> {
  return worker.fetch(`${origin}/api/products/${productId}/identity-evidence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("identity evidence Worker contract", () => {
  it("keeps the mutation local-only and rejects malformed or cross-product bindings", async () => {
    const first = await availableBinding();
    const second = await availableBinding(first.product_id);
    const body = {
      sourceRecordId: first.source_record_id,
      evidenceUrl: first.source_url,
      rationale: "The exact current package label confirms this identity.",
    };

    const remote = await verifyRequest(first.product_id, body, "https://protein.example.invalid");
    expect(remote.status).toBe(403);
    expect(await json<{ error: { code: string } }>(remote)).toMatchObject({
      error: { code: "mutations_disabled" },
    });

    const insecure = await verifyRequest(first.product_id, { ...body, evidenceUrl: "http://example.invalid/label.jpg" });
    expect(insecure.status).toBe(400);
    const unsupported = await verifyRequest(first.product_id, { ...body, unexpected: true });
    expect(unsupported.status).toBe(400);
    const crossProduct = await verifyRequest(first.product_id, { ...body, sourceRecordId: second.source_record_id });
    expect(crossProduct.status).toBe(400);
    const unrelated = await verifyRequest(first.product_id, {
      ...body,
      evidenceUrl: "https://unrelated.example/identity-label.jpg",
    });
    expect(unrelated.status).toBe(400);
    const missing = await verifyRequest("missing-product", body);
    expect(missing.status).toBe(404);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM identity_evidence_decisions
      WHERE source_record_id IN (?, ?)`)
      .bind(first.source_record_id, second.source_record_id)
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("atomically creates one exact decision and projection, retries idempotently, and rejects conflicts", async () => {
    const binding = await availableBinding();
    const body = {
      sourceRecordId: binding.source_record_id,
      evidenceUrl: binding.source_url,
      rationale: "Every visible identity field matches the exact current package.",
    };
    const created = await verifyRequest(binding.product_id, body);
    expect(created.status).toBe(201);
    const createdBody = await json<{
      status: string;
      productId: string;
      sourceRecordId: string;
      decisionId: string;
      idempotent: boolean;
    }>(created);
    expect(createdBody).toMatchObject({
      status: "verified",
      productId: binding.product_id,
      sourceRecordId: binding.source_record_id,
      idempotent: false,
    });
    expect(createdBody.decisionId).toMatch(/^ied_[a-f0-9]{24}$/);

    const retry = await verifyRequest(binding.product_id, body);
    expect(retry.status).toBe(200);
    expect(await json<typeof createdBody>(retry)).toEqual({ ...createdBody, idempotent: true });

    const durable = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM identity_evidence_decisions
        WHERE product_id = ? AND source_record_id = ?) AS decisions,
      (SELECT COUNT(*) FROM evidence_outcomes
        WHERE product_id = ? AND field_family = 'identity' AND outcome = 'verified'
          AND source_record_id = ? AND evidence_url = ?) AS outcomes`)
      .bind(
        binding.product_id,
        binding.source_record_id,
        binding.product_id,
        binding.source_record_id,
        body.evidenceUrl,
      )
      .first<{ decisions: number; outcomes: number }>();
    expect(durable).toEqual({ decisions: 1, outcomes: 1 });

    const alternateLabelUrl = "https://example.invalid/different-identity-label.jpg";
    const source = await env.DB.prepare("SELECT content_hash FROM source_records WHERE id = ?")
      .bind(binding.source_record_id).first<{ content_hash: string }>();
    if (!source) throw new Error("Expected current source content for alternate retained label");
    await env.DB.prepare(`INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id,
       field_family, source_image_id, source_image_revision, requested_url,
       effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES (?, ?, ?, ?, 'nutrition', 'identity-alternate', '1', ?, ?, ?, 1024,
        'image/jpeg', '2026-07-17T00:00:00.000Z')`)
      .bind(
        `identity-alternate-${binding.source_record_id}`,
        binding.source_record_id,
        source.content_hash,
        binding.product_id,
        alternateLabelUrl,
        alternateLabelUrl,
        "d".repeat(64),
      ).run();
    const conflicting = await verifyRequest(binding.product_id, { ...body, evidenceUrl: alternateLabelUrl });
    expect(conflicting.status).toBe(409);
    const preserved = await env.DB.prepare(`SELECT evidence_url, rationale
      FROM identity_evidence_decisions WHERE id = ?`)
      .bind(createdBody.decisionId)
      .first<{ evidence_url: string; rationale: string }>();
    expect(preserved).toEqual({ evidence_url: body.evidenceUrl, rationale: body.rationale });
  });

  it("moves missing or contradictory projections into evidence_inconsistent", async () => {
    const binding = await availableBinding();
    const verification = await verifyRequest(binding.product_id, {
      sourceRecordId: binding.source_record_id,
      evidenceUrl: binding.source_url,
      rationale: "The exact current label establishes the completion identity.",
    });
    expect(verification.status).toBe(201);

    const readLedger = async (): Promise<CompletionLedgerResponse> => json<CompletionLedgerResponse>(
      await worker.fetch("http://localhost/api/completion-ledger?family=identity&state=all&pageSize=100"),
    );
    const verified = await readLedger();
    expect(verified.items.find(({ product }) => product.id === binding.product_id)).toMatchObject({
      state: "verified",
      lane: null,
    });

    await env.DB.prepare("UPDATE source_records SET identity_hash = ? WHERE id = ?")
      .bind("e".repeat(64), binding.source_record_id).run();
    const sourceDrift = await readLedger();
    expect(sourceDrift.items.find(({ product }) => product.id === binding.product_id)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
    await env.DB.prepare("UPDATE source_records SET identity_hash = ? WHERE id = ?")
      .bind(binding.identity_hash, binding.source_record_id).run();

    await env.DB.prepare(`UPDATE evidence_outcomes SET notes = 'Contradictory projection bytes'
      WHERE product_id = ? AND field_family = 'identity'`)
      .bind(binding.product_id).run();
    const contradictory = await readLedger();
    expect(contradictory.items.find(({ product }) => product.id === binding.product_id)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });

    await env.DB.prepare("DELETE FROM evidence_outcomes WHERE product_id = ? AND field_family = 'identity'")
      .bind(binding.product_id).run();
    const missing = await readLedger();
    expect(missing.items.find(({ product }) => product.id === binding.product_id)).toMatchObject({
      state: "outstanding",
      lane: "evidence_inconsistent",
    });
  });

  it("rolls back an ambiguous match when the exact source binding changes before the batch", async () => {
    const review = await env.DB.prepare(`SELECT review.id, review.product_id,
      review.source_record_id, review.candidate_product_ids_json, record.identity_hash
      FROM review_items review
      JOIN source_records record ON record.id = review.source_record_id
      WHERE review.type = 'identity' AND review.status = 'open'
        AND json_array_length(review.candidate_product_ids_json) > 0
      ORDER BY review.id LIMIT 1`)
      .first<{
        id: string;
        product_id: string;
        source_record_id: string;
        candidate_product_ids_json: string;
        identity_hash: string;
      }>();
    if (!review) throw new Error("Expected an open ambiguous identity review");
    const candidateProductId = (JSON.parse(review.candidate_product_ids_json) as string[])[0];
    if (!candidateProductId) throw new Error("Expected an identity match candidate");
    let raced = false;
    const racingDb = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target.prepare("UPDATE source_records SET identity_hash = ? WHERE id = ?")
                .bind("f".repeat(64), review.source_record_id).run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

    const sourceEvidence = await env.DB.prepare("SELECT source_url FROM source_records WHERE id = ?")
      .bind(review.source_record_id).first<{ source_url: string | null }>();
    const evidenceUrl = sourceEvidence?.source_url ?? "https://example.invalid/ambiguous-source";
    if (!sourceEvidence?.source_url) {
      await env.DB.prepare("UPDATE source_records SET source_url = ? WHERE id = ?")
        .bind(evidenceUrl, review.source_record_id).run();
    }
    const result = await resolveReview(
      racingDb,
      review.id,
      "match",
      "The exact package identity matches the selected canonical product.",
      evidenceUrl,
      candidateProductId,
      null,
      null,
    );
    expect(result).toBe("invalid_candidate");
    expect(raced).toBe(true);

    const state = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM review_items WHERE id = ? AND status = 'open') AS open_reviews,
      (SELECT COUNT(*) FROM identity_decisions WHERE source_record_id = ?) AS resolutions,
      (SELECT COUNT(*) FROM identity_evidence_decisions WHERE source_record_id = ?) AS decisions,
      (SELECT COUNT(*) FROM evidence_outcomes WHERE source_record_id = ? AND field_family = 'identity') AS outcomes,
      (SELECT COUNT(*) FROM source_records WHERE id = ? AND product_id = ?) AS original_links`)
      .bind(
        review.id,
        review.source_record_id,
        review.source_record_id,
        review.source_record_id,
        review.source_record_id,
        review.product_id,
      )
      .first<Record<string, number>>();
    expect(state).toEqual({
      open_reviews: 1,
      resolutions: 0,
      decisions: 0,
      outcomes: 0,
      original_links: 1,
    });
  });
});
