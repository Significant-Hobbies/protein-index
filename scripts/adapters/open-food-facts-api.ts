import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { normalizeGtin } from "../../shared/gtin";
import type { SourceManifest, StagedProduct } from "../../shared/types";
import { normalizeOpenFoodFactsRecord } from "./open-food-facts";

export const OPEN_FOOD_FACTS_API_ADAPTER_VERSION = "off-api-enrichment-v2";
export const OPEN_FOOD_FACTS_MULTI_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/search";
export const OPEN_FOOD_FACTS_API_FIELDS = [
  "code",
  "product_name",
  "generic_name",
  "brands",
  "countries",
  "countries_tags",
  "quantity",
  "product_quantity",
  "product_quantity_unit",
  "serving_size",
  "serving_quantity",
  "nutrition_data_per",
  "categories",
  "categories_tags",
  "labels",
  "labels_tags",
  "ingredients_text",
  "allergens",
  "traces",
  "allergens_tags",
  "additives_tags",
  "nutriments",
  "lang",
  "image_url",
  "image_nutrition_url",
  "image_ingredients_url",
  "last_modified_t",
  "last_modified_datetime",
  "last_updated_t",
  "last_updated_datetime",
  "data_quality_errors_tags",
  "data_quality_warnings_tags",
  "states_tags",
].join(",");
export const OPEN_FOOD_FACTS_API_REQUEST_SCHEMA = createHash("sha256")
  .update(`${OPEN_FOOD_FACTS_API_ADAPTER_VERSION}:${OPEN_FOOD_FACTS_MULTI_PRODUCT_URL}:${OPEN_FOOD_FACTS_API_FIELDS}`)
  .digest("hex");

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type OutcomeStatus = "enriched" | "unchanged" | "not_found" | "rejected" | "failed";

interface SourceSummary {
  requestedCode: string;
  key: string;
  nutrition: string;
  ingredients: string | null;
  nutritionImageUrl: string | null;
  ingredientImageUrl: string | null;
  netQuantityGrams: number | null;
  servingSizeGrams: number | null;
  hasNutritionPair: boolean;
  hasIngredients: boolean;
  marketedProtein: boolean;
}

interface EnrichmentOutcome {
  requestedCode: string;
  returnedCode: string | null;
  status: OutcomeStatus;
  reasons: string[];
  batch: number;
}

interface ApiSearchResponse {
  count?: number;
  products?: Array<Record<string, unknown>>;
}

interface StoredBatchResponse {
  requestedCodes: string[];
  requestSchema: string;
  fetchedAt: string;
  response: ApiSearchResponse;
  failedCodes?: string[];
}

interface ResilientBatchResponse {
  response: ApiSearchResponse;
  failedCodes: string[];
}

class SplitBatchError extends Error {}

export interface OpenFoodFactsApiEnrichmentOptions {
  input: string;
  inputManifest: string;
  outputDirectory: string;
  mode: "sample" | "production";
  limit: number | null;
  batchSize?: number;
  minimumIntervalMs?: number;
  retryBaseMs?: number;
  maximumAttempts?: number;
  minimumSplitBatchSize?: number;
  maximumRequestBatchSize?: number;
  fetcher?: FetchLike;
  userAgent?: string;
}

export interface OpenFoodFactsApiEnrichmentResult {
  stagedPath: string;
  outcomesPath: string;
  indexPath: string;
  exclusionsPath: string;
  manifestPath: string;
  reportPath: string;
  manifest: SourceManifest;
  outcomes: Record<OutcomeStatus, number>;
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyForCode(code: string): string {
  return normalizeGtin(code) ?? code.replace(/^0+(?=\d)/, "");
}

function nutritionFingerprint(product: StagedProduct): string {
  return JSON.stringify(product.nutrition.per100g);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return hash.digest("hex");
}

async function readSourceSummaries(path: string, limit: number | null): Promise<SourceSummary[]> {
  const summaries: SourceSummary[] = [];
  const seen = new Set<string>();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const product = JSON.parse(line) as StagedProduct;
    const requestedCode = product.sourceRecordId;
    const key = keyForCode(requestedCode);
    if (!product.gtin || seen.has(key)) continue;
    seen.add(key);
    summaries.push({
      requestedCode,
      key,
      nutrition: nutritionFingerprint(product),
      ingredients: product.ingredients.raw,
      nutritionImageUrl: product.nutritionImageUrl,
      ingredientImageUrl: product.ingredientImageUrl,
      netQuantityGrams: product.netQuantityGrams,
      servingSizeGrams: product.servingSizeGrams,
      hasNutritionPair: product.nutrition.per100g.calories !== null && product.nutrition.per100g.calories > 0 && product.nutrition.per100g.proteinGrams !== null,
      hasIngredients: Boolean(product.ingredients.raw),
      marketedProtein: product.classification.marketed === true,
    });
    if (limit !== null && summaries.length >= limit) break;
  }
  return summaries;
}

async function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

async function closeStream(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function sleep(milliseconds: number): Promise<void> {
  return milliseconds <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryDelay(response: Response | null, attempt: number, retryBaseMs: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  return Math.min(retryBaseMs * (2 ** (attempt - 1)), 60_000);
}

function batchUrl(codes: string[]): URL {
  const url = new URL(OPEN_FOOD_FACTS_MULTI_PRODUCT_URL);
  url.searchParams.set("code", codes.join(","));
  url.searchParams.set("fields", OPEN_FOOD_FACTS_API_FIELDS);
  url.searchParams.set("page_size", String(codes.length));
  return url;
}

async function fetchBatch(input: {
  codes: string[];
  fetcher: FetchLike;
  userAgent: string;
  maximumAttempts: number;
  retryBaseMs: number;
  beforeAttempt: () => Promise<void>;
}): Promise<ApiSearchResponse> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= input.maximumAttempts; attempt += 1) {
    let response: Response | null = null;
    try {
      await input.beforeAttempt();
      response = await input.fetcher(batchUrl(input.codes), {
        headers: { Accept: "application/json", "User-Agent": input.userAgent },
      });
      if (!response.ok) {
        if (response.status === 503 && input.codes.length > 1) {
          throw new SplitBatchError("Open Food Facts could not serve the current batch size");
        }
        const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
        if (!retryable) throw new Error(`Open Food Facts enrichment returned HTTP ${response.status}`);
        lastError = new Error(`Open Food Facts enrichment returned retryable HTTP ${response.status}`);
      } else {
        const body: unknown = await response.json();
        if (!recordValue(body) || !Array.isArray(body.products)) throw new Error("Open Food Facts enrichment returned an invalid search response");
        return body as ApiSearchResponse;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (error instanceof SplitBatchError) throw error;
      if (response && response.status < 500 && response.status !== 429) throw lastError;
    }
    if (attempt < input.maximumAttempts) await sleep(retryDelay(response, attempt, input.retryBaseMs));
  }
  throw lastError ?? new Error("Open Food Facts enrichment failed without a response");
}

async function fetchBatchResilient(input: {
  codes: string[];
  fetcher: FetchLike;
  userAgent: string;
  maximumAttempts: number;
  retryBaseMs: number;
  beforeAttempt: () => Promise<void>;
  onSplit: () => void;
  minimumSplitBatchSize: number;
}): Promise<ResilientBatchResponse> {
  try {
    return { response: await fetchBatch(input), failedCodes: [] };
  } catch (error) {
    if (input.codes.length <= input.minimumSplitBatchSize) return { response: { count: 0, products: [] }, failedCodes: input.codes };
    input.onSplit();
    const middle = Math.ceil(input.codes.length / 2);
    const left = await fetchBatchResilient({ ...input, codes: input.codes.slice(0, middle) });
    const right = await fetchBatchResilient({ ...input, codes: input.codes.slice(middle) });
    return {
      response: {
        count: (left.response.products?.length ?? 0) + (right.response.products?.length ?? 0),
        products: [...(left.response.products ?? []), ...(right.response.products ?? [])],
      },
      failedCodes: [...left.failedCodes, ...right.failedCodes],
    };
  }
}

function mergeResponses(existing: ApiSearchResponse, incoming: ApiSearchResponse): ApiSearchResponse {
  const products = new Map<string, Record<string, unknown>>();
  for (const product of [...(existing.products ?? []), ...(incoming.products ?? [])]) {
    const code = typeof product.code === "string" ? product.code : typeof product.code === "number" ? String(product.code) : null;
    if (code) products.set(keyForCode(code), product);
  }
  return { count: products.size, products: [...products.values()] };
}

function enrichmentReasons(original: SourceSummary, product: StagedProduct): string[] {
  const reasons: string[] = [];
  if (product.nutrition.status !== "missing" && original.nutrition !== nutritionFingerprint(product)) reasons.push("nutrition_changed");
  if (product.ingredients.raw && original.ingredients !== product.ingredients.raw) reasons.push("ingredients_changed");
  if (product.nutritionImageUrl && original.nutritionImageUrl !== product.nutritionImageUrl) reasons.push("nutrition_image_changed");
  if (product.ingredientImageUrl && original.ingredientImageUrl !== product.ingredientImageUrl) reasons.push("ingredient_image_changed");
  if (product.netQuantityGrams !== null && original.netQuantityGrams !== product.netQuantityGrams) reasons.push("net_quantity_changed");
  if (product.servingSizeGrams !== null && original.servingSizeGrams !== product.servingSizeGrams) reasons.push("serving_size_changed");
  return reasons;
}

export async function enrichOpenFoodFactsApi(options: OpenFoodFactsApiEnrichmentOptions): Promise<OpenFoodFactsApiEnrichmentResult> {
  const batchSize = options.batchSize ?? 100;
  const minimumIntervalMs = options.minimumIntervalMs ?? 6_500;
  const retryBaseMs = options.retryBaseMs ?? 2_000;
  const maximumAttempts = options.maximumAttempts ?? 5;
  const minimumSplitBatchSize = options.minimumSplitBatchSize ?? Math.min(25, batchSize);
  const maximumRequestBatchSize = options.maximumRequestBatchSize ?? Math.min(50, batchSize);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("API enrichment batch size must be between 1 and 100.");
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) throw new Error("API enrichment interval must be non-negative.");
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 8) throw new Error("API enrichment attempts must be between 1 and 8.");
  if (!Number.isInteger(minimumSplitBatchSize) || minimumSplitBatchSize < 1 || minimumSplitBatchSize > batchSize) {
    throw new Error("API enrichment minimum split batch size must be between 1 and the batch size.");
  }
  if (!Number.isInteger(maximumRequestBatchSize) || maximumRequestBatchSize < minimumSplitBatchSize || maximumRequestBatchSize > batchSize) {
    throw new Error("API enrichment maximum request batch size must be between the minimum split size and the checkpoint batch size.");
  }
  if (options.mode === "production" && options.limit !== null) throw new Error("Production enrichment cannot use a barcode limit.");

  const sourceManifest = JSON.parse(await readFile(options.inputManifest, "utf8")) as SourceManifest;
  if (sourceManifest.source !== "open_food_facts" || !sourceManifest.sourceComplete || sourceManifest.terminalEvidence !== "end_of_file") {
    throw new Error("API enrichment requires a source-complete Open Food Facts snapshot manifest.");
  }
  const inputStats = await stat(options.input);
  const inputHash = await hashFile(options.input);
  if (sourceManifest.stagedRecords <= 0) throw new Error("API enrichment source snapshot is empty.");

  const summaries = await readSourceSummaries(options.input, options.limit);
  if (summaries.length === 0) throw new Error("API enrichment found no valid source barcodes.");
  await mkdir(options.outputDirectory, { recursive: true });
  const responsesDirectory = join(options.outputDirectory, "responses");
  await mkdir(responsesDirectory, { recursive: true });
  const stagedPath = join(options.outputDirectory, "staged-products.jsonl");
  const outcomesPath = join(options.outputDirectory, "outcomes.jsonl");
  const indexPath = join(options.outputDirectory, "source-index.jsonl");
  const exclusionsPath = join(options.outputDirectory, "exclusions.jsonl");
  const manifestPath = join(options.outputDirectory, "manifest.json");
  const reportPath = join(options.outputDirectory, "report.json");
  const stagedOutput = createWriteStream(stagedPath, { encoding: "utf8" });
  const outcomeOutput = createWriteStream(outcomesPath, { encoding: "utf8" });
  const indexOutput = createWriteStream(indexPath, { encoding: "utf8" });
  const exclusionOutput = createWriteStream(exclusionsPath, { encoding: "utf8" });
  const outcomes: Record<OutcomeStatus, number> = { enriched: 0, unchanged: 0, not_found: 0, rejected: 0, failed: 0 };
  const issueCounts: Record<string, number> = {};
  const startedAt = new Date().toISOString();
  let stagedRecords = 0;
  let fetchedBatches = 0;
  let resumedBatches = 0;
  let fallbackSplits = 0;
  let lastFetchStartedAt: number | null = null;
  const coverage = {
    nutritionPairs: {
      baseline: summaries.filter(({ hasNutritionPair }) => hasNutritionPair).length,
      apiResponses: 0,
      afterEnrichment: summaries.filter(({ hasNutritionPair }) => hasNutritionPair).length,
    },
    ingredientStatements: {
      baseline: summaries.filter(({ hasIngredients }) => hasIngredients).length,
      apiResponses: 0,
      afterEnrichment: summaries.filter(({ hasIngredients }) => hasIngredients).length,
    },
    marketedNutritionPairs: {
      products: summaries.filter(({ marketedProtein }) => marketedProtein).length,
      baseline: summaries.filter(({ marketedProtein, hasNutritionPair }) => marketedProtein && hasNutritionPair).length,
      afterEnrichment: summaries.filter(({ marketedProtein, hasNutritionPair }) => marketedProtein && hasNutritionPair).length,
    },
  };
  const fetchChunk = (codes: string[]) => fetchBatchResilient({
    codes,
    fetcher: options.fetcher ?? fetch,
    userAgent: options.userAgent ?? "protein-index/0.1 (+https://github.com/sarthak-fleet/protein-index; nutrition-enrichment)",
    maximumAttempts,
    retryBaseMs,
    minimumSplitBatchSize,
    beforeAttempt: async () => {
      if (lastFetchStartedAt !== null) {
        await sleep(Math.max(0, minimumIntervalMs - (Date.now() - lastFetchStartedAt)));
      }
      lastFetchStartedAt = Date.now();
    },
    onSplit: () => { fallbackSplits += 1; },
  });
  const fetchCodes = async (codes: string[]): Promise<ResilientBatchResponse> => {
    let response: ApiSearchResponse = { count: 0, products: [] };
    const failedCodes: string[] = [];
    for (let offset = 0; offset < codes.length; offset += maximumRequestBatchSize) {
      const fetched = await fetchChunk(codes.slice(offset, offset + maximumRequestBatchSize));
      response = mergeResponses(response, fetched.response);
      failedCodes.push(...fetched.failedCodes);
    }
    return { response, failedCodes };
  };

  try {
    for (let offset = 0, batch = 1; offset < summaries.length; offset += batchSize, batch += 1) {
      const selected = summaries.slice(offset, offset + batchSize);
      const requestedCodes = selected.map(({ requestedCode }) => requestedCode);
      const responsePath = join(responsesDirectory, `batch-${String(batch).padStart(5, "0")}.json`);
      const errorPath = `${responsePath}.error.json`;
      let stored: StoredBatchResponse;
      try {
        const existing = JSON.parse(await readFile(responsePath, "utf8")) as StoredBatchResponse;
        if (existing.requestSchema !== OPEN_FOOD_FACTS_API_REQUEST_SCHEMA
          || JSON.stringify(existing.requestedCodes) !== JSON.stringify(requestedCodes)
          || !recordValue(existing.response)
          || !Array.isArray(existing.response.products)) {
          throw new Error(`Resume artifact ${basename(responsePath)} does not match the requested batch.`);
        }
        const failedCodes = existing.failedCodes ?? [];
        if (failedCodes.length === 0) {
          stored = existing;
          resumedBatches += 1;
        } else {
          const retried = await fetchCodes(failedCodes);
          stored = {
            ...existing,
            fetchedAt: new Date().toISOString(),
            response: mergeResponses(existing.response, retried.response),
            failedCodes: retried.failedCodes,
          };
          fetchedBatches += 1;
        }
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof Error && !error.message.includes("ENOENT"))) throw error;
        try {
          const fetched = await fetchCodes(requestedCodes);
          stored = {
            requestedCodes,
            requestSchema: OPEN_FOOD_FACTS_API_REQUEST_SCHEMA,
            fetchedAt: new Date().toISOString(),
            response: fetched.response,
            failedCodes: fetched.failedCodes,
          };
          fetchedBatches += 1;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await writeFile(errorPath, `${JSON.stringify({ requestedCodes, failedAt: new Date().toISOString(), error: reason }, null, 2)}\n`, "utf8");
          for (const item of selected) {
            const outcome: EnrichmentOutcome = { requestedCode: item.requestedCode, returnedCode: null, status: "failed", reasons: [reason], batch };
            outcomes.failed += 1;
            await writeLine(outcomeOutput, outcome);
            await writeLine(exclusionOutput, outcome);
          }
          continue;
        }
      }

      await writeFile(responsePath, `${JSON.stringify(stored)}\n`, "utf8");
      if ((stored.failedCodes?.length ?? 0) > 0) {
        await writeFile(errorPath, `${JSON.stringify({ requestedCodes: stored.failedCodes, failedAt: new Date().toISOString(), error: "Open Food Facts enrichment failed after retry" }, null, 2)}\n`, "utf8");
      } else {
        await unlink(errorPath).catch((unlinkError: NodeJS.ErrnoException) => {
          if (unlinkError.code !== "ENOENT") throw unlinkError;
        });
      }

      const returned = new Map<string, Record<string, unknown>>();
      for (const product of stored.response.products ?? []) {
        const code = typeof product.code === "string" ? product.code : typeof product.code === "number" ? String(product.code) : null;
        if (code) returned.set(keyForCode(code), product);
      }
      const failedKeys = new Set((stored.failedCodes ?? []).map(keyForCode));
      for (const item of selected) {
        if (failedKeys.has(item.key)) {
          const outcome: EnrichmentOutcome = { requestedCode: item.requestedCode, returnedCode: null, status: "failed", reasons: ["api_failed_after_retry"], batch };
          outcomes.failed += 1;
          await writeLine(outcomeOutput, outcome);
          await writeLine(exclusionOutput, outcome);
          continue;
        }
        const record = returned.get(item.key);
        if (!record) {
          const outcome: EnrichmentOutcome = { requestedCode: item.requestedCode, returnedCode: null, status: "not_found", reasons: ["api_omitted_requested_code"], batch };
          outcomes.not_found += 1;
          await writeLine(outcomeOutput, outcome);
          await writeLine(exclusionOutput, outcome);
          continue;
        }
        const normalized = normalizeOpenFoodFactsRecord(record, {
          source: "open_food_facts_api",
          sourceAuthority: { identity: 45, nutrition: 40, ingredients: 40 },
          sourceRetentionNotes: "Open Food Facts documented multi-code API enrichment; ODbL attribution and share-alike obligations apply.",
        });
        for (const issue of normalized.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
        if (!normalized.staged) {
          const outcome: EnrichmentOutcome = {
            requestedCode: item.requestedCode,
            returnedCode: typeof record.code === "string" ? record.code : null,
            status: "rejected",
            reasons: normalized.issues.map(({ code }) => code),
            batch,
          };
          outcomes.rejected += 1;
          await writeLine(outcomeOutput, outcome);
          await writeLine(exclusionOutput, outcome);
          continue;
        }
        const reasons = enrichmentReasons(item, normalized.staged);
        const hasApiNutritionPair = normalized.staged.nutrition.per100g.calories !== null
          && normalized.staged.nutrition.per100g.calories > 0
          && normalized.staged.nutrition.per100g.proteinGrams !== null;
        const hasApiIngredients = Boolean(normalized.staged.ingredients.raw);
        if (hasApiNutritionPair) coverage.nutritionPairs.apiResponses += 1;
        if (hasApiNutritionPair && !item.hasNutritionPair) {
          coverage.nutritionPairs.afterEnrichment += 1;
          if (item.marketedProtein) coverage.marketedNutritionPairs.afterEnrichment += 1;
        }
        if (hasApiIngredients) coverage.ingredientStatements.apiResponses += 1;
        if (hasApiIngredients && !item.hasIngredients) coverage.ingredientStatements.afterEnrichment += 1;
        const status: OutcomeStatus = reasons.length > 0 ? "enriched" : "unchanged";
        outcomes[status] += 1;
        stagedRecords += 1;
        await writeLine(stagedOutput, normalized.staged);
        await writeLine(indexOutput, { sourceRecordId: normalized.staged.sourceRecordId, contentHash: normalized.staged.contentHash });
        await writeLine(outcomeOutput, {
          requestedCode: item.requestedCode,
          returnedCode: normalized.staged.sourceRecordId,
          status,
          reasons,
          batch,
        } satisfies EnrichmentOutcome);
      }
    }
  } finally {
    await Promise.all([closeStream(stagedOutput), closeStream(outcomeOutput), closeStream(indexOutput), closeStream(exclusionOutput)]);
  }

  const accounted = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
  if (accounted !== summaries.length) throw new Error(`API enrichment accounting mismatch: ${accounted} outcomes for ${summaries.length} requested barcodes.`);
  const completedAt = new Date().toISOString();
  const sourceComplete = outcomes.failed === 0;
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source: "open_food_facts_api",
    sourceKind: "open_data",
    sourceAuthority: { identity: 45, nutrition: 40, ingredients: 40 },
    sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    sourceRetentionNotes: "Open Food Facts documented multi-code API enrichment; ODbL attribution and share-alike obligations apply.",
    adapterVersion: OPEN_FOOD_FACTS_API_ADAPTER_VERSION,
    input: basename(options.input),
    inputHash,
    inputBytes: inputStats.size,
    sourceUpdatedAt: null,
    startedAt,
    completedAt,
    mode: options.mode,
    terminalEvidence: sourceComplete ? "end_of_file" : "error",
    sourceComplete,
    marketComplete: false,
    advertisedTotal: summaries.length,
    recordsRead: summaries.length,
    indiaRecords: summaries.length,
    stagedRecords,
    invalidRecords: outcomes.rejected,
    duplicateRecords: 0,
    newRecords: stagedRecords,
    changedRecords: 0,
    unchangedRecords: outcomes.unchanged,
    missingSinceRecords: outcomes.not_found,
    knownExclusions: ["Requested source barcode not returned by the API", "API product failed identity normalization"],
    disconnectedSources: ["gs1_india_datakart", "brand_owner_feeds", "retailer_offer_feeds"],
  };
  const report = {
    generatedAt: completedAt,
    sourceComplete,
    marketComplete: false,
    requestedBarcodes: summaries.length,
    accountedBarcodes: accounted,
    stagedRecords,
    outcomes,
    issueCounts,
    batches: Math.ceil(summaries.length / batchSize),
    fetchedBatches,
    resumedBatches,
    fallbackSplits,
    coverage: {
      nutritionPairs: {
        ...coverage.nutritionPairs,
        delta: coverage.nutritionPairs.afterEnrichment - coverage.nutritionPairs.baseline,
      },
      ingredientStatements: {
        ...coverage.ingredientStatements,
        delta: coverage.ingredientStatements.afterEnrichment - coverage.ingredientStatements.baseline,
      },
      marketedNutritionPairs: {
        ...coverage.marketedNutritionPairs,
        delta: coverage.marketedNutritionPairs.afterEnrichment - coverage.marketedNutritionPairs.baseline,
      },
    },
    minimumIntervalMs,
    maximumRequestBatchSize,
    requestSchema: OPEN_FOOD_FACTS_API_REQUEST_SCHEMA,
    inputManifestHash: sourceManifest.inputHash,
    continuity: {
      baselineAvailable: false,
      currentStagedRecords: stagedRecords,
      previousStagedRecords: null,
      missingSinceRecords: 0,
      maximumDropRatio: 0,
    },
    exclusions: {
      records: outcomes.not_found + outcomes.rejected + outcomes.failed,
      path: basename(exclusionsPath),
      reconcilesIndiaSlice: stagedRecords + outcomes.not_found + outcomes.rejected + outcomes.failed === summaries.length,
    },
  };
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);
  if (!sourceComplete) throw new Error(`API enrichment incomplete: ${outcomes.failed} barcodes failed after retry; artifacts were preserved.`);
  return { stagedPath, outcomesPath, indexPath, exclusionsPath, manifestPath, reportPath, manifest, outcomes };
}
