import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CatalogResponse, CoverageResponse } from "../shared/api";

const worker = exports.default;
const hash = (value: string) => value.repeat(64);

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

describe("machine-verified nutrition evidence", () => {
  it("uses a current exact-label projection for discovery without granting strict trust", async () => {
    const subject = await env.DB.prepare(`SELECT p.id AS product_id, s.id AS source_record_id, s.content_hash,
        n.status AS nutrition_status, n.calories, n.protein_grams
      FROM products p JOIN source_records s ON s.product_id = p.id
      LEFT JOIN nutrition_facts n ON n.product_id = p.id
      WHERE p.is_active = 1 ORDER BY p.id, s.id LIMIT 1`)
      .first<{ product_id: string; source_record_id: string; content_hash: string; nutrition_status: string | null; calories: number | null; protein_grams: number | null }>();
    if (!subject) throw new Error("Expected a seeded source record");
    const beforeCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    await env.DB.batch([
      env.DB.prepare("UPDATE products SET marketed_protein = 1 WHERE id = ?").bind(subject.product_id),
      env.DB.prepare(`INSERT INTO label_evidence_assets
        (id, subject_source_record_id, subject_source_content_hash, product_id, field_family, source_image_id,
         source_image_revision, requested_url, effective_url, content_sha256, byte_length, media_type, fetched_at)
        VALUES ('machine-label-api', ?, ?, ?, 'nutrition', 'machine-api-image', '1',
          'https://images.openfoodfacts.org/machine-api.jpg', 'https://images.openfoodfacts.org/machine-api.jpg',
          ?, 1024, 'image/jpeg', '2026-07-18T00:00:00.000Z')`)
        .bind(subject.source_record_id, subject.content_hash, subject.product_id, hash("a")),
      env.DB.prepare(`INSERT INTO machine_nutrition_verifications
        (id, product_id, subject_source_record_id, subject_source_content_hash, label_asset_id, label_content_sha256,
         source_image_revision, basis, calories, protein_grams, ocr_engine, ocr_version, ocr_output_sha256,
         model_id, model_digest, model_output_sha256, prompt_sha256, normalizer_version,
         normalized_result_sha256, validator_version, validation_report_sha256, release_manifest_sha256, verified_at)
        VALUES ('machine-api', ?, ?, ?, 'machine-label-api', ?, '1', 'per_100g', 360, 52,
          'macos_vision', 'accurate', ?, 'qwen3-vl:32b-instruct', ?, ?, ?, 'machine-label-v4', ?,
          'nutrition-v1', ?, ?, '2026-07-18T00:00:00.000Z')`)
        .bind(subject.product_id, subject.source_record_id, subject.content_hash, hash("a"), hash("b"), hash("c"), hash("d"), hash("e"), hash("f"), hash("0"), hash("1")),
    ]);
    const catalog = await json<CatalogResponse>(await worker.fetch("http://localhost/api/products?scope=all&pageSize=100"));
    expect(catalog.products.find(({ id }) => id === subject.product_id)).toMatchObject({
      nutritionStatus: "machine_verified", nutritionEvidenceAuthority: "machine_verified_label",
      nutrition: { calories: 360, proteinGrams: 52 },
      metrics: { proteinPer100Calories: { value: expect.closeTo(14.44, 2) } },
    });
    const afterCoverage = await json<CoverageResponse>(await worker.fetch("http://localhost/api/coverage"));
    const rawCountedUnverified = subject.nutrition_status === "unverified" || subject.nutrition_status === "verified";
    const rawUsableForProteinBrand = rawCountedUnverified && (subject.calories ?? 0) > 0 && (subject.protein_grams ?? -1) >= 0;
    expect(afterCoverage.catalog.machineVerifiedNutrition).toBe(beforeCoverage.catalog.machineVerifiedNutrition + 1);
    expect(afterCoverage.catalog.unverifiedNutrition).toBe(beforeCoverage.catalog.unverifiedNutrition - (rawCountedUnverified ? 1 : 0));
    expect(afterCoverage.catalog.proteinBrandedWithUsableNutrition).toBe(beforeCoverage.catalog.proteinBrandedWithUsableNutrition + (rawUsableForProteinBrand ? 0 : 1));
    const strict = await json<CatalogResponse>(await worker.fetch("http://localhost/api/products?trust=strict&scope=all&pageSize=100"));
    expect(strict.products.map(({ id }) => id)).not.toContain(subject.product_id);

    await env.DB.prepare(`INSERT INTO label_evidence_assets
      (id, subject_source_record_id, subject_source_content_hash, product_id, field_family, source_image_id,
       source_image_revision, requested_url, effective_url, content_sha256, byte_length, media_type, fetched_at)
      VALUES ('machine-label-api-newer', ?, ?, ?, 'nutrition', 'machine-api-image', '2',
        'https://images.openfoodfacts.org/machine-api-newer.jpg', 'https://images.openfoodfacts.org/machine-api-newer.jpg',
        ?, 1024, 'image/jpeg', '2026-07-19T00:00:00.000Z')`)
      .bind(subject.source_record_id, subject.content_hash, subject.product_id, hash("9")).run();
    const stale = await json<CatalogResponse>(await worker.fetch("http://localhost/api/products?scope=all&verification=unverified&pageSize=100"));
    expect(stale.products.find(({ id }) => id === subject.product_id)?.nutritionStatus).toBe("unverified");
  });
});
