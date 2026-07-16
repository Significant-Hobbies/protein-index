import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { normalizeGtin, normalizeText, parseQuantity } from "../../shared/gtin";
import { finiteNumber } from "../../shared/nutrition";
import type { SourceManifest, StagedProduct } from "../../shared/types";
import { parseRobotoffNutritionEvidence, type RobotoffProductContext } from "./robotoff";

export const ROBOTOFF_API_ADAPTER_VERSION = "robotoff-api-v4";
export const ROBOTOFF_IMAGE_PREDICTIONS_URL = "https://robotoff.openfoodfacts.org/api/v1/image_predictions";
const PAGE_SIZE = 50;
export const ROBOTOFF_API_REQUEST_SCHEMA = createHash("sha256")
  .update(`${ROBOTOFF_IMAGE_PREDICTIONS_URL}:nutrition_extractor:${PAGE_SIZE}`)
  .digest("hex");

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type OutcomeStatus = "candidate" | "no_prediction" | "rejected" | "failed";

interface StoredResponse {
  requestedCode: string;
  requestSchema: string;
  fetchedAt: string;
  response: { image_predictions: Array<Record<string, unknown>> };
}

interface ExtractionOutcome {
  requestedCode: string;
  status: OutcomeStatus;
  predictions: number;
  candidates: number;
  stagedRecords: number;
  reasons: string[];
}

export interface RobotoffApiOptions {
  input: string;
  inputManifest: string;
  outputDirectory: string;
  mode: "sample" | "production";
  limit: number | null;
  confidenceThreshold?: number;
  minimumIntervalMs?: number;
  retryBaseMs?: number;
  maximumAttempts?: number;
  fetcher?: FetchLike;
  userAgent?: string;
}

export interface RobotoffApiResult {
  stagedPath: string;
  outcomesPath: string;
  indexPath: string;
  exclusionsPath: string;
  manifestPath: string;
  reportPath: string;
  manifest: SourceManifest;
  outcomes: Record<OutcomeStatus, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function explicitServingMass(product: StagedProduct): number | null {
  const evidence = isRecord(product.rawEvidence) ? product.rawEvidence : null;
  const rawServing = typeof evidence?.serving_size === "string" ? evidence.serving_size : null;
  const parsed = parseQuantity(rawServing);
  if (parsed) return parsed.grams;
  const value = finiteNumber(evidence?.serving_quantity);
  if (value === null || value <= 0) return null;
  const rawUnit = typeof evidence?.serving_quantity_unit === "string" ? evidence.serving_quantity_unit : null;
  const unit = normalizeText(rawUnit);
  if (unit === "g" || unit === "gram" || unit === "grams") return value;
  if (unit === "kg" || unit === "kilogram" || unit === "kilograms") return value * 1000;
  return unit ? null : value;
}

function explicitServingVolume(product: StagedProduct): number | null {
  const evidence = isRecord(product.rawEvidence) ? product.rawEvidence : null;
  const rawServing = typeof evidence?.serving_size === "string" ? evidence.serving_size : null;
  const parsed = parseQuantity(rawServing);
  if (parsed?.millilitres != null) return parsed.millilitres;
  const value = finiteNumber(evidence?.serving_quantity);
  if (value === null || value <= 0) return null;
  const rawUnit = typeof evidence?.serving_quantity_unit === "string" ? evidence.serving_quantity_unit : null;
  const unit = normalizeText(rawUnit);
  if (["ml", "millilitre", "millilitres", "milliliter", "milliliters"].includes(unit)) return value;
  if (["cl", "centilitre", "centilitres", "centiliter", "centiliters"].includes(unit)) return value * 10;
  if (["dl", "decilitre", "decilitres", "deciliter", "deciliters"].includes(unit)) return value * 100;
  if (["l", "litre", "litres", "liter", "liters"].includes(unit)) return value * 1000;
  return null;
}

function explicitNutritionBasis(product: StagedProduct): RobotoffProductContext["nutritionBasis"] {
  const evidence = isRecord(product.rawEvidence) ? product.rawEvidence : null;
  const declared = typeof evidence?.nutrition_data_per === "string" ? normalizeText(evidence.nutrition_data_per) : "";
  const quantity = parseQuantity(typeof evidence?.quantity === "string" ? evidence.quantity : null);
  const serving = parseQuantity(typeof evidence?.serving_size === "string" ? evidence.serving_size : null);
  if (declared === "100ml" || declared === "per 100ml" || quantity?.millilitres != null || serving?.millilitres != null) {
    return "per_100ml";
  }
  return product.nutrition.basis;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return hash.digest("hex");
}

async function readContexts(path: string, limit: number | null): Promise<RobotoffProductContext[]> {
  const contexts: RobotoffProductContext[] = [];
  const seen = new Set<string>();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const product = JSON.parse(line) as StagedProduct;
    const code = product.gtin ? normalizeGtin(product.gtin) : null;
    if (!code || !product.nutritionImageUrl || seen.has(code)) continue;
    seen.add(code);
    contexts.push({
      code,
      brand: product.brand,
      name: product.name,
      flavour: product.flavour,
      category: product.category,
      categoryRaw: product.categoryRaw,
      netQuantityGrams: product.netQuantityGrams,
      servingSizeGrams: explicitServingMass(product),
      servingSizeMillilitres: explicitServingVolume(product),
      nutritionBasis: explicitNutritionBasis(product),
      sourceNutritionPer100g: product.nutrition.basis === "per_100g" ? product.nutrition.per100g : null,
      sourceNutritionPer100ml: product.nutrition.basis === "per_100ml" ? product.nutrition.per100g : null,
      imageUrl: product.imageUrl,
      nutritionImageUrl: product.nutritionImageUrl,
    });
    if (limit !== null && contexts.length >= limit) break;
  }
  return contexts;
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

function requestUrl(code: string, page: number): URL {
  const url = new URL(ROBOTOFF_IMAGE_PREDICTIONS_URL);
  url.searchParams.set("barcode", code);
  url.searchParams.set("model_name", "nutrition_extractor");
  url.searchParams.set("type", "nutrition_extraction");
  url.searchParams.set("count", String(PAGE_SIZE));
  url.searchParams.set("page", String(page));
  return url;
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

export async function extractRobotoffApi(options: RobotoffApiOptions): Promise<RobotoffApiResult> {
  const minimumIntervalMs = options.minimumIntervalMs ?? 1_100;
  const retryBaseMs = options.retryBaseMs ?? 2_000;
  const maximumAttempts = options.maximumAttempts ?? 5;
  const confidenceThreshold = options.confidenceThreshold ?? 0.85;
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) throw new Error("Robotoff request interval must be non-negative.");
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 8) throw new Error("Robotoff attempts must be between 1 and 8.");
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) throw new Error("Robotoff confidence threshold must be between 0 and 1.");
  if (options.mode === "production" && options.limit !== null) throw new Error("Production Robotoff extraction cannot use a barcode limit.");

  const sourceManifest = JSON.parse(await readFile(options.inputManifest, "utf8")) as SourceManifest;
  if (sourceManifest.source !== "open_food_facts" || !sourceManifest.sourceComplete || sourceManifest.terminalEvidence !== "end_of_file") {
    throw new Error("Robotoff extraction requires a source-complete Open Food Facts snapshot manifest.");
  }
  const inputStats = await stat(options.input);
  const inputHash = await hashFile(options.input);
  const contexts = await readContexts(options.input, options.limit);
  if (contexts.length === 0) throw new Error("Robotoff extraction found no valid barcodes with nutrition label images.");

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
  const outcomes: Record<OutcomeStatus, number> = { candidate: 0, no_prediction: 0, rejected: 0, failed: 0 };
  const issueCounts: Record<string, number> = {};
  const startedAt = new Date().toISOString();
  let stagedRecords = 0;
  let fetchedBarcodes = 0;
  let resumedBarcodes = 0;
  let requests = 0;
  let lastFetchStartedAt: number | null = null;
  const fetcher = options.fetcher ?? fetch;
  const userAgent = options.userAgent ?? "protein-index/0.1 (+https://github.com/sarthakagrawal927/protein-index; label-evidence)";

  const fetchPage = async (code: string, page: number): Promise<Record<string, unknown>[]> => {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let response: Response | null = null;
      try {
        if (lastFetchStartedAt !== null) await sleep(Math.max(0, minimumIntervalMs - (Date.now() - lastFetchStartedAt)));
        lastFetchStartedAt = Date.now();
        requests += 1;
        response = await fetcher(requestUrl(code, page), { headers: { Accept: "application/json", "User-Agent": userAgent } });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
          if (!retryable) throw new Error(`Robotoff returned HTTP ${response.status}`);
          lastError = new Error(`Robotoff returned retryable HTTP ${response.status}`);
        } else {
          const body: unknown = await response.json();
          if (!isRecord(body) || !Array.isArray(body.image_predictions) || !body.image_predictions.every(isRecord)) {
            throw new Error("Robotoff returned an invalid image-predictions response");
          }
          return body.image_predictions;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (response && response.status < 500 && response.status !== 429) throw lastError;
      }
      if (attempt < maximumAttempts) await sleep(retryDelay(response, attempt, retryBaseMs));
    }
    throw lastError ?? new Error("Robotoff request failed without a response");
  };

  const fetchAll = async (code: string): Promise<StoredResponse["response"]> => {
    const imagePredictions: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 20; page += 1) {
      const predictions = await fetchPage(code, page);
      imagePredictions.push(...predictions);
      if (predictions.length < PAGE_SIZE) return { image_predictions: imagePredictions };
    }
    throw new Error(`Robotoff pagination exceeded 20 pages for barcode ${code}`);
  };

  try {
    for (const context of contexts) {
      const responsePath = join(responsesDirectory, `${context.code}.json`);
      const errorPath = `${responsePath}.error.json`;
      let stored: StoredResponse;
      try {
        const existing = JSON.parse(await readFile(responsePath, "utf8")) as StoredResponse;
        if (existing.requestedCode !== context.code || existing.requestSchema !== ROBOTOFF_API_REQUEST_SCHEMA
          || !isRecord(existing.response) || !Array.isArray(existing.response.image_predictions)) {
          throw new Error(`Resume artifact ${basename(responsePath)} does not match the requested barcode.`);
        }
        stored = existing;
        resumedBarcodes += 1;
      } catch (error) {
        if (error instanceof SyntaxError || (error instanceof Error && !error.message.includes("ENOENT"))) throw error;
        try {
          stored = {
            requestedCode: context.code,
            requestSchema: ROBOTOFF_API_REQUEST_SCHEMA,
            fetchedAt: new Date().toISOString(),
            response: await fetchAll(context.code),
          };
          await writeFile(responsePath, `${JSON.stringify(stored)}\n`, "utf8");
          await unlink(errorPath).catch((unlinkError: NodeJS.ErrnoException) => {
            if (unlinkError.code !== "ENOENT") throw unlinkError;
          });
          fetchedBarcodes += 1;
        } catch (fetchError) {
          const reason = fetchError instanceof Error ? fetchError.message : String(fetchError);
          await writeFile(errorPath, `${JSON.stringify({ requestedCode: context.code, failedAt: new Date().toISOString(), error: reason }, null, 2)}\n`, "utf8");
          const outcome: ExtractionOutcome = { requestedCode: context.code, status: "failed", predictions: 0, candidates: 0, stagedRecords: 0, reasons: [reason] };
          outcomes.failed += 1;
          await writeLine(outcomeOutput, outcome);
          await writeLine(exclusionOutput, outcome);
          continue;
        }
      }

      const parsed = parseRobotoffNutritionEvidence(stored.response, context, confidenceThreshold);
      for (const issue of parsed.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
      for (const product of parsed.staged) {
        stagedRecords += 1;
        await writeLine(stagedOutput, product);
        await writeLine(indexOutput, { sourceRecordId: product.sourceRecordId, contentHash: product.contentHash });
      }
      const predictions = stored.response.image_predictions.filter((prediction) => prediction.type === "nutrition_extraction").length;
      const status: OutcomeStatus = parsed.candidates.length > 0 ? "candidate" : predictions > 0 ? "rejected" : "no_prediction";
      const outcome: ExtractionOutcome = {
        requestedCode: context.code,
        status,
        predictions,
        candidates: parsed.candidates.length,
        stagedRecords: parsed.staged.length,
        reasons: status === "candidate" ? [] : status === "no_prediction" ? ["no_nutrition_extraction_prediction"] : [...new Set(parsed.issues.map(({ code }) => code))],
      };
      outcomes[status] += 1;
      await writeLine(outcomeOutput, outcome);
      if (status !== "candidate") await writeLine(exclusionOutput, outcome);
    }
  } finally {
    await Promise.all([closeStream(stagedOutput), closeStream(outcomeOutput), closeStream(indexOutput), closeStream(exclusionOutput)]);
  }

  const accounted = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
  if (accounted !== contexts.length) throw new Error(`Robotoff accounting mismatch: ${accounted} outcomes for ${contexts.length} requested barcodes.`);
  const completedAt = new Date().toISOString();
  const sourceComplete = outcomes.failed === 0;
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source: "open_food_facts_robotoff",
    sourceKind: "open_data",
    sourceAuthority: { identity: 0, nutrition: 20, ingredients: 0 },
    sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    sourceRetentionNotes: "Robotoff model output is retained as review evidence and never auto-verified.",
    adapterVersion: ROBOTOFF_API_ADAPTER_VERSION,
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
    advertisedTotal: contexts.length,
    recordsRead: contexts.length,
    indiaRecords: contexts.length,
    stagedRecords,
    invalidRecords: outcomes.rejected,
    duplicateRecords: 0,
    newRecords: stagedRecords,
    changedRecords: 0,
    unchangedRecords: outcomes.no_prediction,
    missingSinceRecords: 0,
    knownExclusions: ["No nutrition-extraction prediction", "Prediction failed evidence validation"],
    disconnectedSources: ["gs1_india_datakart", "brand_owner_feeds"],
  };
  const report = {
    generatedAt: completedAt,
    sourceComplete,
    marketComplete: false,
    requestedBarcodes: contexts.length,
    accountedBarcodes: accounted,
    eligibleNutritionImages: contexts.length,
    stagedRecords,
    outcomes,
    issueCounts,
    fetchedBarcodes,
    resumedBarcodes,
    requests,
    minimumIntervalMs,
    confidenceThreshold,
    requestSchema: ROBOTOFF_API_REQUEST_SCHEMA,
    inputManifestHash: sourceManifest.inputHash,
    exclusions: {
      records: outcomes.no_prediction + outcomes.rejected + outcomes.failed,
      path: basename(exclusionsPath),
      reconcilesIndiaSlice: accounted === contexts.length,
    },
  };
  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);
  if (!sourceComplete) throw new Error(`Robotoff extraction incomplete: ${outcomes.failed} barcodes failed after retry; artifacts were preserved.`);
  return { stagedPath, outcomesPath, indexPath, exclusionsPath, manifestPath, reportPath, manifest, outcomes };
}
