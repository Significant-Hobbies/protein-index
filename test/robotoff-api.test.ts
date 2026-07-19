import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";
import { extractRobotoffApi } from "../scripts/adapters/robotoff-api";

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
  nutriments: {},
  image_nutrition_url: "https://images.openfoodfacts.org/images/products/890/000/000/0012/nutrition_en.2.400.jpg",
  last_modified_t: 1_752_537_600,
};

const labelImageFetcher = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
  status: 200,
  headers: { "content-type": "image/jpeg", "content-length": "4" },
});

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

async function robotoffSource(directory: string) {
  const input = join(directory, "source.jsonl");
  await writeFile(input, `${JSON.stringify(indiaProduct)}\n`, "utf8");
  return stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
}

describe("Robotoff API resilience", () => {
  it("retries a 429 then succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-429-"));
    const source = await robotoffSource(directory);
    let attempts = 0;
    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 3,
      labelFetcher: labelImageFetcher,
      fetcher: async () => {
        attempts += 1;
        return attempts < 3
          ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
          : new Response(JSON.stringify({ image_predictions: [prediction(1, "1", { "energy-kcal_100g": { value: 345, unit: "kcal", score: 0.9 }, proteins_100g: { value: 52, unit: "g", score: 0.9 } })] }), { status: 200 });
      },
    });
    expect(attempts).toBe(3);
    expect(result.outcomes.candidate).toBe(1);
  });

  it("retries a 500 then succeeds without amplifying into an infinite loop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-500-"));
    const source = await robotoffSource(directory);
    let attempts = 0;
    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 3,
      labelFetcher: labelImageFetcher,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("server error", { status: 500 })
          : new Response(JSON.stringify({ image_predictions: [prediction(1, "1", { "energy-kcal_100g": { value: 345, unit: "kcal", score: 0.9 }, proteins_100g: { value: 52, unit: "g", score: 0.9 } })] }), { status: 200 });
      },
    });
    expect(attempts).toBe(2);
    expect(result.outcomes.candidate).toBe(1);
  });

  it("times out a hung request and marks the run as degraded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-timeout-"));
    const source = await robotoffSource(directory);
    await expect(extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      requestTimeoutMs: 5,
      labelFetcher: labelImageFetcher,
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    })).rejects.toThrow("incomplete");
    const report = JSON.parse(await readFile(join(directory, "robotoff/report.json"), "utf8")) as {
      degraded: boolean;
      sourceComplete: boolean;
      requestTimeoutMs: number;
      outcomes: { failed: number };
    };
    expect(report.requestTimeoutMs).toBe(5);
    expect(report.degraded).toBe(true);
    expect(report.sourceComplete).toBe(false);
    expect(report.outcomes.failed).toBe(1);
  });

  it("does not retry a 404 and fails the barcode without amplifying", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-404-"));
    const source = await robotoffSource(directory);
    let attempts = 0;
    await expect(extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 5,
      labelFetcher: labelImageFetcher,
      fetcher: async () => {
        attempts += 1;
        return new Response("not found", { status: 404 });
      },
    })).rejects.toThrow("incomplete");
    // A 404 is non-retryable: only one attempt is made.
    expect(attempts).toBe(1);
  });

  it("enforces a pagination limit of 20 pages and fails the barcode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-pagination-"));
    const source = await robotoffSource(directory);
    await expect(extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 1,
      labelFetcher: labelImageFetcher,
      fetcher: async () => new Response(JSON.stringify({
        // Always return a full page so pagination never terminates naturally.
        image_predictions: Array.from({ length: 50 }, (_, index) => prediction(index + 1, String(index + 1), { "energy-kcal_100g": { value: 345, unit: "kcal", score: 0.9 } })),
      }), { status: 200 }),
    })).rejects.toThrow("incomplete");
    const report = JSON.parse(await readFile(join(directory, "robotoff/report.json"), "utf8")) as { outcomes: { failed: number }; requests: number };
    expect(report.outcomes.failed).toBe(1);
    expect(report.requests).toBe(20);
  });

  it("records budget telemetry in the report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-budget-"));
    const source = await robotoffSource(directory);
    const result = await extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      labelFetcher: labelImageFetcher,
      fetcher: async () => new Response(JSON.stringify({ image_predictions: [prediction(1, "1", { "energy-kcal_100g": { value: 345, unit: "kcal", score: 0.9 }, proteins_100g: { value: 52, unit: "g", score: 0.9 } })] }), { status: 200 }),
    });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      budget: { apiCalls: number; imagesDownloaded: number; bytesDownloaded: number; maxApiCalls: number };
    };
    expect(report.budget.apiCalls).toBeGreaterThanOrEqual(1);
    expect(report.budget.imagesDownloaded).toBeGreaterThanOrEqual(1);
    expect(report.budget.bytesDownloaded).toBeGreaterThanOrEqual(4);
    expect(report.budget.maxApiCalls).toBe(6_000);
  });

  it("fails closed when the API-call budget is exceeded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-robotoff-budget-exceeded-"));
    const source = await robotoffSource(directory);
    await expect(extractRobotoffApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "robotoff"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 5,
      budget: { maxApiCalls: 1 },
      labelFetcher: labelImageFetcher,
      fetcher: async () => new Response("busy", { status: 503 }),
    })).rejects.toThrow("incomplete");
    const report = JSON.parse(await readFile(join(directory, "robotoff/report.json"), "utf8")) as {
      outcomes: { failed: number };
      budget: { apiCalls: number; maxApiCalls: number };
    };
    expect(report.outcomes.failed).toBe(1);
    expect(report.budget.apiCalls).toBeGreaterThan(report.budget.maxApiCalls);
  });
});
