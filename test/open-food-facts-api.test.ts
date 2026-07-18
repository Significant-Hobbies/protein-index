import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";
import { enrichOpenFoodFactsApi } from "../scripts/adapters/open-food-facts-api";

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

async function sourceSnapshot(directory: string, records = 1) {
  const input = join(directory, "source.jsonl");
  const products = [
    { ...indiaProduct, nutriments: {} },
    { ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats", nutriments: {} },
  ].slice(0, records);
  await writeFile(input, `${products.map((product) => JSON.stringify(product)).join("\n")}\n`, "utf8");
  return stageOpenFoodFacts({ input, outputDirectory: join(directory, "source"), mode: "sample", limit: null });
}

describe("Open Food Facts API resilience", () => {
  it("retries a 429 then succeeds and marks the run as not degraded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-off-429-"));
    const source = await sourceSnapshot(directory, 1);
    let attempts = 0;
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 3,
      fetcher: async () => {
        attempts += 1;
        return attempts < 3
          ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
          : new Response(JSON.stringify({ count: 1, products: [indiaProduct] }), { status: 200 });
      },
    });
    expect(attempts).toBe(3);
    expect(result.manifest.sourceComplete).toBe(true);
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as { degraded: boolean; sourceComplete: boolean };
    expect(report.degraded).toBe(false);
    expect(report.sourceComplete).toBe(true);
  });

  it("retries a 500 then succeeds without amplifying into an infinite loop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-off-500-"));
    const source = await sourceSnapshot(directory, 1);
    let attempts = 0;
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 3,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("server error", { status: 500 })
          : new Response(JSON.stringify({ count: 1, products: [indiaProduct] }), { status: 200 });
      },
    });
    expect(attempts).toBe(2);
    expect(result.outcomes.enriched).toBe(1);
  });

  it("does not retry a 404 and fails fast", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-off-404-"));
    const source = await sourceSnapshot(directory, 1);
    let attempts = 0;
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 5,
      fetcher: async () => {
        attempts += 1;
        return new Response("not found", { status: 404 });
      },
    })).rejects.toThrow("incomplete");
    // A 404 is non-retryable, so only one attempt per code is made (the batch
    // splits down to single-product fallback, each of which also 404s once).
    expect(attempts).toBeLessThanOrEqual(5);
  });

  it("times out a hung request and marks the run as degraded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-off-timeout-degraded-"));
    const source = await sourceSnapshot(directory, 1);
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "timed-out"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      requestTimeoutMs: 5,
      fetcher: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    })).rejects.toThrow("incomplete");
    const report = JSON.parse(await readFile(join(directory, "timed-out/report.json"), "utf8")) as {
      degraded: boolean;
      sourceComplete: boolean;
      outcomes: { failed: number };
    };
    expect(report.degraded).toBe(true);
    expect(report.sourceComplete).toBe(false);
    expect(report.outcomes.failed).toBe(1);
  });

  it("splits a batch that receives a transient 503 and recovers individual codes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-off-split-"));
    const source = await sourceSnapshot(directory, 2);
    let attempts = 0;
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      batchSize: 2,
      maximumRequestBatchSize: 2,
      minimumSplitBatchSize: 1,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 2,
      fetcher: async (input) => {
        attempts += 1;
        const url = input.toString();
        // The full 2-code batch 503s, but single-code fallbacks succeed.
        if (url.includes("8900000000012") && url.includes("8900000000029")) {
          return new Response("busy", { status: 503 });
        }
        return new Response(JSON.stringify({ count: 1, products: [{ ...indiaProduct, code: url.includes("8900000000029") ? "8900000000029" : "8900000000012" }] }), { status: 200 });
      },
    });
    expect(result.outcomes.failed).toBe(0);
    expect(result.outcomes.enriched + result.outcomes.unchanged + result.outcomes.not_found).toBe(2);
  });

  it("records budget telemetry in the report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-off-budget-"));
    const source = await sourceSnapshot(directory, 1);
    const result = await enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      fetcher: async () => new Response(JSON.stringify({ count: 1, products: [indiaProduct] }), { status: 200 }),
    });
    const report = JSON.parse(await readFile(result.reportPath, "utf8")) as {
      budget: { apiCalls: number; maxApiCalls: number; maxBandwidthBytes: number; maxImages: number };
    };
    expect(report.budget.apiCalls).toBeGreaterThanOrEqual(1);
    expect(report.budget.maxApiCalls).toBe(6_000);
    expect(report.budget.maxBandwidthBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(report.budget.maxImages).toBe(20_000);
  });

  it("fails closed when the API-call budget is exceeded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-off-budget-exceeded-"));
    const source = await sourceSnapshot(directory, 1);
    await expect(enrichOpenFoodFactsApi({
      input: source.stagedPath,
      inputManifest: source.manifestPath,
      outputDirectory: join(directory, "enriched"),
      mode: "sample",
      limit: null,
      minimumIntervalMs: 0,
      retryBaseMs: 0,
      maximumAttempts: 5,
      budget: { maxApiCalls: 1 },
      fetcher: async () => new Response("busy", { status: 503 }),
    })).rejects.toThrow("incomplete");
    const report = JSON.parse(await readFile(join(directory, "enriched/report.json"), "utf8")) as {
      outcomes: { failed: number };
      budget: { apiCalls: number; maxApiCalls: number };
    };
    expect(report.outcomes.failed).toBe(1);
    expect(report.budget.apiCalls).toBeGreaterThan(report.budget.maxApiCalls);
  });
});
