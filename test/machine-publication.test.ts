import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertMachineBenchmarkReport, emitMachineNutritionSql, emitMachinePublicationBatch } from "../scripts/machine-publication";

describe("machine nutrition publication", () => {
  it("requires a clean benchmark from the same local adapter before CLI publication", () => {
    expect(() => assertMachineBenchmarkReport({ passed: true, adapterVersion: "machine-label-v4", cases: [{ errors: [] }, { errors: [] }] }, "machine-label-v4")).not.toThrow();
    expect(() => assertMachineBenchmarkReport({ passed: true, adapterVersion: "machine-label-v3", cases: [{ errors: [] }, { errors: [] }] }, "machine-label-v4")).toThrow("passing benchmark");
    expect(() => assertMachineBenchmarkReport({ passed: false, adapterVersion: "machine-label-v4", cases: [{ errors: [] }, { errors: [] }] }, "machine-label-v4")).toThrow("passing benchmark");
  });

  it("refuses rejected artifacts and emits a content-addressed immutable insert", () => {
    const artifact = { adapterVersion: "machine-label-v4", image: { contentSha256: "a".repeat(64) }, generatedAt: "2026-07-18T00:00:00.000Z", vision: { engine: "macos_vision", version: "accurate", lines: [] }, model: { model: "qwen3-vl:32b-instruct", digest: "b".repeat(64), raw: "{}", promptHash: "c".repeat(64) }, nutrition: { accepted: true, reasons: [], basis: "per_100g", nutrition: { calories: 360, proteinGrams: 52, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null } } } as any;
    const sql = emitMachineNutritionSql({ productId: "prd_test", sourceRecordId: "src_test", sourceContentHash: "d".repeat(64), labelAssetId: "asset_test", sourceImageRevision: "1", releaseManifestSha256: "e".repeat(64), artifact });
    expect(sql).toContain("INSERT INTO machine_nutrition_verifications");
    expect(sql).toContain("ON CONFLICT(id) DO NOTHING");
    artifact.nutrition.accepted = false;
    expect(() => emitMachineNutritionSql({ productId: "prd_test", sourceRecordId: "src_test", sourceContentHash: "d".repeat(64), labelAssetId: "asset_test", sourceImageRevision: "1", releaseManifestSha256: "e".repeat(64), artifact })).toThrow("Only accepted");
  });

  it("batches only accepted, exactly bound label outcomes", () => {
    const artifact = { adapterVersion: "machine-label-v4", image: { contentSha256: "a".repeat(64) }, generatedAt: "2026-07-18T00:00:00.000Z", vision: { engine: "macos_vision", version: "accurate", lines: [] }, model: { model: "qwen3-vl:32b-instruct", digest: "b".repeat(64), raw: "{}", promptHash: "c".repeat(64) }, nutrition: { accepted: true, reasons: [], basis: "per_100g", nutrition: { calories: 360, proteinGrams: 52, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null } } } as any;
    const outcome = { status: "accepted", candidate: { id: "candidate", productId: "prd_test", subjectSourceRecordId: "src_test", sourceContentHash: "d".repeat(64), label: { sourceImageRevision: "1" } }, labelAsset: { id: "asset_test", productId: "prd_test", subjectSourceRecordId: "src_test", subjectSourceContentHash: "d".repeat(64), fieldFamily: "nutrition", sourceImageId: "image", sourceImageRevision: "1", requestedUrl: "https://example.test/a.jpg", effectiveUrl: "https://example.test/a.jpg", contentSha256: "a".repeat(64), byteLength: 10, mediaType: "image/jpeg", fetchedAt: "2026-07-18T00:00:00.000Z" }, artifact } as any;
    const batch = emitMachinePublicationBatch([outcome], { passed: true, adapterVersion: "machine-label-v4", cases: [{ errors: [] }, { errors: [] }] });
    expect(batch.manifest).toMatchObject({ acceptedCount: 1, accepted: [{ productId: "prd_test", labelAssetId: "asset_test" }] });
    expect(batch.sql.indexOf("INSERT INTO label_evidence_assets")).toBeLessThan(batch.sql.indexOf("INSERT INTO machine_nutrition_verifications"));
    expect(() => emitMachinePublicationBatch([outcome], { passed: true, adapterVersion: "machine-label-v4", cases: [{ errors: [] }, { errors: [] }] }, new Set(["other-candidate"]))).toThrow("contains no accepted");
  });

  it("rehearses emitted SQL against the immutable current-label projection", async () => {
    const db = new DatabaseSync(":memory:");
    for (const file of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(join("migrations", file), "utf8"));
    const at = "2026-07-18T00:00:00.000Z"; const h = (value: string) => value.repeat(64);
    db.exec(`INSERT INTO sources (id,name,kind,identity_authority,nutrition_authority,ingredient_authority,retention_notes,created_at) VALUES ('src','Source','fixture',1,1,1,'test','${at}');
      INSERT INTO ingestion_runs (id,source_id,adapter_version,mode,input_identifier,input_hash,records_read,india_records,staged_records,invalid_records,duplicate_records,source_complete,market_complete,status,started_at,completed_at) VALUES ('run','src','test','sample','test','${h("0")}',1,1,1,0,0,1,0,'completed','${at}','${at}');
      INSERT INTO products (id,brand,brand_normalized,name,name_normalized,category,marketed_reasons_json,nutrition_reasons_json,classifier_version,completeness_missing_json,created_at,updated_at) VALUES ('prd_test','Brand','brand','Product','product','other','[]','[]','test','[]','${at}','${at}');
      INSERT INTO source_records (id,source_id,source_record_id,product_id,content_hash,observed_at,first_seen_run_id,last_seen_run_id,raw_evidence_json,resolution_rule) VALUES ('src_test','src','record','prd_test','${h("d")}','${at}','run','run','{}','exact_gtin');
      INSERT INTO label_evidence_assets (id,subject_source_record_id,subject_source_content_hash,product_id,field_family,source_image_id,source_image_revision,requested_url,effective_url,content_sha256,byte_length,media_type,fetched_at) VALUES ('asset_test','src_test','${h("d")}','prd_test','nutrition','image','1','https://example.test/a.jpg','https://example.test/a.jpg','${h("a")}',10,'image/jpeg','${at}');`);
    const artifact = { adapterVersion: "machine-label-v4", image: { contentSha256: h("a") }, generatedAt: at, vision: { engine: "macos_vision", version: "accurate", lines: [] }, model: { model: "qwen3-vl:32b-instruct", digest: h("b"), raw: "{}", promptHash: h("c") }, nutrition: { accepted: true, reasons: [], basis: "per_100g", nutrition: { calories: 360, proteinGrams: 52, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null } } } as any;
    db.exec(emitMachineNutritionSql({ productId: "prd_test", sourceRecordId: "src_test", sourceContentHash: h("d"), labelAssetId: "asset_test", sourceImageRevision: "1", releaseManifestSha256: h("e"), artifact }));
    expect(db.prepare("SELECT calories, protein_grams FROM current_machine_verified_nutrition_facts").get()).toEqual({ calories: 360, protein_grams: 52 });

    const conflictingArtifact = structuredClone(artifact);
    conflictingArtifact.image.contentSha256 = h("f");
    conflictingArtifact.nutrition.nutrition.calories = 361;
    db.exec(`INSERT INTO label_evidence_assets (id,subject_source_record_id,subject_source_content_hash,product_id,field_family,source_image_id,source_image_revision,requested_url,effective_url,content_sha256,byte_length,media_type,fetched_at) VALUES ('asset_conflict','src_test','${h("d")}','prd_test','nutrition','image-second','1','https://example.test/conflict.jpg','https://example.test/conflict.jpg','${h("f")}',10,'image/jpeg','2026-07-18T00:01:00.000Z');`);
    db.exec(emitMachineNutritionSql({ productId: "prd_test", sourceRecordId: "src_test", sourceContentHash: h("d"), labelAssetId: "asset_conflict", sourceImageRevision: "1", releaseManifestSha256: h("e"), artifact: conflictingArtifact }));
    expect(db.prepare("SELECT COUNT(*) AS count FROM current_machine_verified_nutrition_facts").get()).toEqual({ count: 0 });
    db.close();
  });
});
