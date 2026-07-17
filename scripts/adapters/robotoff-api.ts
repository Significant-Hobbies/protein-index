import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { once } from "node:events";
import { normalizeGtin, normalizeText, parseQuantity } from "../../shared/gtin";
import { finiteNumber } from "../../shared/nutrition";
import type { SourceManifest, StagedProduct } from "../../shared/types";
import {
  validateExtractionAttempt,
  validateExtractionAttemptLabel,
  validateLabelEvidenceAsset,
  type ExtractionAttempt,
  type ExtractionAttemptLabel,
  type ExtractionOutcomeStatus,
  type LabelEvidenceAsset,
} from "../../shared/extraction-outcomes";
import { parseRobotoffNutritionEvidence, type RobotoffProductContext } from "./robotoff";
import {
  createExtractionAttempt,
  createExtractionAttemptLabel,
  createLabelEvidenceAsset,
  hashHttpsLabelImage,
  labelReferenceFromUrl,
  labelAssetReuseKey,
  predictionLabelReference,
  readPriorLabelAssets,
  stableExtractionId,
  stagedProductId,
  stagedSourceRecordId,
  type LabelImageFetchLike,
  type LabelImageReference,
} from "./label-image";

export const ROBOTOFF_API_ADAPTER_VERSION = "robotoff-api-v8";
export const ROBOTOFF_IMAGE_PREDICTIONS_URL = "https://robotoff.openfoodfacts.org/api/v1/image_predictions";
const PAGE_SIZE = 50;
export const ROBOTOFF_API_REQUEST_SCHEMA = createHash("sha256")
  .update(`${ROBOTOFF_IMAGE_PREDICTIONS_URL}:nutrition_extractor:${PAGE_SIZE}`)
  .digest("hex");

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type OutcomeStatus = ExtractionOutcomeStatus;

interface StoredResponse {
  requestedCode: string;
  requestSchema: string;
  fetchedAt: string;
  response: { image_predictions: Array<Record<string, unknown>> };
}

export interface ExtractionOutcome {
  requestedCode: string;
  status: OutcomeStatus;
  predictions: number;
  candidates: number;
  stagedRecords: number;
  reasons: string[];
}

interface NutritionExtractionContext extends RobotoffProductContext {
  nutritionImageUrl: string;
  product: StagedProduct;
}

interface NutritionCohortRow {
  code: string;
  subjectSourceRecordKey: string;
  nutritionImageUrl: string;
  subjectSourceRecordId: string;
  subjectSourceContentHash: string;
  productId: string;
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
  labelFetcher?: LabelImageFetchLike;
  maximumLabelBytes?: number;
  maximumLabelChunks?: number;
  userAgent?: string;
}

export interface RobotoffApiResult {
  stagedPath: string;
  outcomesPath: string;
  indexPath: string;
  exclusionsPath: string;
  manifestPath: string;
  reportPath: string;
  cohortPath: string;
  labelAssetsPath: string;
  extractionAttemptsPath: string;
  extractionAttemptLabelsPath: string;
  checksumsPath: string;
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

async function readContexts(path: string, limit: number | null): Promise<NutritionExtractionContext[]> {
  const contexts: NutritionExtractionContext[] = [];
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
      product,
    });
    if (limit !== null && contexts.length >= limit) break;
  }
  return contexts;
}

function cohortRow(context: NutritionExtractionContext): NutritionCohortRow {
  return {
    code: context.code,
    subjectSourceRecordKey: context.product.sourceRecordId,
    nutritionImageUrl: context.nutritionImageUrl,
    subjectSourceRecordId: stagedSourceRecordId(context.product),
    subjectSourceContentHash: context.product.contentHash,
    productId: stagedProductId(context.product),
  };
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function bindNutritionCandidate(
  product: StagedProduct,
  attemptId: string,
  assetsByUrl: Map<string, LabelEvidenceAsset>,
): StagedProduct {
  const rawEvidence = record(product.rawEvidence);
  const candidate = record(rawEvidence?.candidate);
  const predictionReference = predictionLabelReference(rawEvidence?.prediction);
  const candidateUrl = typeof candidate?.imageUrl === "string" ? candidate.imageUrl : predictionReference?.url ?? null;
  const asset = candidateUrl ? assetsByUrl.get(candidateUrl) : null;
  if (!rawEvidence || !asset) return product;
  const next = structuredClone(product);
  const nextRaw = next.rawEvidence as Record<string, unknown>;
  nextRaw.extractionAttemptId = attemptId;
  nextRaw.labelAssetId = asset.id;
  nextRaw.labelContentSha256 = asset.contentSha256;
  for (const issue of next.validationIssues) {
    issue.details = {
      ...issue.details,
      extractionAttemptId: attemptId,
      labelAssetId: asset.id,
      labelContentSha256: asset.contentSha256,
    };
  }
  next.contentHash = jsonHash(nextRaw);
  return next;
}

async function writeChecksums(directory: string, files: string[], outputPath: string): Promise<void> {
  const lines: string[] = [];
  for (const file of [...files].sort()) lines.push(`${await hashFile(join(directory, file))}  ${file}`);
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function parseJsonLines<T>(value: string, label: string): T[] {
  return value.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      throw new Error(`${label} contains invalid JSON on line ${index + 1}`);
    }
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
  const priorLabelAssets = await readPriorLabelAssets(join(options.outputDirectory, "prior-label-assets.jsonl"));
  const responsesDirectory = join(options.outputDirectory, "responses");
  await mkdir(responsesDirectory, { recursive: true });
  const cohortPath = join(options.outputDirectory, "cohort.jsonl");
  const labelAssetsPath = join(options.outputDirectory, "label-assets.jsonl");
  const extractionAttemptsPath = join(options.outputDirectory, "extraction-attempts.jsonl");
  const extractionAttemptLabelsPath = join(options.outputDirectory, "extraction-attempt-labels.jsonl");
  const stagedPath = join(options.outputDirectory, "staged-products.jsonl");
  const outcomesPath = join(options.outputDirectory, "outcomes.jsonl");
  const indexPath = join(options.outputDirectory, "source-index.jsonl");
  const exclusionsPath = join(options.outputDirectory, "exclusions.jsonl");
  const manifestPath = join(options.outputDirectory, "manifest.json");
  const reportPath = join(options.outputDirectory, "report.json");
  const checksumsPath = join(options.outputDirectory, "checksums.sha256");
  await writeFile(cohortPath, `${contexts.map((context) => JSON.stringify(cohortRow(context))).join("\n")}\n`, "utf8");
  const labelAssetOutput = createWriteStream(labelAssetsPath, { encoding: "utf8" });
  const extractionAttemptOutput = createWriteStream(extractionAttemptsPath, { encoding: "utf8" });
  const extractionAttemptLabelOutput = createWriteStream(extractionAttemptLabelsPath, { encoding: "utf8" });
  const stagedOutput = createWriteStream(stagedPath, { encoding: "utf8" });
  const outcomeOutput = createWriteStream(outcomesPath, { encoding: "utf8" });
  const indexOutput = createWriteStream(indexPath, { encoding: "utf8" });
  const exclusionOutput = createWriteStream(exclusionsPath, { encoding: "utf8" });
  const outcomes: Record<OutcomeStatus, number> = { candidate: 0, no_prediction: 0, rejected: 0, failed: 0 };
  const issueCounts: Record<string, number> = {};
  const modelVersions: Record<string, number> = {};
  const startedAt = new Date().toISOString();
  const extractionRunId = stableExtractionId(
    "xrun",
    `nutrition:${sourceManifest.inputHash ?? inputHash}:${startedAt}:${ROBOTOFF_API_ADAPTER_VERSION}:${ROBOTOFF_API_REQUEST_SCHEMA}`,
  );
  const parentSourceRunId = stableExtractionId(
    "run",
    `${sourceManifest.source}:${sourceManifest.startedAt}:${sourceManifest.inputHash ?? sourceManifest.input}`,
  );
  let stagedRecords = 0;
  let fetchedBarcodes = 0;
  let resumedBarcodes = 0;
  let requests = 0;
  let lastFetchStartedAt: number | null = null;
  const fetcher = options.fetcher ?? fetch;
  const labelFetcher = options.labelFetcher ?? fetch;
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

      const responseEvidenceHash = jsonHash(stored);
      const attemptedAt = startedAt;
      const requestedReference = labelReferenceFromUrl(context.nutritionImageUrl);
      const predictionRecords = stored.response.image_predictions.filter((prediction) => prediction.type === "nutrition_extraction");
      const predictionReferences = predictionRecords.map((prediction) => ({
        prediction,
        reference: predictionLabelReference(prediction),
      }));
      if (predictionReferences.some(({ reference }) => reference === null)) {
        const reason = "prediction_label_reference_missing";
        const failed = createExtractionAttempt({
          extractionRunId,
          subjectSourceRecordId: stagedSourceRecordId(context.product),
          subjectSourceRecordKey: context.product.sourceRecordId,
          subjectSourceContentHash: context.product.contentHash,
          productId: stagedProductId(context.product),
          fieldFamily: "nutrition",
          responseEvidenceHash,
          status: "failed",
          predictionCount: predictionRecords.length,
          candidateCount: 0,
          rejectionCount: 0,
          failureCount: 1,
          conflictCount: 0,
          reasons: [reason],
          attemptedAt,
          isCurrent: false,
        });
        await writeLine(extractionAttemptOutput, failed);
        const outcome: ExtractionOutcome = { requestedCode: context.code, status: "failed", predictions: predictionRecords.length, candidates: 0, stagedRecords: 0, reasons: [reason] };
        outcomes.failed += 1;
        await writeLine(outcomeOutput, outcome);
        await writeLine(exclusionOutput, outcome);
        continue;
      }
      const references = new Map<string, LabelImageReference>();
      references.set(requestedReference.url, requestedReference);
      for (const item of predictionReferences) references.set(item.reference!.url, item.reference!);
      const assetsByUrl = new Map<string, LabelEvidenceAsset>();
      let labelFailure: string | null = null;
      for (const reference of references.values()) {
        try {
          const reusable = priorLabelAssets.get(labelAssetReuseKey({
            subjectSourceRecordId: stagedSourceRecordId(context.product),
            subjectSourceContentHash: context.product.contentHash,
            fieldFamily: "nutrition",
            requestedUrl: reference.url,
          }));
          if (reusable && reusable.productId === stagedProductId(context.product)) {
            assetsByUrl.set(reference.url, reusable);
            await writeLine(labelAssetOutput, reusable);
            continue;
          }
          const hashed = await hashHttpsLabelImage({
            url: reference.url,
            fetcher: labelFetcher,
            maximumBytes: options.maximumLabelBytes,
            maximumChunks: options.maximumLabelChunks,
            userAgent,
          });
          const asset = createLabelEvidenceAsset({ product: context.product, fieldFamily: "nutrition", reference, hash: hashed });
          assetsByUrl.set(reference.url, asset);
          await writeLine(labelAssetOutput, asset);
        } catch (error) {
          labelFailure = error instanceof Error && "code" in error && typeof error.code === "string"
            ? `label_${error.code}`
            : "label_stream_read_failed";
          break;
        }
      }
      if (labelFailure) {
        const failed = createExtractionAttempt({
          extractionRunId,
          subjectSourceRecordId: stagedSourceRecordId(context.product),
          subjectSourceRecordKey: context.product.sourceRecordId,
          subjectSourceContentHash: context.product.contentHash,
          productId: stagedProductId(context.product),
          fieldFamily: "nutrition",
          responseEvidenceHash,
          status: "failed",
          predictionCount: predictionRecords.length,
          candidateCount: 0,
          rejectionCount: 0,
          failureCount: 1,
          conflictCount: 0,
          reasons: [labelFailure],
          attemptedAt,
          isCurrent: false,
        });
        await writeLine(extractionAttemptOutput, failed);
        const outcome: ExtractionOutcome = { requestedCode: context.code, status: "failed", predictions: predictionRecords.length, candidates: 0, stagedRecords: 0, reasons: [labelFailure] };
        outcomes.failed += 1;
        await writeLine(outcomeOutput, outcome);
        await writeLine(exclusionOutput, outcome);
        continue;
      }

      const parsed = parseRobotoffNutritionEvidence(stored.response, context, confidenceThreshold);
      for (const issue of parsed.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
      for (const candidate of parsed.candidates) {
        modelVersions[candidate.modelVersion] = (modelVersions[candidate.modelVersion] ?? 0) + 1;
      }
      const predictions = predictionRecords.length;
      const status: OutcomeStatus = parsed.candidates.length > 0 ? "candidate" : predictions > 0 ? "rejected" : "no_prediction";
      const reasons = status === "candidate"
        ? predictions > parsed.candidates.length ? ["partial_prediction_rejection"] : []
        : status === "no_prediction"
          ? ["no_nutrition_extraction_prediction"]
          : [...new Set(parsed.issues.map(({ code }) => code))];
      const conflictCount = parsed.staged.filter(({ rawEvidence }) => record(rawEvidence)?.crossImageConflict === true).length;
      const attempt = createExtractionAttempt({
        extractionRunId,
        subjectSourceRecordId: stagedSourceRecordId(context.product),
        subjectSourceRecordKey: context.product.sourceRecordId,
        subjectSourceContentHash: context.product.contentHash,
        productId: stagedProductId(context.product),
        fieldFamily: "nutrition",
        responseEvidenceHash,
        status,
        predictionCount: predictions,
        candidateCount: parsed.candidates.length,
        rejectionCount: predictions - parsed.candidates.length,
        failureCount: 0,
        conflictCount,
        reasons,
        attemptedAt,
        isCurrent: true,
      });
      await writeLine(extractionAttemptOutput, attempt);
      for (const product of parsed.staged.map((item) => bindNutritionCandidate(item, attempt.id, assetsByUrl))) {
        stagedRecords += 1;
        await writeLine(stagedOutput, product);
        await writeLine(indexOutput, { sourceRecordId: product.sourceRecordId, contentHash: product.contentHash });
      }
      const parsedByPrediction = new Map(parsed.staged.map((item) => {
        const raw = record(item.rawEvidence);
        const prediction = record(raw?.prediction);
        return [String(prediction?.id ?? ""), item] as const;
      }));
      const predictionGroups = new Map<string, Array<{ prediction: Record<string, unknown>; reference: LabelImageReference }>>();
      for (const item of predictionReferences) {
        const current = predictionGroups.get(item.reference!.url) ?? [];
        current.push({ prediction: item.prediction, reference: item.reference! });
        predictionGroups.set(item.reference!.url, current);
      }
      const labelUrls = new Set<string>();
      for (const [url, group] of predictionGroups) {
        const asset = assetsByUrl.get(url)!;
        const stagedForGroup = group.map(({ prediction }) => parsedByPrediction.get(String(prediction.id ?? ""))).filter(Boolean) as StagedProduct[];
        const candidateHashes = stagedForGroup.flatMap((item) => {
          const hash = record(item.rawEvidence)?.candidateHash;
          return typeof hash === "string" ? [hash] : [];
        });
        const predictionCount = group.length;
        const candidateCount = candidateHashes.length;
        const outcome: OutcomeStatus = candidateCount > 0 ? "candidate" : "rejected";
        const labelReasons = outcome === "candidate"
          ? predictionCount > candidateCount ? ["partial_prediction_rejection"] : []
          : [...new Set(stagedForGroup.flatMap(({ validationIssues }) => validationIssues.map(({ code }) => code)))];
        await writeLine(extractionAttemptLabelOutput, createExtractionAttemptLabel({
          attemptId: attempt.id,
          labelAssetId: asset.id,
          role: url === requestedReference.url ? "requested" : "prediction",
          outcome,
          predictionCount,
          candidateCount,
          rejectionCount: predictionCount - candidateCount,
          failureCount: 0,
          conflictCount: stagedForGroup.filter(({ rawEvidence }) => record(rawEvidence)?.crossImageConflict === true).length,
          candidateHashes,
          reasons: labelReasons.length > 0 ? labelReasons : outcome === "rejected" ? ["nutrition_prediction_rejected"] : [],
        }));
        labelUrls.add(url);
      }
      if (!labelUrls.has(requestedReference.url)) {
        await writeLine(extractionAttemptLabelOutput, createExtractionAttemptLabel({
          attemptId: attempt.id,
          labelAssetId: assetsByUrl.get(requestedReference.url)!.id,
          role: "requested",
          outcome: "no_prediction",
          predictionCount: 0,
          candidateCount: 0,
          rejectionCount: 0,
          failureCount: 0,
          conflictCount: 0,
          candidateHashes: [],
          reasons: ["no_prediction_for_requested_label"],
        }));
      }
      const outcome: ExtractionOutcome = {
        requestedCode: context.code,
        status,
        predictions,
        candidates: parsed.candidates.length,
        stagedRecords: parsed.staged.length,
        reasons,
      };
      outcomes[status] += 1;
      await writeLine(outcomeOutput, outcome);
      if (status !== "candidate") await writeLine(exclusionOutput, outcome);
    }
  } finally {
    await Promise.all([
      closeStream(labelAssetOutput),
      closeStream(extractionAttemptOutput),
      closeStream(extractionAttemptLabelOutput),
      closeStream(stagedOutput),
      closeStream(outcomeOutput),
      closeStream(indexOutput),
      closeStream(exclusionOutput),
    ]);
  }

  const accounted = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
  if (accounted !== contexts.length) throw new Error(`Robotoff accounting mismatch: ${accounted} outcomes for ${contexts.length} requested barcodes.`);
  const completedAt = new Date().toISOString();
  const [labelAssets, extractionAttempts, extractionAttemptLabels] = await Promise.all([
    readFile(labelAssetsPath, "utf8").then((value) => parseJsonLines<LabelEvidenceAsset>(value, "label-assets.jsonl")),
    readFile(extractionAttemptsPath, "utf8").then((value) => parseJsonLines<ExtractionAttempt>(value, "extraction-attempts.jsonl")),
    readFile(extractionAttemptLabelsPath, "utf8").then((value) => parseJsonLines<ExtractionAttemptLabel>(value, "extraction-attempt-labels.jsonl")),
  ]);
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
    modelVersions,
    fetchedBarcodes,
    resumedBarcodes,
    requests,
    minimumIntervalMs,
    confidenceThreshold,
    requestSchema: ROBOTOFF_API_REQUEST_SCHEMA,
    inputManifestHash: sourceManifest.inputHash,
    extractionRunId,
    parentSourceRunId,
    labelAssets: labelAssets.length,
    extractionAttempts: extractionAttempts.length,
    extractionAttemptLabels: extractionAttemptLabels.length,
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
  const responseFiles = (await readdir(responsesDirectory))
    .filter((name) => /^\d{14}\.json$/.test(name))
    .map((name) => `responses/${name}`);
  await writeChecksums(options.outputDirectory, [
    basename(cohortPath),
    basename(labelAssetsPath),
    basename(extractionAttemptsPath),
    basename(extractionAttemptLabelsPath),
    basename(stagedPath),
    basename(indexPath),
    basename(outcomesPath),
    basename(exclusionsPath),
    basename(manifestPath),
    basename(reportPath),
    ...responseFiles,
  ], checksumsPath);
  if (!sourceComplete) throw new Error(`Robotoff extraction incomplete: ${outcomes.failed} barcodes failed after retry; artifacts were preserved.`);
  return {
    stagedPath,
    outcomesPath,
    indexPath,
    exclusionsPath,
    manifestPath,
    reportPath,
    cohortPath,
    labelAssetsPath,
    extractionAttemptsPath,
    extractionAttemptLabelsPath,
    checksumsPath,
    manifest,
    outcomes,
  };
}

export interface RobotoffNutritionArtifact {
  manifest: SourceManifest;
  report: Record<string, unknown>;
  outcomes: ExtractionOutcome[];
  staged: StagedProduct[];
  labelAssets: LabelEvidenceAsset[];
  extractionAttempts: ExtractionAttempt[];
  extractionAttemptLabels: ExtractionAttemptLabel[];
}

export async function validateRobotoffNutritionArtifact(directory: string): Promise<RobotoffNutritionArtifact> {
  const files = {
    manifest: "manifest.json",
    report: "report.json",
    cohort: "cohort.jsonl",
    outcomes: "outcomes.jsonl",
    staged: "staged-products.jsonl",
    index: "source-index.jsonl",
    exclusions: "exclusions.jsonl",
    assets: "label-assets.jsonl",
    attempts: "extraction-attempts.jsonl",
    labels: "extraction-attempt-labels.jsonl",
    checksums: "checksums.sha256",
  } as const;
  let assetsText: string;
  try {
    assetsText = await readFile(join(directory, files.assets), "utf8");
  } catch {
    throw new Error("Nutrition artifact is legacy or incomplete: label-assets.jsonl is required");
  }
  const [manifestText, reportText, cohortText, outcomesText, stagedText, indexText, exclusionsText, attemptsText, labelsText, checksumsText] = await Promise.all([
    readFile(join(directory, files.manifest), "utf8"),
    readFile(join(directory, files.report), "utf8"),
    readFile(join(directory, files.cohort), "utf8"),
    readFile(join(directory, files.outcomes), "utf8"),
    readFile(join(directory, files.staged), "utf8"),
    readFile(join(directory, files.index), "utf8"),
    readFile(join(directory, files.exclusions), "utf8"),
    readFile(join(directory, files.attempts), "utf8"),
    readFile(join(directory, files.labels), "utf8"),
    readFile(join(directory, files.checksums), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as SourceManifest;
  const report = JSON.parse(reportText) as Record<string, unknown>;
  const cohort = parseJsonLines<NutritionCohortRow>(cohortText, files.cohort);
  const outcomes = parseJsonLines<ExtractionOutcome>(outcomesText, files.outcomes);
  const staged = parseJsonLines<StagedProduct>(stagedText, files.staged);
  const sourceIndex = parseJsonLines<{ sourceRecordId: string; contentHash: string }>(indexText, files.index);
  const exclusions = parseJsonLines<ExtractionOutcome>(exclusionsText, files.exclusions);
  const labelAssets = parseJsonLines<LabelEvidenceAsset>(assetsText, files.assets);
  const extractionAttempts = parseJsonLines<ExtractionAttempt>(attemptsText, files.attempts);
  const extractionAttemptLabels = parseJsonLines<ExtractionAttemptLabel>(labelsText, files.labels);

  const checksumByFile = new Map<string, string>();
  for (const line of checksumsText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) throw new Error(`Nutrition artifact checksum line is malformed: ${line}`);
    const file = match[2].replace(/^\.\//, "");
    if (isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => !part || part === "..")) {
      throw new Error(`Nutrition artifact checksum path is unsafe: ${match[2]}`);
    }
    if (checksumByFile.has(file)) throw new Error(`Nutrition artifact checksum repeats ${file}`);
    checksumByFile.set(file, match[1]);
  }
  const required = Object.values(files).filter((file) => file !== files.checksums);
  const responseNames = (await readdir(join(directory, "responses"))).sort();
  const expectedResponseNames = cohort.map(({ code }) => `${code}.json`).sort();
  if (JSON.stringify(responseNames) !== JSON.stringify(expectedResponseNames)) {
    throw new Error("Nutrition artifact response files do not exactly match the cohort");
  }
  const expectedFiles = new Set([...required, ...expectedResponseNames.map((name) => `responses/${name}`)]);
  if (checksumByFile.size !== expectedFiles.size || [...checksumByFile.keys()].some((file) => !expectedFiles.has(file))) {
    throw new Error("Nutrition artifact checksums do not exactly match retained evidence files");
  }
  for (const file of expectedFiles) {
    if (await hashFile(join(directory, file)) !== checksumByFile.get(file)) throw new Error(`Nutrition artifact checksum mismatch for ${file}`);
  }
  if (manifest.source !== "open_food_facts_robotoff" || manifest.adapterVersion !== ROBOTOFF_API_ADAPTER_VERSION) {
    throw new Error("Nutrition artifact source or adapter version has drifted");
  }
  if (!manifest.sourceComplete || manifest.terminalEvidence !== "end_of_file" || report.sourceComplete !== true) {
    throw new Error("Nutrition artifact is not source complete");
  }
  if (report.requestSchema !== ROBOTOFF_API_REQUEST_SCHEMA) throw new Error("Nutrition artifact request schema has drifted");
  if (typeof report.extractionRunId !== "string" || !/^xrun_[a-f0-9]{24}$/.test(report.extractionRunId)
    || typeof report.parentSourceRunId !== "string" || !/^run_[a-f0-9]{24}$/.test(report.parentSourceRunId)) {
    throw new Error("Nutrition artifact extraction lineage is incomplete");
  }
  if (report.labelAssets !== labelAssets.length || report.extractionAttempts !== extractionAttempts.length
    || report.extractionAttemptLabels !== extractionAttemptLabels.length) {
    throw new Error("Nutrition artifact exact extraction ledger counts do not reconcile");
  }
  if (cohort.length === 0 || outcomes.length !== cohort.length || extractionAttempts.length !== cohort.length) {
    throw new Error("Nutrition artifact cohort and attempt accounting is incomplete");
  }
  const cohortByCode = new Map<string, NutritionCohortRow>();
  const cohortBySourceKey = new Map<string, NutritionCohortRow>();
  for (const row of cohort) {
    if (!normalizeGtin(row.code) || cohortByCode.has(row.code) || cohortBySourceKey.has(row.subjectSourceRecordKey) || !row.nutritionImageUrl.startsWith("https://")) {
      throw new Error("Nutrition artifact cohort contains an invalid or duplicate row");
    }
    cohortByCode.set(row.code, row);
    cohortBySourceKey.set(row.subjectSourceRecordKey, row);
  }
  const assetById = new Map<string, LabelEvidenceAsset>();
  for (const asset of labelAssets) {
    const errors = validateLabelEvidenceAsset(asset);
    if (errors.length > 0) throw new Error(`Nutrition label asset is invalid: ${errors.join("; ")}`);
    if (asset.fieldFamily !== "nutrition" || assetById.has(asset.id)) throw new Error("Nutrition artifact has a duplicate or wrong-family label asset");
    assetById.set(asset.id, asset);
  }
  const attemptById = new Map<string, ExtractionAttempt>();
  const attemptByCode = new Map<string, ExtractionAttempt>();
  for (const attempt of extractionAttempts) {
    const errors = validateExtractionAttempt(attempt);
    if (errors.length > 0) throw new Error(`Nutrition extraction attempt is invalid: ${errors.join("; ")}`);
    const subject = cohortBySourceKey.get(attempt.subjectSourceRecordKey);
    if (!subject || attempt.extractionRunId !== report.extractionRunId || attempt.fieldFamily !== "nutrition" || attempt.isCurrent !== true
      || subject.subjectSourceRecordId !== attempt.subjectSourceRecordId
      || subject.subjectSourceContentHash !== attempt.subjectSourceContentHash || subject.productId !== attempt.productId) {
      throw new Error("Nutrition extraction attempt does not match its accepted run or cohort subject");
    }
    if (attemptById.has(attempt.id) || attemptByCode.has(attempt.subjectSourceRecordKey)) throw new Error("Nutrition extraction attempt is duplicated");
    const response = JSON.parse(await readFile(join(directory, "responses", `${subject.code}.json`), "utf8"));
    if (jsonHash(response) !== attempt.responseEvidenceHash) throw new Error("Nutrition extraction response evidence hash does not match");
    attemptById.set(attempt.id, attempt);
    attemptByCode.set(attempt.subjectSourceRecordKey, attempt);
  }
  const labelsByAttempt = new Map<string, ExtractionAttemptLabel[]>();
  const labelIds = new Set<string>();
  const usedAssetIds = new Set<string>();
  for (const label of extractionAttemptLabels) {
    const errors = validateExtractionAttemptLabel(label);
    if (errors.length > 0) throw new Error(`Nutrition per-label outcome is invalid: ${errors.join("; ")}`);
    if (!attemptById.has(label.attemptId) || !assetById.has(label.labelAssetId) || labelIds.has(label.id)) {
      throw new Error("Nutrition per-label outcome has a missing or duplicate reference");
    }
    const attempt = attemptById.get(label.attemptId)!;
    const asset = assetById.get(label.labelAssetId)!;
    if (asset.subjectSourceRecordId !== attempt.subjectSourceRecordId
      || asset.subjectSourceContentHash !== attempt.subjectSourceContentHash
      || asset.productId !== attempt.productId || asset.fieldFamily !== attempt.fieldFamily) {
      throw new Error("Nutrition label asset does not match its attempt subject binding");
    }
    labelIds.add(label.id);
    usedAssetIds.add(label.labelAssetId);
    const rows = labelsByAttempt.get(label.attemptId) ?? [];
    rows.push(label);
    labelsByAttempt.set(label.attemptId, rows);
  }
  if (usedAssetIds.size !== assetById.size) throw new Error("Nutrition artifact contains an unlinked label asset");
  for (const attempt of extractionAttempts) {
    const labels = labelsByAttempt.get(attempt.id) ?? [];
    if (!labels.some(({ role }) => role === "requested")) throw new Error("Nutrition attempt has no requested label outcome");
    for (const field of ["predictionCount", "candidateCount", "rejectionCount", "failureCount", "conflictCount"] as const) {
      if (attempt[field] !== labels.reduce((sum, label) => sum + label[field], 0)) {
        throw new Error(`Nutrition attempt ${field} does not reconcile with per-label outcomes`);
      }
    }
  }
  const outcomeByCode = new Map(outcomes.map((outcome) => [outcome.requestedCode, outcome]));
  if (outcomeByCode.size !== cohort.length || cohort.some((row) => attemptByCode.get(row.subjectSourceRecordKey)?.status !== outcomeByCode.get(row.code)?.status)) {
    throw new Error("Nutrition outcome ledger does not match exact attempts");
  }
  const indexByRecord = new Map(sourceIndex.map((row) => [row.sourceRecordId, row.contentHash]));
  if (sourceIndex.length !== staged.length || indexByRecord.size !== sourceIndex.length) {
    throw new Error("Nutrition source index does not exactly account for staged rows");
  }
  const stagedCandidateHashes: string[] = [];
  for (const product of staged) {
    if (indexByRecord.get(product.sourceRecordId) !== product.contentHash) throw new Error("Nutrition staged record does not match its source index");
    const raw = record(product.rawEvidence);
    if (typeof raw?.candidateHash === "string") stagedCandidateHashes.push(raw.candidateHash);
    const attemptId = raw?.extractionAttemptId;
    const assetId = raw?.labelAssetId;
    const asset = typeof assetId === "string" ? assetById.get(assetId) : null;
    if (typeof attemptId !== "string" || !attemptById.has(attemptId) || !asset || raw?.labelContentSha256 !== asset.contentSha256) {
      throw new Error("Nutrition candidate is not bound to its exact extraction attempt and label bytes");
    }
    const attempt = attemptById.get(attemptId)!;
    if (asset.subjectSourceRecordId !== attempt.subjectSourceRecordId || asset.productId !== attempt.productId) {
      throw new Error("Nutrition staged prediction subject binding is inconsistent");
    }
  }
  const labelCandidateHashes = extractionAttemptLabels.flatMap(({ candidateHashes }) => candidateHashes).sort();
  if (JSON.stringify(stagedCandidateHashes.sort()) !== JSON.stringify(labelCandidateHashes)) {
    throw new Error("Nutrition candidate hashes do not reconcile with per-label outcomes");
  }
  const countedModelVersions: Record<string, number> = {};
  for (const product of staged) {
    const candidate = record(record(product.rawEvidence)?.candidate);
    const modelVersion = candidate?.modelVersion;
    if (typeof modelVersion === "string") countedModelVersions[modelVersion] = (countedModelVersions[modelVersion] ?? 0) + 1;
  }
  const canonicalCounts = (value: Record<string, number>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
  if (!record(report.modelVersions) || canonicalCounts(report.modelVersions as Record<string, number>) !== canonicalCounts(countedModelVersions)) {
    throw new Error("Nutrition artifact model-version counts do not reconcile");
  }
  const expectedExclusions = outcomes.filter(({ status }) => status !== "candidate");
  if (exclusions.length !== expectedExclusions.length) throw new Error("Nutrition exclusion accounting does not reconcile");
  return { manifest, report, outcomes, staged, labelAssets, extractionAttempts, extractionAttemptLabels };
}
