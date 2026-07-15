import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeOpenFoodFactsRecord, stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";
import { enrichOpenFoodFactsApi } from "../scripts/adapters/open-food-facts-api";
import { extractRobotoffApi } from "../scripts/adapters/robotoff-api";
import { parseRobotoffNutritionEvidence, type RobotoffProductContext } from "../scripts/adapters/robotoff";
import { assertPublicationEvidence } from "../scripts/publication";
import { emitImportSql } from "../scripts/reconcile";
import type { SourceManifest } from "../shared/types";

const indiaProduct = {
  code: "8900000000012",
  product_name: "Test Soya Chunks",
  brands: "Test Brand",
  countries_tags: ["en:india"],
  quantity: "500 g",
  serving_size: "50 g",
  categories_tags: ["en:soy-products"],
  ingredients_text: "Defatted soy flour 100%",
  allergens_tags: ["en:soybeans"],
  nutriments: {
    "energy-kcal_100g": 345,
    proteins_100g: 52,
    carbohydrates_100g: 33,
    sugars_100g: 7,
    fat_100g: 1,
    "saturated-fat_100g": 0.2,
    fiber_100g: 13,
    sodium_100g: 0.025,
    calcium_100g: 0.35,
  },
  last_modified_t: 1_752_537_600,
};

describe("Open Food Facts bulk staging", () => {
  it("accepts only source-complete, reconciled production snapshots for publication", () => {
    const manifest = {
      mode: "production",
      sourceComplete: true,
      marketComplete: false,
      terminalEvidence: "end_of_file",
      stagedRecords: 17,
      indiaRecords: 20,
    } as SourceManifest;
    const report = {
      sourceComplete: true,
      marketComplete: false,
      exclusions: { records: 3, reconcilesIndiaSlice: true },
      continuity: { currentStagedRecords: 17, previousStagedRecords: 17, missingSinceRecords: 0, maximumDropRatio: 0.2 },
    };
    expect(() => assertPublicationEvidence(manifest, report)).not.toThrow();
    expect(() => assertPublicationEvidence(manifest, { ...report, exclusions: { records: 2, reconcilesIndiaSlice: true } })).toThrow(
      "staged plus excluded records",
    );
    expect(() => assertPublicationEvidence({ ...manifest, sourceComplete: false }, report)).toThrow("manifest is not source complete");
  });

  it("requires exact terminal accounting for API enrichment publication", () => {
    const manifest = {
      source: "open_food_facts_api",
      mode: "production",
      sourceComplete: true,
      terminalEvidence: "end_of_file",
      stagedRecords: 8,
      indiaRecords: 10,
    } as SourceManifest;
    const report = {
      sourceComplete: true,
      marketComplete: false,
      requestedBarcodes: 10,
      accountedBarcodes: 10,
      outcomes: { failed: 0 },
      exclusions: { records: 2, reconcilesIndiaSlice: true },
    };
    expect(() => assertPublicationEvidence(manifest, report)).not.toThrow();
    expect(() => assertPublicationEvidence(manifest, { ...report, accountedBarcodes: 9 })).toThrow("barcode accounting");
    expect(() => assertPublicationEvidence(manifest, { ...report, outcomes: { failed: 1 } })).toThrow("failed barcodes");
  });

  it("requires terminal barcode accounting for multi-prediction Robotoff evidence", () => {
    const manifest = {
      source: "open_food_facts_robotoff",
      mode: "production",
      sourceComplete: true,
      terminalEvidence: "end_of_file",
      stagedRecords: 14,
      indiaRecords: 10,
    } as SourceManifest;
    const report = {
      sourceComplete: true,
      marketComplete: false,
      requestedBarcodes: 10,
      accountedBarcodes: 10,
      outcomes: { failed: 0 },
      exclusions: { records: 2, reconcilesIndiaSlice: true },
    };
    expect(() => assertPublicationEvidence(manifest, report)).not.toThrow();
    expect(() => assertPublicationEvidence(manifest, { ...report, accountedBarcodes: 9 })).toThrow("barcode accounting");
    expect(() => assertPublicationEvidence(manifest, { ...report, outcomes: { failed: 1 } })).toThrow("failed barcodes");
  });

  it("streams all India-tagged foods without protein prefiltering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-ingest-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(
      input,
      [
        JSON.stringify(indiaProduct),
        JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats", categories_tags: ["en:oats"] }),
        JSON.stringify({ ...indiaProduct, code: "8900000000036", countries_tags: ["en:united-states"] }),
      ].join("\n"),
      "utf8",
    );
    const result = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null });
    expect(result.manifest).toMatchObject({ recordsRead: 3, indiaRecords: 2, stagedRecords: 2, sourceComplete: true, marketComplete: false });
    const staged = (await readFile(result.stagedPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; nutrition: { status: string }; nutrients: Array<{ code: string }> });
    expect(staged.map(({ name }) => name)).toEqual(["Test Soya Chunks", "Ordinary Oats"]);
    expect(staged[0]?.nutrition.status).toBe("unverified");
    expect(staged[0]?.nutrients.some(({ code }) => code === "calcium")).toBe(true);
  });

  it("preserves a liquid nutrition basis instead of labeling it per 100 g", () => {
    const normalized = normalizeOpenFoodFactsRecord({
      ...indiaProduct,
      code: "8900000000029",
      product_name: "Protein Drink",
      quantity: "6 x 200ml",
      product_quantity_unit: "ml",
    });
    expect(normalized.staged?.nutrition.basis).toBe("per_100ml");
    expect(normalized.staged?.nutrients.every(({ basis }) => basis === "per_100ml")).toBe(true);
    const unknown = normalizeOpenFoodFactsRecord({ ...indiaProduct, code: "8900000000036", quantity: "" });
    expect(unknown.staged?.nutrition.basis).toBe("unknown");
  });

  it("writes an auditable exclusion ledger that reconciles the India slice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-exclusions-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(input, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "", product_name: "Missing code" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000012", product_name: "Duplicate record" }),
    ].join("\n"), "utf8");
    const result = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null });
    const exclusions = (await readFile(result.exclusionsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      sourceRow: number;
      sourceRecordId: string | null;
      reasonCodes: string[];
      evidenceHash: string;
    });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as { exclusions: { records: number; reconcilesIndiaSlice: boolean } };
    expect(exclusions).toHaveLength(2);
    expect(exclusions.map(({ reasonCodes }) => reasonCodes[0])).toEqual(["missing_identity", "duplicate_source_record_id"]);
    expect(exclusions.every(({ sourceRow, evidenceHash }) => sourceRow > 0 && evidenceHash.length === 64)).toBe(true);
    expect(report.exclusions).toEqual({ records: 2, path: "exclusions.jsonl", reconcilesIndiaSlice: true });
    expect(result.manifest).toMatchObject({ indiaRecords: 3, stagedRecords: 1, invalidRecords: 1, duplicateRecords: 1 });
  });

  it("fails closed for capped production traversal", async () => {
    await expect(stageOpenFoodFacts({ input: "unused", outputDirectory: "unused", mode: "production", limit: 10 })).rejects.toThrow(
      "Production source traversal cannot use a record limit",
    );
  });

  it("fails closed on an empty India snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-empty-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(input, `${JSON.stringify({ ...indiaProduct, countries_tags: ["en:france"] })}\n`, "utf8");
    await expect(stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null })).rejects.toThrow(
      "zero India-tagged staged records",
    );
  });

  it("compares a complete production snapshot with the prior source index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-continuity-"));
    const firstInput = join(directory, "first.jsonl");
    const secondInput = join(directory, "second.jsonl");
    await writeFile(firstInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
    ].join("\n"), "utf8");
    const first = await stageOpenFoodFacts({
      input: firstInput,
      outputDirectory: join(directory, "first"),
      mode: "production",
      limit: null,
      sourceUpdatedAt: "2026-07-14T00:00:00Z",
    });
    await writeFile(secondInput, [
      JSON.stringify({ ...indiaProduct, ingredients_text: "Defatted soy flour (100%)" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000043", product_name: "Plain Curd" }),
    ].join("\n"), "utf8");
    const second = await stageOpenFoodFacts({
      input: secondInput,
      outputDirectory: join(directory, "second"),
      mode: "production",
      limit: null,
      previousManifestPath: first.manifestPath,
      previousIndexPath: first.indexPath,
    });
    expect(second.manifest).toMatchObject({
      sourceComplete: true,
      newRecords: 1,
      changedRecords: 1,
      unchangedRecords: 1,
      missingSinceRecords: 0,
    });
    expect(second.manifest.sourceUpdatedAt).toBeNull();
  });

  it("fails closed when a production snapshot materially shrinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-drop-"));
    const firstInput = join(directory, "first.jsonl");
    const secondInput = join(directory, "second.jsonl");
    await writeFile(firstInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000043", product_name: "Plain Curd" }),
    ].join("\n"), "utf8");
    const first = await stageOpenFoodFacts({
      input: firstInput,
      outputDirectory: join(directory, "first"),
      mode: "production",
      limit: null,
    });
    await writeFile(secondInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
    ].join("\n"), "utf8");
    await expect(stageOpenFoodFacts({
      input: secondInput,
      outputDirectory: join(directory, "second"),
      mode: "production",
      limit: null,
      previousManifestPath: first.manifestPath,
      previousIndexPath: first.indexPath,
      maximumDropRatio: 0.2,
    })).rejects.toThrow("Source continuity failure");
  });
});

describe("Open Food Facts rich API enrichment", () => {
  async function sourceSnapshot(directory: string, records = 2) {
    const input = join(directory, "source.jsonl");
    const products = [
      { ...indiaProduct, nutriments: {} },
      { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats", nutriments: {} },
    ].slice(0, records);
    await writeFile(input, `${products.map((product) => JSON.stringify(product)).join("\n")}\n`, "utf8");
    return stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
  }

  it("fills compact-export gaps and accounts for every requested barcode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-"));
    const source = await sourceSnapshot(directory);
    const fetcher = async () => new Response(JSON.stringify({
      count: 1,
      products: [indiaProduct],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      fetcher,
    });
    expect(result.outcomes).toEqual({ enriched: 1, unchanged: 0, not_found: 1, rejected: 0, failed: 0 });
    expect(result.manifest).toMatchObject({ source: "open_food_facts_api", sourceComplete: true, recordsRead: 2, stagedRecords: 1 });
    const staged = JSON.parse((await readFile(result.stagedPath, "utf8")).trim()) as { source: string; nutrition: { status: string; per100g: { proteinGrams: number; calories: number } } };
    expect(staged).toMatchObject({ source: "open_food_facts_api", nutrition: { status: "unverified", per100g: { proteinGrams: 52, calories: 345 } } });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      requestedBarcodes: number;
      accountedBarcodes: number;
      exclusions: { records: number; reconcilesIndiaSlice: boolean };
      coverage: { nutritionPairs: { baseline: number; afterEnrichment: number; delta: number } };
    };
    expect(report).toMatchObject({
      requestedBarcodes: 2,
      accountedBarcodes: 2,
      exclusions: { records: 1, reconcilesIndiaSlice: true },
      coverage: { nutritionPairs: { baseline: 0, afterEnrichment: 1, delta: 1 } },
    });
  });

  it("resumes from matching batch artifacts without refetching", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-resume-"));
    const source = await sourceSnapshot(directory, 1);
    const outputDirectory = join(directory, "enriched");
    let requests = 0;
    const firstFetch = async () => {
      requests += 1;
      return new Response(JSON.stringify({ count: 1, products: [indiaProduct] }), { status: 200 });
    };
    await enrichOpenFoodFactsApi({ input: source.stagedPath, inputManifest: source.manifestPath, outputDirectory, mode: "sample", limit: null, minimumIntervalMs: 0, fetcher: firstFetch });
    const resumed = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      fetcher: async () => { throw new Error("resume should not fetch"); },
    });
    expect(requests).toBe(1);
    const report = JSON.parse(await readFile(resumed.reportPath, "utf8")) as { fetchedBatches: number; resumedBatches: number };
    expect(report).toMatchObject({ fetchedBatches: 0, resumedBatches: 1 });
  });

  it("retries transient failures and preserves incomplete accounting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-retry-"));
    const source = await sourceSnapshot(directory, 1);
    let attempts = 0;
    const transient = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "transient"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("busy", { status: 503 })
          : new Response(JSON.stringify({ count: 1, products: [indiaProduct] }), { status: 200 });
      },
    });
    expect(attempts).toBe(2);
    expect(transient.manifest.sourceComplete).toBe(true);

    const failedDirectory = join(directory, "failed");
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: failedDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      fetcher: async () => new Response("busy", { status: 503 }),
    })).rejects.toThrow("incomplete");
    const failedReport = JSON.parse(await readFile(join(failedDirectory, "report.json"), "utf8")) as { sourceComplete: boolean; accountedBarcodes: number; outcomes: { failed: number } };
    expect(failedReport).toMatchObject({ sourceComplete: false, accountedBarcodes: 1, outcomes: { failed: 1 } });
  });

  it("retries only failed batches on resume and clears stale failure evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-partial-resume-"));
    const source = await sourceSnapshot(directory, 2);
    const outputDirectory = join(directory, "enriched");
    let firstRunRequests = 0;
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 1,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 1,
      fetcher: async () => {
        firstRunRequests += 1;
        return firstRunRequests === 1
          ? new Response(JSON.stringify({ products: [indiaProduct] }), { status: 200 })
          : new Response("busy", { status: 503 });
      },
    })).rejects.toThrow("incomplete");
    expect(firstRunRequests).toBe(2);
    expect(await readFile(join(outputDirectory, "responses/batch-00002.json.error.json"), "utf8")).toContain("failed after retry");

    let resumedRequests = 0;
    const resumedProduct = { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" };
    const resumed = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 1,
      minimumIntervalMs: 10_000,
      fetcher: async () => {
        resumedRequests += 1;
        return new Response(JSON.stringify({ products: [resumedProduct] }), { status: 200 });
      },
    });
    expect(resumedRequests).toBe(1);
    expect(resumed.manifest.sourceComplete).toBe(true);
    const report = JSON.parse(await readFile(resumed.reportPath, "utf8")) as { fetchedBatches: number; resumedBatches: number };
    expect(report).toMatchObject({ fetchedBatches: 1, resumedBatches: 1 });
    await expect(readFile(join(outputDirectory, "responses/batch-00002.json.error.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("splits a persistently unavailable batch and preserves complete accounting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-split-"));
    const source = await sourceSnapshot(directory, 2);
    const returnedByCode = new Map([
      ["8900000000012", indiaProduct],
      ["8900000000029", { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }],
    ]);
    let requests = 0;
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 5,
      fetcher: async (input) => {
        requests += 1;
        const codes = new URL(input.toString()).searchParams.get("code")?.split(",") ?? [];
        if (codes.length > 1) return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ products: codes.flatMap((code) => returnedByCode.get(code) ?? []) }), { status: 200 });
      },
    });
    expect(requests).toBe(3);
    expect(result.manifest.sourceComplete).toBe(true);
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as { accountedBarcodes: number; fallbackSplits: number; outcomes: { failed: number } };
    expect(report).toMatchObject({ accountedBarcodes: 2, fallbackSplits: 1, outcomes: { failed: 0 } });
  });

  it("preserves successful split siblings and resumes only failed codes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-enrich-partial-split-"));
    const source = await sourceSnapshot(directory, 2);
    const outputDirectory = join(directory, "enriched");
    let firstRequests = 0;
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 1,
      minimumSplitBatchSize: 1,
      fetcher: async (input) => {
        firstRequests += 1;
        const codes = new URL(input.toString()).searchParams.get("code")?.split(",") ?? [];
        if (codes.length > 1 || codes[0] === "8900000000029") return new Response("busy", { status: 503 });
        return new Response(JSON.stringify({ products: [indiaProduct] }), { status: 200 });
      },
    })).rejects.toThrow("incomplete");
    expect(firstRequests).toBe(3);
    const partial = JSON.parse(await readFile(join(outputDirectory, "responses/batch-00001.json"), "utf8")) as {
      response: { products: Array<{ code: string }> };
      failedCodes: string[];
    };
    expect(partial.response.products.map(({ code }) => code)).toEqual(["8900000000012"]);
    expect(partial.failedCodes).toEqual(["8900000000029"]);

    let resumedRequests = 0;
    const resumedProduct = { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" };
    const resumed = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      batchSize: 2,
      minimumIntervalMs: 0,
      fetcher: async (input) => {
        resumedRequests += 1;
        expect(new URL(input.toString()).searchParams.get("code")).toBe("8900000000029");
        return new Response(JSON.stringify({ products: [resumedProduct] }), { status: 200 });
      },
    });
    expect(resumedRequests).toBe(1);
    expect(resumed.outcomes.failed).toBe(0);
    expect(resumed.manifest.sourceComplete).toBe(true);
  });
});

describe("Robotoff label evidence", () => {
  const context: RobotoffProductContext = {
    code: "8900000000012",
    brand: "Test Brand",
    name: "Test Protein Bar",
    flavour: "Cocoa",
    category: "protein_bar",
    categoryRaw: "Protein bars",
    netQuantityGrams: 40,
    servingSizeGrams: 40,
    imageUrl: null,
    nutritionImageUrl: "https://images.openfoodfacts.org/images/products/890/000/000/0012/nutrition_en.2.400.jpg",
  };

  function prediction(id: number, imageId: string, nutrients: Record<string, unknown>) {
    return {
      id,
      type: "nutrition_extraction",
      model_name: "nutrition_extractor",
      model_version: "nutrition_extractor-2.0",
      timestamp: "2026-07-15T10:00:00",
      image: { image_id: imageId, source_image: `/890/000/000/0012/${imageId}.jpg`, uploaded_at: "2026-07-15T09:00:00" },
      data: { nutrients },
    };
  }

  const nutrient = (value: number, unit: string, score = 0.98) => ({ value: String(value), unit, score });

  async function sourceWithNutritionImage(directory: string) {
    const input = join(directory, "source.jsonl");
    await writeFile(input, `${JSON.stringify({
      ...indiaProduct,
      image_nutrition_url: context.nutritionImageUrl,
    })}\n`, "utf8");
    return stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
  }

  it("retains a plausible per-100-g prediction as review evidence only", () => {
    const response = { image_predictions: [prediction(1, "7", {
      "energy-kcal_100g": nutrient(365, "kcal"),
      proteins_100g: nutrient(25, "g"),
      carbohydrates_100g: nutrient(46.5, "g"),
      fat_100g: nutrient(8.9, "g"),
    })] };
    const result = parseRobotoffNutritionEvidence(response, context);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ basis: "per_100g", modelVersion: "nutrition_extractor-2.0", nutritionPer100g: { calories: 365, proteinGrams: 25 } });
    expect(result.staged[0]?.nutrition.status).toBe("missing");
    expect(result.staged[0]?.rawEvidence).toMatchObject({ candidate: { imageId: "7" } });
    expect(result.staged[0]?.validationIssues.some(({ code }) => code === "robotoff_nutrition_candidate")).toBe(true);
  });

  it("emits label candidates into the nutrition review queue without selecting facts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-review-"));
    const result = parseRobotoffNutritionEvidence({ image_predictions: [prediction(7, "13", {
      "energy-kcal_100g": nutrient(365, "kcal"),
      proteins_100g: nutrient(25, "g"),
    })] }, context);
    const stagedPath = join(directory, "staged-products.jsonl");
    const manifestPath = join(directory, "manifest.json");
    const sqlPath = join(directory, "import.sql");
    await writeFile(stagedPath, `${result.staged.map((product) => JSON.stringify(product)).join("\n")}\n`, "utf8");
    const now = "2026-07-15T10:00:00.000Z";
    const manifest: SourceManifest = {
      schemaVersion: 1,
      source: "open_food_facts_robotoff",
      sourceKind: "open_data",
      sourceAuthority: { identity: 0, nutrition: 20, ingredients: 0 },
      sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
      sourceRetentionNotes: "Test Robotoff review artifact",
      adapterVersion: "robotoff-test",
      input: "fixture",
      inputHash: "a".repeat(64),
      inputBytes: 1,
      sourceUpdatedAt: null,
      startedAt: now,
      completedAt: now,
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
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await emitImportSql({ stagedPath, manifestPath, outputPath: sqlPath });
    const sql = await readFile(sqlPath, "utf8");
    expect(sql).toContain("'nutrition_validation'");
    expect(sql).toContain("robotoff_nutrition_candidate");
    expect(sql).not.toContain("INSERT INTO nutrition_facts");
    expect(result.staged[0]?.nutrition.status).toBe("missing");
  });

  it("normalizes an explicit serving basis only with serving mass", () => {
    const response = { image_predictions: [prediction(2, "8", {
      "energy-kcal_serving": nutrient(146, "kcal"),
      proteins_serving: nutrient(10, "g"),
      fat_serving: nutrient(3.57, "g"),
    })] };
    const converted = parseRobotoffNutritionEvidence(response, context);
    expect(converted.candidates[0]).toMatchObject({ basis: "per_serving", nutritionPer100g: { calories: 365, proteinGrams: 25 } });
    expect(converted.candidates[0]?.nutritionPer100g.fatGrams).toBeCloseTo(8.925, 6);
    const ambiguous = parseRobotoffNutritionEvidence(response, { ...context, servingSizeGrams: null });
    expect(ambiguous.candidates).toHaveLength(0);
    expect(ambiguous.issues.some(({ code }) => code === "robotoff_ambiguous_serving_basis")).toBe(true);
  });

  it("rejects impossible nutrition and exposes multi-image disagreement", () => {
    const impossible = parseRobotoffNutritionEvidence({ image_predictions: [prediction(3, "9", {
      "energy-kcal_100g": nutrient(365, "kcal"),
      proteins_100g: nutrient(120, "g"),
    })] }, context);
    expect(impossible.candidates).toHaveLength(0);
    expect(impossible.issues.some(({ code }) => code === "robotoff_nutrient_over_100g")).toBe(true);

    const conflict = parseRobotoffNutritionEvidence({ image_predictions: [
      prediction(4, "10", { "energy-kcal_100g": nutrient(365, "kcal"), proteins_100g: nutrient(25, "g") }),
      prediction(5, "11", { "energy-kcal_100g": nutrient(200, "kcal"), proteins_100g: nutrient(10, "g") }),
    ] }, context);
    expect(conflict.candidates).toHaveLength(2);
    expect(conflict.staged.every(({ validationIssues }) => validationIssues.some(({ code }) => code === "robotoff_image_conflict"))).toBe(true);
  });

  it("does not use low-confidence core values", () => {
    const result = parseRobotoffNutritionEvidence({ image_predictions: [prediction(6, "12", {
      "energy-kcal_100g": nutrient(365, "kcal", 0.99),
      proteins_100g: nutrient(25, "g", 0.5),
    })] }, context, 0.85);
    expect(result.candidates).toHaveLength(0);
    expect(result.issues.some(({ code }) => code === "robotoff_low_confidence_nutrient")).toBe(true);
  });

  it("exhausts label-image barcodes into resumable review candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-api-"));
    const source = await sourceWithNutritionImage(directory);
    const outputDirectory = join(directory, "robotoff");
    let requests = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      const url = new URL(input.toString());
      expect(url.origin + url.pathname).toBe("https://robotoff.openfoodfacts.org/api/v1/image_predictions");
      expect(url.searchParams.get("barcode")).toBe("08900000000012");
      expect(url.searchParams.get("model_name")).toBe("nutrition_extractor");
      expect(url.searchParams.get("type")).toBe("nutrition_extraction");
      expect(new Headers(init?.headers).get("user-agent")).toContain("protein-index");
      return new Response(JSON.stringify({ image_predictions: [prediction(9, "15", {
        "energy-kcal_100g": nutrient(365, "kcal"),
        proteins_100g: nutrient(25, "g"),
      })] }), { status: 200 });
    };
    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      fetcher,
    });
    expect(requests).toBe(1);
    expect(result.outcomes).toEqual({ candidate: 1, no_prediction: 0, rejected: 0, failed: 0 });
    expect(result.manifest).toMatchObject({
      source: "open_food_facts_robotoff",
      sourceComplete: true,
      recordsRead: 1,
      indiaRecords: 1,
      stagedRecords: 1,
    });
    const staged = JSON.parse((await readFile(result.stagedPath, "utf8")).trim()) as {
      nutrition: { status: string };
      validationIssues: Array<{ code: string }>;
    };
    expect(staged.nutrition.status).toBe("missing");
    expect(staged.validationIssues).toContainEqual(expect.objectContaining({ code: "robotoff_nutrition_candidate" }));
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({ requestedBarcodes: 1, accountedBarcodes: 1, fetchedBarcodes: 1, resumedBarcodes: 0 });

    const resumed = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory,
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      fetcher: async () => { throw new Error("resume should not fetch"); },
    });
    const resumedReport = JSON.parse(await readFile(resumed.reportPath, "utf8")) as Record<string, unknown>;
    expect(resumedReport).toMatchObject({ requestedBarcodes: 1, accountedBarcodes: 1, fetchedBarcodes: 0, resumedBarcodes: 1 });
  });

  it("accounts for absent predictions without inventing nutrition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-empty-"));
    const source = await sourceWithNutritionImage(directory);
    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [] }), { status: 200 }),
    });
    expect(result.outcomes).toEqual({ candidate: 0, no_prediction: 1, rejected: 0, failed: 0 });
    expect(await readFile(result.stagedPath, "utf8")).toBe("");
    const exclusion = JSON.parse((await readFile(result.exclusionsPath, "utf8")).trim()) as { status: string; reasons: string[] };
    expect(exclusion).toEqual(expect.objectContaining({ status: "no_prediction", reasons: ["no_nutrition_extraction_prediction"] }));
  });
});
