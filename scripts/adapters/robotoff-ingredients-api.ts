import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { basename, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { ingredientCandidateHash, validateIngredientCandidate } from "../../shared/ingredient-evidence";
import { normalizeGtin } from "../../shared/gtin";
import { emptyNutrition } from "../../shared/nutrition";
import type { SourceManifest, StagedProduct, ValidationIssue } from "../../shared/types";
import {
  EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE,
  extractionAccountingSummary,
  isResidualExceptionReason,
  residualExceptionBoundsSatisfied,
  validateDecisionDriftEvidence,
  validateExtractionAccountingSummary,
  validateExtractionOutcomePartition,
  validateExtractionAttempt,
  validateExtractionAttemptLabel,
  validateLabelEvidenceAsset,
  type ExtractionAttempt,
  type ExtractionAttemptLabel,
  type LabelEvidenceAsset,
} from "../../shared/extraction-outcomes";
import { parseRobotoffIngredientEvidence } from "./robotoff-ingredients";
import { startExtractionProgress, type ExtractionProgressSink } from "./extraction-progress";
import { readCompletedResponseCodes } from "./response-cache";
import { RunBudget, type RunBudgetOptions, type RunBudgetSnapshot } from "./run-budget";
import {
  createExtractionAttempt,
  createExtractionAttemptLabel,
  createLabelEvidenceAsset,
  hashHttpsLabelImage,
  LabelImageHashError,
  labelReferenceFromUrl,
  labelAssetReuseKey,
  predictionLabelReference,
  readReusableLabelAssets,
  stableExtractionId,
  stagedProductId,
  stagedSourceRecordId,
  type LabelImageFetchLike,
  type LabelImageReference,
} from "./label-image";

export const ROBOTOFF_INGREDIENT_API_ADAPTER_VERSION = "robotoff-ingredients-api-v3";
export const ROBOTOFF_IMAGE_PREDICTIONS_URL = "https://robotoff.openfoodfacts.org/api/v1/image_predictions";
const PAGE_SIZE = 50;
export const ROBOTOFF_INGREDIENT_REQUEST_SCHEMA = createHash("sha256")
  .update(`${ROBOTOFF_IMAGE_PREDICTIONS_URL}:ner:ingredient_detection:${PAGE_SIZE}`)
  .digest("hex");

type RawRecord = Record<string, unknown>;
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type IngredientExtractionOutcomeStatus = "candidate" | "no_prediction" | "rejected" | "failed";

interface IngredientContext {
  code: string;
  ingredientImageUrl: string;
  product: StagedProduct;
}

interface IngredientCohortRow {
  code: string;
  subjectSourceRecordKey: string;
  ingredientImageUrl: string;
  subjectSourceRecordId: string;
  subjectSourceContentHash: string;
  productId: string;
}

interface StoredIngredientResponse {
  requestedCode: string;
  requestSchema: string;
  fetchedAt: string;
  response: { image_predictions: RawRecord[] };
}

export interface IngredientExtractionOutcome {
  requestedCode: string;
  status: IngredientExtractionOutcomeStatus;
  predictions: number;
  entities: number;
  candidates: number;
  reasons: string[];
}

export interface StoredIngredientCandidate {
  requestedCode: string;
  ingredientImageUrl: string;
  candidateHash: string;
  candidate: ReturnType<typeof parseRobotoffIngredientEvidence>["candidates"][number];
  issues: ValidationIssue[];
  hasConflict: boolean;
  prediction: RawRecord;
  extractionAttemptId?: string;
  labelAssetId?: string;
  labelContentSha256?: string;
}

export interface RobotoffIngredientApiOptions {
  input: string;
  inputManifest: string;
  outputDirectory: string;
  mode: "sample" | "production";
  limit: number | null;
  confidenceThreshold?: number;
  minimumIntervalMs?: number;
  retryBaseMs?: number;
  maximumAttempts?: number;
  requestTimeoutMs?: number;
  fetcher?: FetchLike;
  labelFetcher?: LabelImageFetchLike;
  maximumLabelBytes?: number;
  maximumLabelChunks?: number;
  budget?: RunBudgetOptions;
  userAgent?: string;
  progress?: ExtractionProgressSink;
  progressIntervalMs?: number;
}

export interface RobotoffIngredientApiResult {
  stagedPath: string;
  indexPath: string;
  candidatesPath: string;
  outcomesPath: string;
  exclusionsPath: string;
  cohortPath: string;
  manifestPath: string;
  reportPath: string;
  checksumsPath: string;
  labelAssetsPath: string;
  extractionAttemptsPath: string;
  extractionAttemptLabelsPath: string;
  contexts: number;
  inputHash: string;
  inputBytes: number;
  sourceManifest: SourceManifest;
  outcomes: Record<IngredientExtractionOutcomeStatus, number>;
  fetchedBarcodes: number;
  resumedBarcodes: number;
  requests: number;
  issueCounts: Record<string, number>;
  startedAt: string;
  completedAt: string;
  manifest: SourceManifest;
  report: RobotoffIngredientReport;
}

export interface RobotoffIngredientReport {
  generatedAt: string;
  sourceComplete: boolean;
  degraded: boolean;
  marketComplete: false;
  requestedBarcodes: number;
  accountedBarcodes: number;
  eligibleIngredientImages: number;
  candidateRecords: number;
  duplicateCandidates: number;
  outcomes: Record<IngredientExtractionOutcomeStatus, number>;
  issueCounts: Record<string, number>;
  modelVersions: Record<string, number>;
  languages: Record<string, number>;
  taxonomyRecognition: { belowSixtyPercent: number; atLeastSixtyPercent: number };
  fetchedBarcodes: number;
  resumedBarcodes: number;
  requests: number;
  minimumIntervalMs: number;
  requestTimeoutMs: number;
  confidenceThreshold: number;
  requestSchema: string;
  cohortHash: string;
  inputManifestHash: string | null;
  extractionRunId: string;
  parentSourceRunId: string;
  labelAssets: number;
  extractionAttempts: number;
  extractionAttemptLabels: number;
  outcomeAccountingComplete: boolean;
  verificationComplete: boolean;
  residualExceptionCount: number;
  residualExceptionRate: number;
  residualExceptionLimits: { maxCount: number; maxRate: number };
  budget: RunBudgetSnapshot;
  exclusions: { records: number; path: string; reconcilesIndiaSlice: boolean };
}

export interface RobotoffIngredientArtifact {
  manifest: SourceManifest;
  report: RobotoffIngredientReport;
  outcomes: IngredientExtractionOutcome[];
  candidates: StoredIngredientCandidate[];
  staged: StagedProduct[];
  labelAssets: LabelEvidenceAsset[];
  extractionAttempts: ExtractionAttempt[];
  extractionAttemptLabels: ExtractionAttemptLabel[];
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  await finished(stream);
  return hash.digest("hex");
}

async function readContexts(path: string, limit: number | null): Promise<IngredientContext[]> {
  const byCode = new Map<string, IngredientContext>();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const product = JSON.parse(line) as StagedProduct;
    const code = product.gtin ? normalizeGtin(product.gtin) : null;
    if (!code || !product.ingredientImageUrl || !validHttpsUrl(product.ingredientImageUrl) || byCode.has(code)) continue;
    byCode.set(code, { code, ingredientImageUrl: product.ingredientImageUrl, product });
  }
  const contexts = [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
  return limit === null ? contexts : contexts.slice(0, limit);
}

function ingredientCohortRow(context: IngredientContext): IngredientCohortRow {
  return {
    code: context.code,
    subjectSourceRecordKey: context.product.sourceRecordId,
    ingredientImageUrl: context.ingredientImageUrl,
    subjectSourceRecordId: stagedSourceRecordId(context.product),
    subjectSourceContentHash: context.product.contentHash,
    productId: stagedProductId(context.product),
  };
}

function jsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  // Full jitter: pick a random delay in [0, base * 2^(attempt-1)] to avoid
  // thundering-herd retries against the same upstream endpoint.
  const ceiling = Math.min(retryBaseMs * (2 ** (attempt - 1)), 60_000);
  return Math.floor(Math.random() * (ceiling + 1));
}

function requestUrl(code: string, page: number): URL {
  const url = new URL(ROBOTOFF_IMAGE_PREDICTIONS_URL);
  url.searchParams.set("barcode", code);
  url.searchParams.set("model_name", "ingredient_detection");
  url.searchParams.set("type", "ner");
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

function stageIngredientCandidate(
  context: IngredientContext,
  stored: StoredIngredientCandidate,
): StagedProduct {
  const candidate = stored.candidate;
  const sourceUrl = `${ROBOTOFF_IMAGE_PREDICTIONS_URL}?barcode=${encodeURIComponent(context.code)}&type=ner&model_name=ingredient_detection`;
  const rawEvidence = {
    prediction: stored.prediction,
    candidate,
    candidateHash: stored.candidateHash,
    hasConflict: stored.hasConflict,
    warnings: stored.issues,
    selectedIngredientImageUrl: context.ingredientImageUrl,
    extractionAttemptId: stored.extractionAttemptId ?? null,
    labelAssetId: stored.labelAssetId ?? null,
    labelContentSha256: stored.labelContentSha256 ?? null,
  };
  return {
    source: "open_food_facts_robotoff_ingredients",
    sourceKind: "open_data",
    sourceAuthority: { identity: 0, nutrition: 0, ingredients: 20 },
    sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    sourceRetentionNotes: "Robotoff ingredient model output is review evidence, not a verified ingredient statement.",
    sourceRecordId: `${context.code}:${candidate.predictionId}:${candidate.entityIndex}`,
    sourceUrl,
    observedAt: candidate.observedAt,
    contentHash: createHash("sha256").update(JSON.stringify(rawEvidence)).digest("hex"),
    gtinRaw: context.code,
    gtin: normalizeGtin(context.code),
    brand: context.product.brand,
    name: context.product.name,
    flavour: context.product.flavour,
    category: context.product.category,
    categoryRaw: context.product.categoryRaw,
    productKind: context.product.productKind,
    netQuantityGrams: context.product.netQuantityGrams,
    servingSizeGrams: context.product.servingSizeGrams,
    imageUrl: context.product.imageUrl,
    nutritionImageUrl: context.product.nutritionImageUrl,
    ingredientImageUrl: candidate.imageUrl,
    offers: [],
    ratings: [],
    nutrition: {
      per100g: emptyNutrition(),
      servingSizeGrams: context.product.servingSizeGrams,
      basis: "unknown",
      preparationState: "unknown",
      status: "missing",
      confidence: "low",
      source: "open_food_facts_robotoff_ingredients",
      observedAt: candidate.observedAt,
      labelVerifiedAt: null,
    },
    nutrients: [],
    ingredients: {
      raw: null,
      language: null,
      normalized: [],
      allergens: [],
      additives: [],
      status: "missing",
      confidence: "low",
      source: "open_food_facts_robotoff_ingredients",
      observedAt: candidate.observedAt,
    },
    classification: context.product.classification,
    completeness: context.product.completeness,
    completenessMissing: context.product.completenessMissing,
    rawEvidence,
    validationIssues: [{
      code: "robotoff_ingredient_candidate",
      message: stored.hasConflict
        ? "Robotoff produced conflicting ingredient-label candidates that require explicit review."
        : "Robotoff produced a plausible ingredient-label candidate that requires human review.",
      severity: stored.hasConflict ? "error" : "warning",
      field: "ingredients",
      details: {
        candidate,
        candidateHash: stored.candidateHash,
        hasConflict: stored.hasConflict,
        warnings: stored.issues,
        extractionAttemptId: stored.extractionAttemptId,
        labelAssetId: stored.labelAssetId,
        labelContentSha256: stored.labelContentSha256,
      },
    }],
  };
}

export function stageRobotoffIngredientCandidate(
  product: StagedProduct,
  stored: StoredIngredientCandidate,
): StagedProduct {
  const code = normalizeGtin(product.gtin);
  const ingredientImageUrl = product.ingredientImageUrl ?? stored.candidate.imageUrl;
  if (!code || !ingredientImageUrl || !validHttpsUrl(ingredientImageUrl)) {
    throw new Error("A valid GTIN and HTTPS ingredient image are required to stage a Robotoff ingredient candidate.");
  }
  return stageIngredientCandidate({ code, ingredientImageUrl, product }, stored);
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

export async function extractRobotoffIngredientApi(
  options: RobotoffIngredientApiOptions,
): Promise<RobotoffIngredientApiResult> {
  const minimumIntervalMs = options.minimumIntervalMs ?? 1_100;
  const retryBaseMs = options.retryBaseMs ?? 2_000;
  const maximumAttempts = options.maximumAttempts ?? 5;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const confidenceThreshold = options.confidenceThreshold ?? 0.85;
  if (!Number.isFinite(minimumIntervalMs) || minimumIntervalMs < 0) throw new Error("Robotoff ingredient request interval must be non-negative.");
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 8) {
    throw new Error("Robotoff ingredient attempts must be between one and eight.");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 300_000) {
    throw new Error("Robotoff ingredient request timeout must be between 1 and 300000 milliseconds.");
  }
  if (!Number.isFinite(confidenceThreshold) || confidenceThreshold < 0 || confidenceThreshold > 1) {
    throw new Error("Robotoff ingredient confidence threshold must be between zero and one.");
  }
  if (options.mode === "production" && options.limit !== null) {
    throw new Error("Production Robotoff ingredient extraction cannot use a barcode limit.");
  }
  const budget = new RunBudget(options.budget);

  const sourceManifest = JSON.parse(await readFile(options.inputManifest, "utf8")) as SourceManifest;
  if (sourceManifest.source !== "open_food_facts" || !sourceManifest.sourceComplete || sourceManifest.terminalEvidence !== "end_of_file") {
    throw new Error("Robotoff ingredient extraction requires a source-complete Open Food Facts snapshot manifest.");
  }
  const inputStats = await stat(options.input);
  const inputHash = await hashFile(options.input);
  const contexts = await readContexts(options.input, options.limit);
  if (contexts.length === 0) throw new Error("Robotoff ingredient extraction found no valid barcodes with ingredient label images.");

  await mkdir(options.outputDirectory, { recursive: true });
  await unlink(join(options.outputDirectory, "decision-drift.json")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const responsesDirectory = join(options.outputDirectory, "responses");
  await mkdir(responsesDirectory, { recursive: true });
  const cohortPath = join(options.outputDirectory, "cohort.jsonl");
  const labelAssetsPath = join(options.outputDirectory, "label-assets.jsonl");
  const extractionAttemptsPath = join(options.outputDirectory, "extraction-attempts.jsonl");
  const extractionAttemptLabelsPath = join(options.outputDirectory, "extraction-attempt-labels.jsonl");
  const candidatesPath = join(options.outputDirectory, "candidates.jsonl");
  const outcomesPath = join(options.outputDirectory, "outcomes.jsonl");
  const exclusionsPath = join(options.outputDirectory, "exclusions.jsonl");
  const manifestPath = join(options.outputDirectory, "manifest.json");
  const reportPath = join(options.outputDirectory, "report.json");
  const checksumsPath = join(options.outputDirectory, "checksums.sha256");
  const completedResponseCodes = await readCompletedResponseCodes(outcomesPath);
  const priorLabelAssets = await readReusableLabelAssets([
    join(options.outputDirectory, "prior-label-assets.jsonl"),
    labelAssetsPath,
  ]);
  await writeFile(cohortPath, `${contexts.map((context) => JSON.stringify(ingredientCohortRow(context))).join("\n")}\n`, "utf8");
  const cohortHash = await hashFile(cohortPath);
  const stagedPath = join(options.outputDirectory, "staged-products.jsonl");
  const indexPath = join(options.outputDirectory, "source-index.jsonl");
  const candidateOutput = createWriteStream(candidatesPath, { encoding: "utf8" });
  const labelAssetOutput = createWriteStream(labelAssetsPath, { encoding: "utf8" });
  const extractionAttemptOutput = createWriteStream(extractionAttemptsPath, { encoding: "utf8" });
  const extractionAttemptLabelOutput = createWriteStream(extractionAttemptLabelsPath, { encoding: "utf8" });
  const stagedOutput = createWriteStream(stagedPath, { encoding: "utf8" });
  const indexOutput = createWriteStream(indexPath, { encoding: "utf8" });
  const outcomeOutput = createWriteStream(outcomesPath, { encoding: "utf8" });
  const exclusionOutput = createWriteStream(exclusionsPath, { encoding: "utf8" });
  const outcomes: Record<IngredientExtractionOutcomeStatus, number> = {
    candidate: 0,
    no_prediction: 0,
    rejected: 0,
    failed: 0,
  };
  const issueCounts: Record<string, number> = {};
  const modelVersions: Record<string, number> = {};
  const languages: Record<string, number> = {};
  const taxonomyRecognition = { belowSixtyPercent: 0, atLeastSixtyPercent: 0 };
  const seenCandidateHashes = new Set<string>();
  const startedAt = new Date().toISOString();
  const extractionRunId = stableExtractionId(
    "xrun",
    `ingredients:${sourceManifest.inputHash ?? inputHash}:${startedAt}:${ROBOTOFF_INGREDIENT_API_ADAPTER_VERSION}:${ROBOTOFF_INGREDIENT_REQUEST_SCHEMA}`,
  );
  const parentSourceRunId = stableExtractionId(
    "run",
    `${sourceManifest.source}:${sourceManifest.startedAt}:${sourceManifest.inputHash ?? sourceManifest.input}`,
  );
  let candidateRecords = 0;
  let duplicateCandidates = 0;
  let fetchedBarcodes = 0;
  let resumedBarcodes = 0;
  let requests = 0;
  let fetchedLabelAssets = 0;
  let reusedLabelAssets = 0;
  let lastFetchStartedAt: number | null = null;
  const fetcher = options.fetcher ?? fetch;
  const labelFetcher = options.labelFetcher ?? fetch;
  const userAgent = options.userAgent
    ?? "protein-index/0.1 (+https://github.com/sarthakagrawal927/protein-index; ingredient-label-evidence)";
  const progress = options.progress ? startExtractionProgress({
    label: ROBOTOFF_INGREDIENT_API_ADAPTER_VERSION,
    totalBarcodes: contexts.length,
    intervalMs: options.progressIntervalMs,
    write: options.progress,
    snapshot: () => ({
      processedBarcodes: Object.values(outcomes).reduce((sum, count) => sum + count, 0),
      fetchedBarcodes,
      resumedBarcodes,
      fetchedLabelAssets,
      reusedLabelAssets,
      outcomes,
    }),
  }) : null;

  const fetchPage = async (code: string, page: number): Promise<RawRecord[]> => {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let response: Response | null = null;
      try {
        if (lastFetchStartedAt !== null) {
          await sleep(Math.max(0, minimumIntervalMs - (Date.now() - lastFetchStartedAt)));
        }
        lastFetchStartedAt = Date.now();
        requests += 1;
        budget.recordApiCall();
        response = await fetcher(requestUrl(code, page), {
          headers: { Accept: "application/json", "User-Agent": userAgent },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
          if (!retryable) throw new Error(`Robotoff returned HTTP ${response.status}`);
          lastError = new Error(`Robotoff returned retryable HTTP ${response.status}`);
        } else {
          const body: unknown = await response.json();
          if (!isRecord(body) || !Array.isArray(body.image_predictions) || !body.image_predictions.every(isRecord)) {
            throw new Error("Robotoff returned an invalid ingredient image-predictions response");
          }
          return body.image_predictions;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (response && response.status < 500 && response.status !== 429) throw lastError;
      }
      if (attempt < maximumAttempts) await sleep(retryDelay(response, attempt, retryBaseMs));
    }
    throw lastError ?? new Error("Robotoff ingredient request failed without a response");
  };

  const fetchAll = async (code: string): Promise<StoredIngredientResponse["response"]> => {
    const imagePredictions: RawRecord[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const predictions = await fetchPage(code, page);
      imagePredictions.push(...predictions);
      if (predictions.length < PAGE_SIZE) return { image_predictions: imagePredictions };
    }
    throw new Error(`Robotoff ingredient pagination exceeded twenty pages for barcode ${code}`);
  };

  try {
    for (const context of contexts) {
      const responsePath = join(responsesDirectory, `${context.code}.json`);
      const errorPath = `${responsePath}.error.json`;
      let stored: StoredIngredientResponse;
      try {
        if (!completedResponseCodes.has(context.code)) {
          throw new Error("Response belongs to an incomplete prior extraction outcome.");
        }
        const existing = JSON.parse(await readFile(responsePath, "utf8")) as StoredIngredientResponse;
        if (existing.requestedCode !== context.code
          || existing.requestSchema !== ROBOTOFF_INGREDIENT_REQUEST_SCHEMA
          || !isRecord(existing.response)
          || !Array.isArray(existing.response.image_predictions)
          || !existing.response.image_predictions.every(isRecord)) {
          throw new Error(`Resume artifact ${basename(responsePath)} does not match the requested ingredient barcode.`);
        }
        stored = existing;
        resumedBarcodes += 1;
      } catch (error) {
        const incompletePrior = error instanceof Error
          && error.message === "Response belongs to an incomplete prior extraction outcome.";
        if (!incompletePrior && (error instanceof SyntaxError || (error instanceof Error && !error.message.includes("ENOENT")))) throw error;
        try {
          stored = {
            requestedCode: context.code,
            requestSchema: ROBOTOFF_INGREDIENT_REQUEST_SCHEMA,
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
          const outcome: IngredientExtractionOutcome = {
            requestedCode: context.code,
            status: "failed",
            predictions: 0,
            entities: 0,
            candidates: 0,
            reasons: [reason],
          };
          outcomes.failed += 1;
          await writeLine(outcomeOutput, outcome);
          await writeLine(exclusionOutput, outcome);
          continue;
        }
      }

      const responseEvidenceHash = jsonHash(stored);
      const requestedReference = labelReferenceFromUrl(context.ingredientImageUrl);
      const predictionRecords = stored.response.image_predictions.filter((prediction) => (
        prediction.type === "ner" && prediction.model_name === "ingredient_detection"
      ));
      const predictionReferences = predictionRecords.map((prediction) => ({ prediction, reference: predictionLabelReference(prediction) }));
      const missingReference = predictionReferences.some(({ reference }) => reference === null);
      const references = new Map<string, LabelImageReference>();
      references.set(requestedReference.url, requestedReference);
      for (const item of predictionReferences) if (item.reference) references.set(item.reference.url, item.reference);
      const assetsByUrl = new Map<string, LabelEvidenceAsset>();
      let labelFailure = missingReference ? "prediction_label_reference_missing" : null;
      if (!labelFailure) {
        for (const reference of references.values()) {
          try {
            const reusable = priorLabelAssets.get(labelAssetReuseKey({
              subjectSourceRecordId: stagedSourceRecordId(context.product),
              subjectSourceContentHash: context.product.contentHash,
              fieldFamily: "ingredients",
              requestedUrl: reference.url,
            }));
            if (reusable && reusable.productId === stagedProductId(context.product)) {
              assetsByUrl.set(reference.url, reusable);
              await writeLine(labelAssetOutput, reusable);
              reusedLabelAssets += 1;
              continue;
            }
            const hashed = await hashHttpsLabelImage({
              url: reference.url,
              fetcher: labelFetcher,
              maximumBytes: options.maximumLabelBytes,
              maximumChunks: options.maximumLabelChunks,
              userAgent,
            });
            const asset = createLabelEvidenceAsset({ product: context.product, fieldFamily: "ingredients", reference, hash: hashed });
            assetsByUrl.set(reference.url, asset);
            await writeLine(labelAssetOutput, asset);
            fetchedLabelAssets += 1;
            budget.recordImage();
            budget.recordBytes(hashed.byteLength);
          } catch (error) {
            labelFailure = error instanceof LabelImageHashError
              ? `label_${error.code}`
              : "label_internal_error";
            break;
          }
        }
      }
      if (labelFailure) {
        const failed = createExtractionAttempt({
          extractionRunId,
          subjectSourceRecordId: stagedSourceRecordId(context.product),
          subjectSourceRecordKey: context.product.sourceRecordId,
          subjectSourceContentHash: context.product.contentHash,
          productId: stagedProductId(context.product),
          fieldFamily: "ingredients",
          responseEvidenceHash,
          status: "failed",
          predictionCount: predictionRecords.length,
          candidateCount: 0,
          rejectionCount: 0,
          failureCount: 1,
          conflictCount: 0,
          reasons: [labelFailure],
          attemptedAt: startedAt,
          isCurrent: true,
        });
        await writeLine(extractionAttemptOutput, failed);
        const outcome: IngredientExtractionOutcome = {
          requestedCode: context.code,
          status: "failed",
          predictions: predictionRecords.length,
          entities: 0,
          candidates: 0,
          reasons: [labelFailure],
        };
        outcomes.failed += 1;
        await writeLine(outcomeOutput, outcome);
        await writeLine(exclusionOutput, outcome);
        continue;
      }

      const parsed = parseRobotoffIngredientEvidence(stored.response, context, confidenceThreshold);
      for (const issue of parsed.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
      const pendingCandidates: Array<{ item: (typeof parsed.evidence)[number]; candidateHash: string; asset: LabelEvidenceAsset }> = [];
      for (const item of parsed.evidence) {
        if (!item.candidate) continue;
        const candidateHash = await ingredientCandidateHash(item.candidate);
        if (seenCandidateHashes.has(candidateHash)) {
          duplicateCandidates += 1;
          continue;
        }
        const asset = assetsByUrl.get(item.candidate.imageUrl);
        if (!asset) throw new Error(`Ingredient candidate ${candidateHash} has no exact label asset`);
        seenCandidateHashes.add(candidateHash);
        pendingCandidates.push({ item, candidateHash, asset });
      }
      const acceptedCandidates = pendingCandidates.length;
      const status: IngredientExtractionOutcomeStatus = acceptedCandidates > 0
        ? "candidate"
        : parsed.predictionCount > 0
          ? "rejected"
          : "no_prediction";
      const acceptedPredictionIds = new Set(pendingCandidates.map(({ item }) => String(item.prediction.id ?? "")));
      const rejectedPredictionCount = parsed.predictionCount - acceptedPredictionIds.size;
      const reasons = status === "candidate"
        ? rejectedPredictionCount > 0 ? ["partial_prediction_rejection"] : []
        : status === "no_prediction"
          ? ["no_ingredient_detection_entity"]
          : parsed.issues.length > 0
            ? [...new Set(parsed.issues.map(({ code }) => code))]
            : ["no_ingredient_detection_entity"];
      const attempt = createExtractionAttempt({
        extractionRunId,
        subjectSourceRecordId: stagedSourceRecordId(context.product),
        subjectSourceRecordKey: context.product.sourceRecordId,
        subjectSourceContentHash: context.product.contentHash,
        productId: stagedProductId(context.product),
        fieldFamily: "ingredients",
        responseEvidenceHash,
        status,
        predictionCount: parsed.predictionCount,
        candidateCount: acceptedCandidates,
        rejectionCount: rejectedPredictionCount,
        failureCount: 0,
        conflictCount: parsed.hasConflict ? acceptedCandidates : 0,
        reasons,
        attemptedAt: startedAt,
        isCurrent: true,
      });
      await writeLine(extractionAttemptOutput, attempt);
      for (const { item, candidateHash, asset } of pendingCandidates) {
        const storedCandidate: StoredIngredientCandidate = {
          requestedCode: context.code,
          ingredientImageUrl: context.ingredientImageUrl,
          candidateHash,
          candidate: item.candidate!,
          issues: item.issues,
          hasConflict: parsed.hasConflict,
          prediction: item.prediction,
          extractionAttemptId: attempt.id,
          labelAssetId: asset.id,
          labelContentSha256: asset.contentSha256,
        };
        await writeLine(candidateOutput, storedCandidate);
        const staged = stageIngredientCandidate(context, storedCandidate);
        await writeLine(stagedOutput, staged);
        await writeLine(indexOutput, { sourceRecordId: staged.sourceRecordId, contentHash: staged.contentHash });
        candidateRecords += 1;
        modelVersions[item.candidate!.modelVersion] = (modelVersions[item.candidate!.modelVersion] ?? 0) + 1;
        languages[item.candidate!.language.code] = (languages[item.candidate!.language.code] ?? 0) + 1;
        if (item.candidate!.ingredientCount > 0
          && item.candidate!.knownIngredientCount / item.candidate!.ingredientCount >= 0.6) {
          taxonomyRecognition.atLeastSixtyPercent += 1;
        } else {
          taxonomyRecognition.belowSixtyPercent += 1;
        }
      }
      const predictionGroups = new Map<string, Array<{ prediction: RawRecord; reference: LabelImageReference }>>();
      for (const item of predictionReferences) {
        const current = predictionGroups.get(item.reference!.url) ?? [];
        current.push({ prediction: item.prediction, reference: item.reference! });
        predictionGroups.set(item.reference!.url, current);
      }
      const accountedUrls = new Set<string>();
      for (const [url, group] of predictionGroups) {
        const asset = assetsByUrl.get(url)!;
        const predictionIds = new Set(group.map(({ prediction }) => String(prediction.id ?? "")));
        const groupCandidates = pendingCandidates.filter(({ item }) => predictionIds.has(String(item.prediction.id ?? "")));
        const rejectedPredictions = group.filter(({ prediction }) => !acceptedPredictionIds.has(String(prediction.id ?? ""))).length;
        const labelOutcome: IngredientExtractionOutcomeStatus = groupCandidates.length > 0 ? "candidate" : "rejected";
        await writeLine(extractionAttemptLabelOutput, createExtractionAttemptLabel({
          attemptId: attempt.id,
          labelAssetId: asset.id,
          role: url === requestedReference.url ? "requested" : "prediction",
          outcome: labelOutcome,
          predictionCount: group.length,
          candidateCount: groupCandidates.length,
          rejectionCount: rejectedPredictions,
          failureCount: 0,
          conflictCount: parsed.hasConflict ? groupCandidates.length : 0,
          candidateHashes: groupCandidates.map(({ candidateHash }) => candidateHash),
          reasons: labelOutcome === "candidate"
            ? rejectedPredictions > 0 ? ["partial_prediction_rejection"] : []
            : ["ingredient_prediction_rejected"],
        }));
        accountedUrls.add(url);
      }
      if (!accountedUrls.has(requestedReference.url)) {
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
      const outcome: IngredientExtractionOutcome = {
        requestedCode: context.code,
        status,
        predictions: parsed.predictionCount,
        entities: parsed.entityCount,
        candidates: acceptedCandidates,
        reasons,
      };
      outcomes[status] += 1;
      await writeLine(outcomeOutput, outcome);
      if (status !== "candidate") await writeLine(exclusionOutput, outcome);
    }
  } finally {
    progress?.stop();
    await Promise.all([
      closeStream(candidateOutput),
      closeStream(labelAssetOutput),
      closeStream(extractionAttemptOutput),
      closeStream(extractionAttemptLabelOutput),
      closeStream(stagedOutput),
      closeStream(indexOutput),
      closeStream(outcomeOutput),
      closeStream(exclusionOutput),
    ]);
  }

  const accountedBarcodes = Object.values(outcomes).reduce((sum, count) => sum + count, 0);
  if (accountedBarcodes !== contexts.length) {
    throw new Error(`Robotoff ingredient accounting mismatch: ${accountedBarcodes} outcomes for ${contexts.length} requested barcodes.`);
  }
  const completedAt = new Date().toISOString();
  const [labelAssets, extractionAttempts, extractionAttemptLabels] = await Promise.all([
    readFile(labelAssetsPath, "utf8").then((value) => parseJsonLines<LabelEvidenceAsset>(value, "label-assets.jsonl")),
    readFile(extractionAttemptsPath, "utf8").then((value) => parseJsonLines<ExtractionAttempt>(value, "extraction-attempts.jsonl")),
    readFile(extractionAttemptLabelsPath, "utf8").then((value) => parseJsonLines<ExtractionAttemptLabel>(value, "extraction-attempt-labels.jsonl")),
  ]);
  const accounting = extractionAccountingSummary(contexts.length, accountedBarcodes, outcomes.failed);
  const residualFailuresAreEligible = extractionAttempts.filter(({ status }) => status === "failed").length === outcomes.failed
    && extractionAttempts.filter(({ status }) => status === "failed").every(({ reasons }) => (
      reasons.length === 1 && isResidualExceptionReason(reasons[0]!)
    ));
  const sourceComplete = residualExceptionBoundsSatisfied(accounting) && residualFailuresAreEligible;
  // Degraded when any barcode failed after retry, or when the residual-exception
  // rate is approaching its bound (within 50% of the maximum allowed rate).
  const residualExceptionApproaching = accounting.residualExceptionRate > 0
    && accounting.residualExceptionRate >= EXTRACTION_RESIDUAL_EXCEPTION_MAX_RATE / 2;
  const degraded = outcomes.failed > 0 || residualExceptionApproaching;
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source: "open_food_facts_robotoff_ingredients",
    sourceKind: "open_data",
    sourceAuthority: { identity: 0, nutrition: 0, ingredients: 20 },
    sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    sourceRetentionNotes: "Robotoff ingredient model output is retained as review evidence and never auto-verified.",
    adapterVersion: ROBOTOFF_INGREDIENT_API_ADAPTER_VERSION,
    input: basename(options.input),
    inputHash,
    inputBytes: inputStats.size,
    sourceUpdatedAt: null,
    startedAt,
    completedAt,
    mode: options.mode,
    terminalEvidence: sourceComplete ? "end_of_file" : "error",
    sourceComplete,
    ...accounting,
    marketComplete: false,
    advertisedTotal: contexts.length,
    recordsRead: contexts.length,
    indiaRecords: contexts.length,
    stagedRecords: candidateRecords,
    invalidRecords: outcomes.rejected,
    duplicateRecords: duplicateCandidates,
    newRecords: candidateRecords,
    changedRecords: 0,
    unchangedRecords: outcomes.no_prediction,
    missingSinceRecords: 0,
    knownExclusions: ["No ingredient-detection entity", "Prediction failed ingredient evidence validation"],
    disconnectedSources: ["gs1_india_datakart", "brand_owner_feeds"],
  };
  const report: RobotoffIngredientReport = {
    generatedAt: completedAt,
    sourceComplete,
    degraded,
    marketComplete: false,
    requestedBarcodes: contexts.length,
    accountedBarcodes,
    eligibleIngredientImages: contexts.length,
    candidateRecords,
    duplicateCandidates,
    outcomes,
    issueCounts,
    modelVersions,
    languages,
    taxonomyRecognition,
    fetchedBarcodes,
    resumedBarcodes,
    requests,
    minimumIntervalMs,
    requestTimeoutMs,
    confidenceThreshold,
    requestSchema: ROBOTOFF_INGREDIENT_REQUEST_SCHEMA,
    cohortHash,
    inputManifestHash: sourceManifest.inputHash,
    extractionRunId,
    parentSourceRunId,
    labelAssets: labelAssets.length,
    extractionAttempts: extractionAttempts.length,
    extractionAttemptLabels: extractionAttemptLabels.length,
    ...accounting,
    budget: budget.snapshot(),
    exclusions: {
      records: outcomes.no_prediction + outcomes.rejected + outcomes.failed,
      path: basename(exclusionsPath),
      reconcilesIndiaSlice: accountedBarcodes === contexts.length,
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
    basename(candidatesPath),
    basename(stagedPath),
    basename(indexPath),
    basename(outcomesPath),
    basename(exclusionsPath),
    basename(manifestPath),
    basename(reportPath),
    ...responseFiles,
  ], checksumsPath);
  const result: RobotoffIngredientApiResult = {
    stagedPath,
    indexPath,
    candidatesPath,
    outcomesPath,
    exclusionsPath,
    cohortPath,
    manifestPath,
    reportPath,
    checksumsPath,
    labelAssetsPath,
    extractionAttemptsPath,
    extractionAttemptLabelsPath,
    contexts: contexts.length,
    inputHash,
    inputBytes: inputStats.size,
    sourceManifest,
    outcomes,
    fetchedBarcodes,
    resumedBarcodes,
    requests,
    issueCounts,
    startedAt,
    completedAt,
    manifest,
    report,
  };
  if (!sourceComplete) {
    throw new Error(`Robotoff ingredient extraction incomplete: ${outcomes.failed} barcodes failed after retry; artifacts were preserved.`);
  }
  return result;
}

export async function validateRobotoffIngredientArtifact(
  directory: string,
  options: { requireDecisionDrift?: boolean } = {},
): Promise<RobotoffIngredientArtifact> {
  const manifestPath = join(directory, "manifest.json");
  const reportPath = join(directory, "report.json");
  const cohortPath = join(directory, "cohort.jsonl");
  const outcomesPath = join(directory, "outcomes.jsonl");
  const candidatesPath = join(directory, "candidates.jsonl");
  const stagedPath = join(directory, "staged-products.jsonl");
  const indexPath = join(directory, "source-index.jsonl");
  const exclusionsPath = join(directory, "exclusions.jsonl");
  const labelAssetsPath = join(directory, "label-assets.jsonl");
  const extractionAttemptsPath = join(directory, "extraction-attempts.jsonl");
  const extractionAttemptLabelsPath = join(directory, "extraction-attempt-labels.jsonl");
  const checksumsPath = join(directory, "checksums.sha256");
  let labelAssetsText: string;
  try {
    labelAssetsText = await readFile(labelAssetsPath, "utf8");
  } catch {
    throw new Error("Ingredient artifact is legacy or incomplete: label-assets.jsonl is required");
  }
  const [manifestText, reportText, cohortText, outcomesText, candidatesText, stagedText, indexText, exclusionsText, extractionAttemptsText, extractionAttemptLabelsText, checksumsText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(cohortPath, "utf8"),
    readFile(outcomesPath, "utf8"),
    readFile(candidatesPath, "utf8"),
    readFile(stagedPath, "utf8"),
    readFile(indexPath, "utf8"),
    readFile(exclusionsPath, "utf8"),
    readFile(extractionAttemptsPath, "utf8"),
    readFile(extractionAttemptLabelsPath, "utf8"),
    readFile(checksumsPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as SourceManifest;
  const report = JSON.parse(reportText) as RobotoffIngredientReport;
  const cohort = parseJsonLines<IngredientCohortRow>(cohortText, "cohort.jsonl");
  const outcomes = parseJsonLines<IngredientExtractionOutcome>(outcomesText, "outcomes.jsonl");
  const candidates = parseJsonLines<StoredIngredientCandidate>(candidatesText, "candidates.jsonl");
  const staged = parseJsonLines<StagedProduct>(stagedText, "staged-products.jsonl");
  const sourceIndex = parseJsonLines<{ sourceRecordId: string; contentHash: string }>(indexText, "source-index.jsonl");
  const exclusions = parseJsonLines<IngredientExtractionOutcome>(exclusionsText, "exclusions.jsonl");
  const labelAssets = parseJsonLines<LabelEvidenceAsset>(labelAssetsText, "label-assets.jsonl");
  const extractionAttempts = parseJsonLines<ExtractionAttempt>(extractionAttemptsText, "extraction-attempts.jsonl");
  const extractionAttemptLabels = parseJsonLines<ExtractionAttemptLabel>(extractionAttemptLabelsText, "extraction-attempt-labels.jsonl");

  const expectedChecksums = new Map<string, string>();
  for (const line of checksumsText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) throw new Error(`Ingredient artifact checksum line is malformed: ${line}`);
    const file = match[2].replace(/^\.\//, "");
    if (isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => !part || part === "..")) {
      throw new Error(`Ingredient artifact checksum path is not a safe portable relative path: ${match[2]}`);
    }
    if (expectedChecksums.has(file)) throw new Error(`Ingredient artifact checksum repeats ${file}`);
    expectedChecksums.set(file, match[1]);
  }
  const requiredFiles = [
    "cohort.jsonl",
    "label-assets.jsonl",
    "extraction-attempts.jsonl",
    "extraction-attempt-labels.jsonl",
    "candidates.jsonl",
    "staged-products.jsonl",
    "source-index.jsonl",
    "outcomes.jsonl",
    "exclusions.jsonl",
    "manifest.json",
    "report.json",
  ];
  const decisionDriftFile = await stat(join(directory, "decision-drift.json")).then(() => "decision-drift.json").catch(() => null);
  if (options.requireDecisionDrift && !decisionDriftFile) throw new Error("Ingredient artifact is missing checksummed decision-drift evidence");
  for (const file of requiredFiles) {
    const expected = expectedChecksums.get(file);
    if (!expected) throw new Error(`Ingredient artifact checksum is missing ${file}`);
    if (await hashFile(join(directory, file)) !== expected) throw new Error(`Ingredient artifact checksum mismatch for ${file}`);
  }
  if (decisionDriftFile) {
    const expected = expectedChecksums.get(decisionDriftFile);
    if (!expected || await hashFile(join(directory, decisionDriftFile)) !== expected) {
      throw new Error("Ingredient artifact checksum mismatch for decision-drift.json");
    }
  }

  if (manifest.source !== "open_food_facts_robotoff_ingredients") throw new Error("Ingredient artifact has an unexpected source");
  if (manifest.adapterVersion !== ROBOTOFF_INGREDIENT_API_ADAPTER_VERSION) throw new Error("Ingredient artifact adapter version has drifted");
  if (manifest.sourceComplete !== true || manifest.terminalEvidence !== "end_of_file") {
    throw new Error("Ingredient artifact is not source complete");
  }
  if (report.sourceComplete !== true || report.marketComplete !== false) throw new Error("Ingredient artifact report is not complete");
  const manifestAccountingErrors = validateExtractionAccountingSummary(manifest, report.requestedBarcodes, report.accountedBarcodes, report.outcomes.failed);
  const reportAccountingErrors = validateExtractionAccountingSummary(report, report.requestedBarcodes, report.accountedBarcodes, report.outcomes.failed);
  if (manifestAccountingErrors.length > 0 || reportAccountingErrors.length > 0) {
    throw new Error(`Ingredient artifact extraction accounting is invalid: ${[...manifestAccountingErrors, ...reportAccountingErrors].join("; ")}`);
  }
  if (report.requestSchema !== ROBOTOFF_INGREDIENT_REQUEST_SCHEMA) throw new Error("Ingredient artifact request schema has drifted");
  if (!/^xrun_[a-f0-9]{24}$/.test(report.extractionRunId) || !/^run_[a-f0-9]{24}$/.test(report.parentSourceRunId)) {
    throw new Error("Ingredient artifact extraction lineage is incomplete");
  }
  if (decisionDriftFile) {
    const decisionDrift = JSON.parse(await readFile(join(directory, decisionDriftFile), "utf8")) as unknown;
    const decisionDriftErrors = validateDecisionDriftEvidence(decisionDrift, {
      fieldFamily: "ingredients",
      sourceId: manifest.source,
      adapterVersion: manifest.adapterVersion,
      inputHash: manifest.inputHash,
      extractionRunId: report.extractionRunId,
      parentSourceRunId: report.parentSourceRunId,
    });
    if (decisionDriftErrors.length > 0) throw new Error(`Ingredient decision-drift evidence is invalid: ${decisionDriftErrors.join("; ")}`);
  }
  if (report.cohortHash !== await hashFile(cohortPath)) throw new Error("Ingredient artifact cohort hash does not match its ledger");
  if (cohort.length === 0) throw new Error("Ingredient artifact cohort is empty");
  const cohortByCode = new Map<string, IngredientCohortRow>();
  let priorCode = "";
  for (const context of cohort) {
    const code = normalizeGtin(context.code);
    if (!code || code !== context.code || !validHttpsUrl(context.ingredientImageUrl)) {
      throw new Error("Ingredient artifact cohort contains an invalid GTIN or image URL");
    }
    if (priorCode && priorCode.localeCompare(code) >= 0) throw new Error("Ingredient artifact cohort is not uniquely sorted");
    priorCode = code;
    cohortByCode.set(code, context);
  }
  const responseDirectory = join(directory, "responses");
  const responseNames = (await readdir(responseDirectory)).sort();
  const expectedResponseNames = cohort.map(({ code }) => `${code}.json`).sort();
  if (JSON.stringify(responseNames) !== JSON.stringify(expectedResponseNames)) {
    throw new Error("Ingredient artifact response files do not exactly match the source cohort");
  }
  const expectedChecksumFiles = new Set([
    ...requiredFiles,
    ...(decisionDriftFile ? [decisionDriftFile] : []),
    ...expectedResponseNames.map((name) => `responses/${name}`),
  ]);
  if (expectedChecksums.size !== expectedChecksumFiles.size
    || [...expectedChecksums.keys()].some((file) => !expectedChecksumFiles.has(file))) {
    throw new Error("Ingredient artifact checksum entries do not exactly match the retained evidence files");
  }
  for (const name of expectedResponseNames) {
    const file = `responses/${name}`;
    if (await hashFile(join(directory, file)) !== expectedChecksums.get(file)) {
      throw new Error(`Ingredient artifact checksum mismatch for ${file}`);
    }
  }
  if (manifest.indiaRecords !== cohort.length
    || manifest.recordsRead !== cohort.length
    || manifest.advertisedTotal !== cohort.length
    || report.requestedBarcodes !== cohort.length
    || report.eligibleIngredientImages !== cohort.length) {
    throw new Error("Ingredient artifact cohort counts do not reconcile");
  }

  if (report.labelAssets !== labelAssets.length
    || report.extractionAttempts !== extractionAttempts.length
    || report.extractionAttemptLabels !== extractionAttemptLabels.length) {
    throw new Error("Ingredient artifact exact extraction ledger counts do not reconcile");
  }
  const assetById = new Map<string, LabelEvidenceAsset>();
  for (const asset of labelAssets) {
    const errors = validateLabelEvidenceAsset(asset);
    if (errors.length > 0) throw new Error(`Ingredient label asset is invalid: ${errors.join("; ")}`);
    if (asset.fieldFamily !== "ingredients" || assetById.has(asset.id)) throw new Error("Ingredient artifact has a duplicate or wrong-family label asset");
    assetById.set(asset.id, asset);
  }
  const attemptById = new Map<string, ExtractionAttempt>();
  const attemptBySourceKey = new Map<string, ExtractionAttempt>();
  const attemptBySubjectId = new Map<string, ExtractionAttempt>();
  const allowedReferencesByAttempt = new Map<string, Map<string, LabelImageReference>>();
  for (const attempt of extractionAttempts) {
    const errors = validateExtractionAttempt(attempt);
    if (errors.length > 0) throw new Error(`Ingredient extraction attempt is invalid: ${errors.join("; ")}`);
    if (attempt.extractionRunId !== report.extractionRunId || attempt.fieldFamily !== "ingredients" || attempt.isCurrent !== true) {
      throw new Error("Ingredient extraction attempt does not match its accepted run");
    }
    if (attemptById.has(attempt.id) || attemptBySourceKey.has(attempt.subjectSourceRecordKey)) {
      throw new Error("Ingredient extraction attempt is duplicated");
    }
    const subject = cohort.find(({ subjectSourceRecordKey }) => subjectSourceRecordKey === attempt.subjectSourceRecordKey);
    if (!subject || subject.subjectSourceRecordId !== attempt.subjectSourceRecordId
      || subject.subjectSourceContentHash !== attempt.subjectSourceContentHash || subject.productId !== attempt.productId) {
      throw new Error("Ingredient extraction attempt subject binding does not match its cohort");
    }
    const response = JSON.parse(await readFile(join(directory, "responses", `${subject.code}.json`), "utf8")) as StoredIngredientResponse;
    if (response.requestedCode !== subject.code || response.requestSchema !== ROBOTOFF_INGREDIENT_REQUEST_SCHEMA
      || !isRecord(response.response) || !Array.isArray(response.response.image_predictions)
      || !response.response.image_predictions.every(isRecord)) {
      throw new Error("Ingredient extraction response does not match its cohort subject or request schema");
    }
    if (jsonHash(response) !== attempt.responseEvidenceHash) throw new Error("Ingredient extraction response evidence hash does not match");
    const allowedReferences = new Map<string, LabelImageReference>();
    const requestedReference = labelReferenceFromUrl(subject.ingredientImageUrl);
    allowedReferences.set(requestedReference.url, requestedReference);
    for (const prediction of response.response.image_predictions.filter((item) => item.type === "ner" && item.model_name === "ingredient_detection")) {
      const reference = predictionLabelReference(prediction);
      if (reference) allowedReferences.set(reference.url, reference);
    }
    attemptById.set(attempt.id, attempt);
    attemptBySourceKey.set(attempt.subjectSourceRecordKey, attempt);
    attemptBySubjectId.set(attempt.subjectSourceRecordId, attempt);
    allowedReferencesByAttempt.set(attempt.id, allowedReferences);
  }
  if (attemptBySourceKey.size !== cohort.length) throw new Error("Ingredient exact attempt accounting is incomplete");
  const labelsByAttempt = new Map<string, ExtractionAttemptLabel[]>();
  const labelIds = new Set<string>();
  const usedAssetIds = new Set<string>();
  for (const label of extractionAttemptLabels) {
    const errors = validateExtractionAttemptLabel(label);
    if (errors.length > 0) throw new Error(`Ingredient per-label outcome is invalid: ${errors.join("; ")}`);
    if (!attemptById.has(label.attemptId) || !assetById.has(label.labelAssetId) || labelIds.has(label.id)) {
      throw new Error("Ingredient per-label outcome has a missing or duplicate reference");
    }
    const attempt = attemptById.get(label.attemptId)!;
    const asset = assetById.get(label.labelAssetId)!;
    if (asset.subjectSourceRecordId !== attempt.subjectSourceRecordId
      || asset.subjectSourceContentHash !== attempt.subjectSourceContentHash
      || asset.productId !== attempt.productId || asset.fieldFamily !== attempt.fieldFamily) {
      throw new Error("Ingredient label asset does not match its attempt subject binding");
    }
    labelIds.add(label.id);
    usedAssetIds.add(label.labelAssetId);
    const rows = labelsByAttempt.get(label.attemptId) ?? [];
    rows.push(label);
    labelsByAttempt.set(label.attemptId, rows);
  }
  for (const asset of labelAssets) {
    const attempt = attemptBySubjectId.get(asset.subjectSourceRecordId);
    const reference = attempt ? allowedReferencesByAttempt.get(attempt.id)?.get(asset.requestedUrl) : null;
    if (!attempt || !reference || reference.sourceImageId !== asset.sourceImageId
      || reference.sourceImageRevision !== asset.sourceImageRevision
      || attempt.subjectSourceContentHash !== asset.subjectSourceContentHash
      || attempt.productId !== asset.productId || attempt.fieldFamily !== asset.fieldFamily) {
      throw new Error("Ingredient label asset is not an exact requested or prediction URL for its attempt subject");
    }
    if (!usedAssetIds.has(asset.id) && attempt.status !== "failed") {
      throw new Error("Ingredient artifact contains an unlinked label asset outside a residual exception");
    }
  }
  for (const attempt of extractionAttempts) {
    const labels = labelsByAttempt.get(attempt.id) ?? [];
    if (attempt.status === "failed") {
      if (labels.length > 0 || attempt.candidateCount !== 0 || attempt.failureCount !== 1
        || attempt.reasons.length !== 1 || !isResidualExceptionReason(attempt.reasons[0]!)) {
        throw new Error("Ingredient residual exception has malformed or non-allow-listed provenance");
      }
      continue;
    }
    if (!labels.some(({ role }) => role === "requested")) throw new Error("Ingredient attempt has no requested label outcome");
    for (const [field, labelField] of [["predictionCount", "predictionCount"], ["candidateCount", "candidateCount"], ["rejectionCount", "rejectionCount"], ["failureCount", "failureCount"], ["conflictCount", "conflictCount"]] as const) {
      const total = labels.reduce((sum, label) => sum + label[labelField], 0);
      if (attempt[field] !== total) throw new Error(`Ingredient attempt ${field} does not reconcile with per-label outcomes`);
    }
  }

  const countedOutcomes: Record<IngredientExtractionOutcomeStatus, number> = {
    candidate: 0,
    no_prediction: 0,
    rejected: 0,
    failed: 0,
  };
  const partitionErrors = validateExtractionOutcomePartition(cohort.map(({ code }) => code), outcomes.map(({ requestedCode }) => requestedCode));
  if (partitionErrors.length > 0) throw new Error(`Ingredient outcome partition is invalid: ${partitionErrors.join("; ")}`);
  const outcomeByCode = new Map<string, IngredientExtractionOutcome>();
  for (const outcome of outcomes) {
    if (!cohortByCode.has(outcome.requestedCode)) throw new Error(`Ingredient outcome is outside the cohort: ${outcome.requestedCode}`);
    if (outcomeByCode.has(outcome.requestedCode)) throw new Error(`Ingredient outcome is duplicated: ${outcome.requestedCode}`);
    if (!(outcome.status in countedOutcomes)) throw new Error(`Ingredient outcome status is unsupported: ${outcome.status}`);
    if (!Number.isSafeInteger(outcome.predictions) || outcome.predictions < 0
      || !Number.isSafeInteger(outcome.entities) || outcome.entities < 0
      || !Number.isSafeInteger(outcome.candidates) || outcome.candidates < 0) {
      throw new Error("Ingredient outcome has invalid counts");
    }
    countedOutcomes[outcome.status] += 1;
    outcomeByCode.set(outcome.requestedCode, outcome);
  }
  if (outcomes.length !== cohort.length || outcomeByCode.size !== cohort.length) throw new Error("Ingredient outcome accounting is incomplete");
  if (JSON.stringify(countedOutcomes) !== JSON.stringify(report.outcomes)) throw new Error("Ingredient outcome distribution does not match its report");
  if (report.accountedBarcodes !== cohort.length || report.exclusions.reconcilesIndiaSlice !== true) {
    throw new Error("Ingredient artifact terminal barcode accounting does not reconcile");
  }

  const candidateCountByCode = new Map<string, number>();
  const modelVersions: Record<string, number> = {};
  const languages: Record<string, number> = {};
  const taxonomyRecognition = { belowSixtyPercent: 0, atLeastSixtyPercent: 0 };
  const candidateHashes = new Set<string>();
  for (const stored of candidates) {
    const cohortContext = cohortByCode.get(stored.requestedCode);
    if (!cohortContext || stored.ingredientImageUrl !== cohortContext.ingredientImageUrl) {
      throw new Error("Ingredient candidate does not match its cohort context");
    }
    const attempt = stored.extractionAttemptId ? attemptById.get(stored.extractionAttemptId) : null;
    const asset = stored.labelAssetId ? assetById.get(stored.labelAssetId) : null;
    if (!attempt || !asset || stored.labelContentSha256 !== asset.contentSha256
      || attempt.subjectSourceRecordKey !== cohortContext.subjectSourceRecordKey) {
      throw new Error("Ingredient candidate is not bound to its exact extraction attempt and label bytes");
    }
    const errors = validateIngredientCandidate(stored.candidate, { expectedGtin: stored.requestedCode, confidenceThreshold: report.confidenceThreshold });
    if (errors.length > 0) throw new Error(`Ingredient candidate failed current validation: ${errors.join("; ")}`);
    if (await ingredientCandidateHash(stored.candidate) !== stored.candidateHash) throw new Error("Ingredient candidate hash does not match its payload");
    if (candidateHashes.has(stored.candidateHash)) throw new Error("Ingredient artifact contains a duplicate candidate hash");
    candidateHashes.add(stored.candidateHash);
    candidateCountByCode.set(stored.requestedCode, (candidateCountByCode.get(stored.requestedCode) ?? 0) + 1);
    modelVersions[stored.candidate.modelVersion] = (modelVersions[stored.candidate.modelVersion] ?? 0) + 1;
    languages[stored.candidate.language.code] = (languages[stored.candidate.language.code] ?? 0) + 1;
    if (stored.candidate.ingredientCount > 0
      && stored.candidate.knownIngredientCount / stored.candidate.ingredientCount >= 0.6) {
      taxonomyRecognition.atLeastSixtyPercent += 1;
    } else {
      taxonomyRecognition.belowSixtyPercent += 1;
    }
  }
  const labelCandidateHashes = extractionAttemptLabels.flatMap(({ candidateHashes }) => candidateHashes).sort();
  if (JSON.stringify([...candidateHashes].sort()) !== JSON.stringify(labelCandidateHashes)) {
    throw new Error("Ingredient candidate hashes do not reconcile with per-label outcomes");
  }
  for (const outcome of outcomes) {
    const actualCandidates = candidateCountByCode.get(outcome.requestedCode) ?? 0;
    if (outcome.candidates !== actualCandidates) throw new Error(`Ingredient candidate count does not reconcile for ${outcome.requestedCode}`);
    if ((outcome.status === "candidate") !== (actualCandidates > 0)) throw new Error(`Ingredient outcome status disagrees with candidates for ${outcome.requestedCode}`);
    const attempt = attemptBySourceKey.get(cohortByCode.get(outcome.requestedCode)!.subjectSourceRecordKey)!;
    if (outcome.status !== attempt.status) throw new Error(`Ingredient outcome status does not match exact attempt provenance for ${outcome.requestedCode}`);
    if (outcome.predictions !== attempt.predictionCount || outcome.candidates !== attempt.candidateCount
      || (outcome.status === "failed" && (outcome.entities !== 0
        || attempt.rejectionCount !== 0 || attempt.failureCount !== 1 || attempt.conflictCount !== 0))) {
      throw new Error(`Ingredient outcome counts do not match exact attempt provenance for ${outcome.requestedCode}`);
    }
    if (JSON.stringify(outcome.reasons) !== JSON.stringify(attempt.reasons)) throw new Error(`Ingredient outcome reasons do not match exact attempt provenance for ${outcome.requestedCode}`);
  }
  if (manifest.stagedRecords !== candidates.length || report.candidateRecords !== candidates.length) {
    throw new Error("Ingredient artifact candidate records do not reconcile");
  }
  if (staged.length !== candidates.length || sourceIndex.length !== staged.length) {
    throw new Error("Ingredient artifact staged records do not reconcile");
  }
  const indexByRecord = new Map(sourceIndex.map((row) => [row.sourceRecordId, row.contentHash]));
  if (indexByRecord.size !== sourceIndex.length) throw new Error("Ingredient source index contains duplicate rows");
  for (const product of staged) {
    const rawEvidence = isRecord(product.rawEvidence) ? product.rawEvidence : null;
    const rawCandidate = rawEvidence && isRecord(rawEvidence.candidate) ? rawEvidence.candidate : null;
    if (product.source !== "open_food_facts_robotoff_ingredients"
      || product.ingredients.status !== "missing"
      || product.ingredients.raw !== null
      || !rawCandidate
      || typeof rawEvidence?.candidateHash !== "string"
      || indexByRecord.get(product.sourceRecordId) !== product.contentHash) {
      throw new Error("Ingredient staged record is not review-only or does not match its source index");
    }
    const attemptId = rawEvidence.extractionAttemptId;
    const assetId = rawEvidence.labelAssetId;
    const asset = typeof assetId === "string" ? assetById.get(assetId) : null;
    if (typeof attemptId !== "string" || !attemptById.has(attemptId) || !asset
      || rawEvidence.labelContentSha256 !== asset.contentSha256) {
      throw new Error("Ingredient staged record is not bound to exact label bytes");
    }
  }
  if (manifest.duplicateRecords !== report.duplicateCandidates) throw new Error("Ingredient duplicate accounting does not reconcile");
  if (JSON.stringify(modelVersions) !== JSON.stringify(report.modelVersions)
    || JSON.stringify(languages) !== JSON.stringify(report.languages)
    || JSON.stringify(taxonomyRecognition) !== JSON.stringify(report.taxonomyRecognition)) {
    throw new Error("Ingredient artifact distributions do not reconcile");
  }
  const expectedExclusions = outcomes.filter(({ status }) => status !== "candidate");
  const canonicalExclusions = (rows: IngredientExtractionOutcome[]) => [...rows]
    .sort((left, right) => left.requestedCode.localeCompare(right.requestedCode))
    .map((row) => JSON.stringify(row));
  if (report.exclusions.records !== exclusions.length
    || JSON.stringify(canonicalExclusions(exclusions)) !== JSON.stringify(canonicalExclusions(expectedExclusions))) {
    throw new Error("Ingredient exclusion accounting does not reconcile");
  }
  return { manifest, report, outcomes, candidates, staged, labelAssets, extractionAttempts, extractionAttemptLabels };
}
