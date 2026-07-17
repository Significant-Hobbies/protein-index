import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import {
  ROBOTOFF_API_REQUEST_SCHEMA,
  validateRobotoffNutritionArtifact,
} from "./adapters/robotoff-api";
import {
  ROBOTOFF_INGREDIENT_REQUEST_SCHEMA,
  validateRobotoffIngredientArtifact,
} from "./adapters/robotoff-ingredients-api";
import type { ExtractionRun } from "../shared/extraction-outcomes";
import { validateExtractionAccountingSummary } from "../shared/extraction-outcomes";
import type { SourceManifest } from "../shared/types";
import { ingestionRunIdForManifest, type ExtractionImportInput } from "./reconcile";

interface PublicationReport {
  sourceComplete?: boolean;
  marketComplete?: boolean;
  requestedBarcodes?: number;
  accountedBarcodes?: number;
  outcomes?: {
    failed?: number;
  };
  outcomeAccountingComplete?: boolean;
  verificationComplete?: boolean;
  residualExceptionCount?: number;
  residualExceptionRate?: number;
  residualExceptionLimits?: { maxCount?: number; maxRate?: number };
  continuity?: {
    currentStagedRecords?: number;
    previousStagedRecords?: number;
    missingSinceRecords?: number;
    maximumDropRatio?: number;
  };
  exclusions?: {
    records?: number;
    reconcilesIndiaSlice?: boolean;
  };
}

const BARCODE_ACCOUNTED_SOURCES = new Set([
  "open_food_facts_api",
  "open_food_facts_robotoff",
  "open_food_facts_robotoff_ingredients",
]);

const MULTI_PREDICTION_SOURCES = new Set([
  "open_food_facts_robotoff",
  "open_food_facts_robotoff_ingredients",
]);

export const CURRENT_PUBLICATION_ADAPTER_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  open_food_facts: "off-bulk-v3",
  open_food_facts_api: "off-api-enrichment-v6",
  open_food_facts_robotoff: "robotoff-api-v8",
  open_food_facts_robotoff_ingredients: "robotoff-ingredients-api-v3",
});

export const AUTOMATIC_DISCOVERY_DROP_CEILING = 0.2;
export const AUTOMATIC_PUBLICATION_REPOSITORY = "Significant-Hobbies/protein-index";
export const DENIED_EXTRACTION_RUN_IDS = new Set([29551181430, 29552807113]);

export const AUTOMATIC_PUBLICATION_FAMILIES = {
  "Source sync": {
    source: "open_food_facts",
    artifactPrefix: "open-food-facts-snapshot",
    evidenceKind: "community" as const,
  },
  "Enrich Open Food Facts evidence": {
    source: "open_food_facts_api",
    artifactPrefix: "open-food-facts-enrichment",
    evidenceKind: "community" as const,
  },
  "Extract label evidence with Robotoff": {
    source: "open_food_facts_robotoff",
    artifactPrefix: "robotoff-label-candidates",
    evidenceKind: "review_only" as const,
  },
  "Extract ingredient label evidence": {
    source: "open_food_facts_robotoff_ingredients",
    artifactPrefix: "robotoff-ingredient-candidates",
    evidenceKind: "review_only" as const,
  },
} as const;

export type AutomaticWorkflowName = keyof typeof AUTOMATIC_PUBLICATION_FAMILIES;

export interface AutomaticPublicationInput {
  workflowName: string;
  runId: number;
  headSha: string;
  headBranch: string;
  repository: string;
  artifactName: string;
  artifactDigest: string;
  artifactBytes: number;
}

export interface AutomaticPublicationContract extends AutomaticPublicationInput {
  workflowName: AutomaticWorkflowName;
  expectedSource: string;
  evidenceKind: "community" | "review_only";
  discoveryDropCeiling: typeof AUTOMATIC_DISCOVERY_DROP_CEILING;
}

export function automaticPublicationContract(input: AutomaticPublicationInput): AutomaticPublicationContract {
  if (!Object.prototype.hasOwnProperty.call(AUTOMATIC_PUBLICATION_FAMILIES, input.workflowName)) {
    throw new Error(`Automatic publication rejected unsupported workflow: ${input.workflowName}`);
  }
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    throw new Error("Automatic publication requires a positive upstream run ID");
  }
  if (!/^[a-f0-9]{40}$/.test(input.headSha)) {
    throw new Error("Automatic publication requires the exact lowercase upstream head SHA");
  }
  if (input.headBranch !== "main") {
    throw new Error("Automatic publication accepts only default-branch runs");
  }
  if (input.repository !== AUTOMATIC_PUBLICATION_REPOSITORY) {
    throw new Error(`Automatic publication accepts only ${AUTOMATIC_PUBLICATION_REPOSITORY}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.artifactDigest)) {
    throw new Error("Automatic publication requires the immutable upstream artifact digest");
  }
  if (!Number.isSafeInteger(input.artifactBytes) || input.artifactBytes <= 0) {
    throw new Error("Automatic publication requires the positive upstream artifact size");
  }
  const workflowName = input.workflowName as AutomaticWorkflowName;
  const family = AUTOMATIC_PUBLICATION_FAMILIES[workflowName];
  if (family.evidenceKind === "review_only" && DENIED_EXTRACTION_RUN_IDS.has(input.runId)) {
    throw new Error("Automatic publication rejected an explicitly superseded extraction run");
  }
  const expectedArtifact = `${family.artifactPrefix}-${input.runId}`;
  if (input.artifactName !== expectedArtifact) {
    throw new Error(`Automatic publication expected artifact ${expectedArtifact}`);
  }
  return {
    ...input,
    workflowName,
    expectedSource: family.source,
    evidenceKind: family.evidenceKind,
    discoveryDropCeiling: AUTOMATIC_DISCOVERY_DROP_CEILING,
  };
}

export interface PublicationSnapshot {
  directory: string;
  manifestPath: string;
  reportPath: string;
  stagedPath: string;
  checksumsPath: string;
  manifest: SourceManifest;
  report: PublicationReport;
  exactExtraction: ExactExtractionSnapshot | null;
}

export interface AutomaticPublicationSnapshot extends PublicationSnapshot {
  contract: AutomaticPublicationContract;
  validatedStagedRecords: number;
  extractionImport: ExtractionImportInput | null;
}

export interface ExactExtractionSnapshot {
  fieldFamily: "nutrition" | "ingredients";
  extractionRunId: string;
  parentSourceRunId: string;
  parentSourceInputHash: string;
  requestSchemaHash: string;
  modelName: string;
  modelVersion: string;
  labelAssetsPath: string;
  extractionAttemptsPath: string;
  extractionAttemptLabelsPath: string;
  labelAssets: number;
  extractionAttempts: number;
  extractionAttemptLabels: number;
}

export function assertPublicationEvidence(manifest: SourceManifest, report: PublicationReport): void {
  const failures: string[] = [];
  const expectedAdapterVersion = CURRENT_PUBLICATION_ADAPTER_VERSIONS[manifest.source];
  if (expectedAdapterVersion && manifest.adapterVersion !== expectedAdapterVersion) {
    failures.push(`adapter version is not ${expectedAdapterVersion}`);
  }
  if (manifest.mode !== "production") failures.push("manifest mode is not production");
  if (manifest.sourceComplete !== true) failures.push("manifest is not source complete");
  if (manifest.terminalEvidence !== "end_of_file") failures.push("terminal evidence is not end_of_file");
  if (!Number.isInteger(manifest.stagedRecords) || manifest.stagedRecords <= 0) failures.push("staged record count is empty or invalid");
  if (!Number.isInteger(manifest.indiaRecords) || manifest.indiaRecords <= 0) failures.push("India record count is empty or invalid");
  if (report.sourceComplete !== true) failures.push("report is not source complete");
  if (report.marketComplete !== false) failures.push("report must not claim market completeness");
  if (report.exclusions?.reconcilesIndiaSlice !== true) failures.push("India source accounting does not reconcile");
  const excluded = report.exclusions?.records;
  if (!MULTI_PREDICTION_SOURCES.has(manifest.source)
    && (!Number.isInteger(excluded) || manifest.stagedRecords + (excluded ?? 0) !== manifest.indiaRecords)) {
    failures.push("staged plus excluded records do not equal the India slice");
  }
  if (report.continuity?.currentStagedRecords !== undefined && report.continuity.currentStagedRecords !== manifest.stagedRecords) {
    failures.push("continuity staged count differs from manifest");
  }
  if ((report.continuity?.missingSinceRecords ?? 0) > 0) {
    const previous = report.continuity?.previousStagedRecords ?? 0;
    const missing = report.continuity?.missingSinceRecords ?? 0;
    const maximumDropRatio = report.continuity?.maximumDropRatio ?? 0;
    if (previous > 0 && missing / previous > maximumDropRatio) failures.push("snapshot exceeds the permitted continuity drop");
  }
  if (BARCODE_ACCOUNTED_SOURCES.has(manifest.source)) {
    if (report.requestedBarcodes !== manifest.indiaRecords) failures.push("requested barcode count differs from the manifest");
    if (report.accountedBarcodes !== report.requestedBarcodes) failures.push("barcode accounting does not reconcile");
    if (MULTI_PREDICTION_SOURCES.has(manifest.source)) {
      const requested = report.requestedBarcodes ?? 0;
      const accounted = report.accountedBarcodes ?? 0;
      const failed = report.outcomes?.failed ?? -1;
      if (Number.isSafeInteger(requested) && requested > 0 && Number.isSafeInteger(accounted) && accounted >= 0
        && Number.isSafeInteger(failed) && failed >= 0) {
        failures.push(...validateExtractionAccountingSummary(manifest, requested, accounted, failed)
          .map((error) => `manifest ${error}`));
        failures.push(...validateExtractionAccountingSummary(report, requested, accounted, failed)
          .map((error) => `report ${error}`));
      } else {
        failures.push("extraction residual accounting is malformed");
      }
    } else if (report.outcomes?.failed !== 0) {
      failures.push("enrichment contains failed barcodes");
    }
  }
  if (failures.length > 0) throw new Error(`Publication snapshot rejected: ${failures.join("; ")}`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function reportString(report: Record<string, unknown>, field: string): string {
  const value = report[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Extraction report ${field} is missing`);
  return value;
}

function reportCount(report: Record<string, unknown>, field: string): number {
  const value = report[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Extraction report ${field} is invalid`);
  return value as number;
}

function modelVersionLedger(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "{}";
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([, count]) => !Number.isSafeInteger(count) || (count as number) < 0)) {
    throw new Error("Extraction report modelVersions is invalid");
  }
  return JSON.stringify(Object.fromEntries(entries));
}

async function validateExactExtractionSnapshot(
  directory: string,
  manifest: SourceManifest,
): Promise<ExactExtractionSnapshot | null> {
  if (manifest.source !== "open_food_facts_robotoff" && manifest.source !== "open_food_facts_robotoff_ingredients") return null;
  const artifact = manifest.source === "open_food_facts_robotoff"
    ? await validateRobotoffNutritionArtifact(directory, { requireDecisionDrift: true })
    : await validateRobotoffIngredientArtifact(directory, { requireDecisionDrift: true });
  const report = artifact.report as unknown as Record<string, unknown>;
  const nutrition = manifest.source === "open_food_facts_robotoff";
  const requestSchemaHash = reportString(report, "requestSchema");
  if (requestSchemaHash !== (nutrition ? ROBOTOFF_API_REQUEST_SCHEMA : ROBOTOFF_INGREDIENT_REQUEST_SCHEMA)) {
    throw new Error("Extraction report request schema differs from the current adapter");
  }
  return {
    fieldFamily: nutrition ? "nutrition" : "ingredients",
    extractionRunId: reportString(report, "extractionRunId"),
    parentSourceRunId: reportString(report, "parentSourceRunId"),
    parentSourceInputHash: reportString(report, "inputManifestHash"),
    requestSchemaHash,
    modelName: nutrition ? "nutrition_extractor" : "ingredient_detection",
    modelVersion: modelVersionLedger(report.modelVersions),
    labelAssetsPath: join(directory, "label-assets.jsonl"),
    extractionAttemptsPath: join(directory, "extraction-attempts.jsonl"),
    extractionAttemptLabelsPath: join(directory, "extraction-attempt-labels.jsonl"),
    labelAssets: reportCount(report, "labelAssets"),
    extractionAttempts: reportCount(report, "extractionAttempts"),
    extractionAttemptLabels: reportCount(report, "extractionAttemptLabels"),
  };
}

export async function validatePublicationSnapshot(directory: string): Promise<PublicationSnapshot> {
  const manifestPath = join(directory, "manifest.json");
  const reportPath = join(directory, "report.json");
  const stagedPath = join(directory, "staged-products.jsonl");
  const checksumsPath = join(directory, "checksums.sha256");
  const [manifestText, reportText, checksumText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(checksumsPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as SourceManifest;
  const report = JSON.parse(reportText) as PublicationReport;
  assertPublicationEvidence(manifest, report);

  const expectedFiles = new Map<string, string>();
  for (const line of checksumText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) throw new Error(`Publication checksum line is malformed: ${line}`);
    const file = match[2].replace(/^\.\//, "");
    if (isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`Publication checksum path is not a safe portable relative path: ${match[2]}`);
    }
    expectedFiles.set(file, match[1]);
  }
  const requiredFiles = ["manifest.json", "report.json", "source-index.jsonl", "exclusions.jsonl", "staged-products.jsonl"];
  if (BARCODE_ACCOUNTED_SOURCES.has(manifest.source)) requiredFiles.push("outcomes.jsonl");
  for (const required of requiredFiles) {
    if (!expectedFiles.has(required)) throw new Error(`Publication checksum is missing ${required}`);
  }
  for (const [file, expected] of expectedFiles) {
    const actual = await sha256(join(directory, file));
    if (actual !== expected) throw new Error(`Publication checksum mismatch for ${file}`);
  }
  const exactExtraction = await validateExactExtractionSnapshot(directory, manifest);
  return { directory, manifestPath, reportPath, stagedPath, checksumsPath, manifest, report, exactExtraction };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsDecisionPayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDecisionPayload);
  if (!recordValue(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    key.toLowerCase().includes("decision") || containsDecisionPayload(nested)
  ));
}

function assertAutomaticStagedProduct(product: Record<string, unknown>, contract: AutomaticPublicationContract, line: number): void {
  const reject = (reason: string): never => {
    throw new Error(`Automatic publication rejected staged record ${line}: ${reason}`);
  };
  const nutrition = recordValue(product.nutrition) ? product.nutrition : reject("nutrition payload is malformed");
  const ingredients = recordValue(product.ingredients) ? product.ingredients : reject("ingredient payload is malformed");
  const nutrients = Array.isArray(product.nutrients) ? product.nutrients : reject("nutrient payload is malformed");
  const offers = Array.isArray(product.offers) ? product.offers : reject("offer payload is malformed");
  const ratings = Array.isArray(product.ratings) ? product.ratings : reject("rating payload is malformed");
  const validationIssues = Array.isArray(product.validationIssues) ? product.validationIssues : reject("validation issue payload is malformed");
  if (product.source !== contract.expectedSource) reject("source does not match the pinned workflow family");
  if (nutrition.status === "verified" || nutrition.labelVerifiedAt !== null) {
    reject("verified nutrition is prohibited");
  }
  if (ingredients.status === "verified") reject("verified ingredients are prohibited");
  if (containsDecisionPayload(product)) reject("decision payloads are prohibited");
  if (offers.length > 0 || ratings.length > 0) reject("retailer evidence is outside the automatic source path");
  if (contract.evidenceKind === "review_only") {
    if (nutrition.status !== "missing" || ingredients.status !== "missing" || nutrients.length > 0) {
      reject("Robotoff artifacts must remain review-only");
    }
    if (validationIssues.length === 0 || !validationIssues.every(recordValue)) reject("review-only artifact has no validation evidence");
  }
}

function extractionImportForAutomaticSnapshot(
  snapshot: PublicationSnapshot,
  contract: AutomaticPublicationContract,
): ExtractionImportInput | null {
  const evidence = snapshot.exactExtraction;
  if (!evidence) return null;
  const completedAt = snapshot.manifest.completedAt;
  const run: ExtractionRun = {
    id: evidence.extractionRunId,
    ingestionRunId: ingestionRunIdForManifest(snapshot.manifest),
    fieldFamily: evidence.fieldFamily,
    requestSchemaHash: evidence.requestSchemaHash,
    artifactDigest: contract.artifactDigest.slice("sha256:".length),
    adapterVersion: snapshot.manifest.adapterVersion,
    modelName: evidence.modelName,
    modelVersion: evidence.modelVersion,
    parentSourceRunId: evidence.parentSourceRunId,
    parentSourceInputHash: evidence.parentSourceInputHash,
    repository: contract.repository,
    workflow: contract.workflowName,
    branch: contract.headBranch,
    headSha: contract.headSha,
    sourceComplete: true,
    status: "accepted",
    startedAt: snapshot.manifest.startedAt,
    completedAt,
    acceptedAt: completedAt,
    manifest: {
      source: snapshot.manifest.source,
      inputHash: snapshot.manifest.inputHash,
      outcomeAccountingComplete: snapshot.manifest.outcomeAccountingComplete,
      verificationComplete: snapshot.manifest.verificationComplete,
      residualExceptionCount: snapshot.manifest.residualExceptionCount,
      residualExceptionRate: snapshot.manifest.residualExceptionRate,
      residualExceptionLimits: snapshot.manifest.residualExceptionLimits,
      artifactName: contract.artifactName,
      artifactDigest: contract.artifactDigest,
      artifactBytes: contract.artifactBytes,
      upstreamRunId: contract.runId,
    },
  };
  return {
    run,
    labelAssetsPath: evidence.labelAssetsPath,
    extractionAttemptsPath: evidence.extractionAttemptsPath,
    extractionAttemptLabelsPath: evidence.extractionAttemptLabelsPath,
  };
}

export async function validateAutomaticPublicationSnapshot(
  directory: string,
  input: AutomaticPublicationInput,
): Promise<AutomaticPublicationSnapshot> {
  const contract = automaticPublicationContract(input);
  const snapshot = await validatePublicationSnapshot(directory);
  if (snapshot.manifest.source !== contract.expectedSource) {
    throw new Error(`Automatic publication source ${snapshot.manifest.source} does not match ${contract.expectedSource}`);
  }
  if (contract.expectedSource === "open_food_facts") {
    const continuity = snapshot.report.continuity;
    if ((continuity?.maximumDropRatio ?? 0) > contract.discoveryDropCeiling) {
      throw new Error("Automatic publication discovery-drop ceiling exceeds 20 percent");
    }
    const previous = continuity?.previousStagedRecords ?? 0;
    const missing = continuity?.missingSinceRecords ?? 0;
    if (previous > 0 && missing / previous > contract.discoveryDropCeiling) {
      throw new Error("Automatic publication snapshot exceeds the fixed 20 percent discovery-drop ceiling");
    }
  }

  let validatedStagedRecords = 0;
  const lines = createInterface({ input: createReadStream(snapshot.stagedPath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    validatedStagedRecords += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Automatic publication staged record ${validatedStagedRecords} is invalid JSON`);
    }
    if (!recordValue(parsed)) throw new Error(`Automatic publication staged record ${validatedStagedRecords} is not an object`);
    assertAutomaticStagedProduct(parsed, contract, validatedStagedRecords);
  }
  if (validatedStagedRecords !== snapshot.manifest.stagedRecords) {
    throw new Error("Automatic publication staged JSONL count differs from the manifest");
  }
  return {
    ...snapshot,
    contract,
    validatedStagedRecords,
    extractionImport: extractionImportForAutomaticSnapshot(snapshot, contract),
  };
}

export function assertNoPendingD1Migrations(output: string): void {
  const normalized = output.replace(/\x1b\[[0-9;]*m/g, "");
  if (/No migrations to apply!/i.test(normalized)) return;
  throw new Error("Automatic publication requires remote D1 to have no pending migrations");
}

export interface PublicationState {
  products: number;
  sourceRecords: number;
  openReviews: number;
  decisions: number;
  verifiedNutrition: number;
  verifiedIngredients: number;
  extractionRuns: number;
  labelAssets: number;
  extractionAttempts: number;
  currentExtractionAttempts: number;
  extractionAttemptLabels: number;
  exactRunId: string | null;
  exactRunStatus: string | null;
  exactRunInputHash: string | null;
  exactRunSourceComplete: number | null;
  exactRunStagedRecords: number | null;
  exactExtractionRunId: string | null;
  exactExtractionRunStatus: string | null;
  exactExtractionArtifactDigest: string | null;
  exactExtractionAttempts: number | null;
  exactExtractionAttemptLabels: number | null;
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function publicationStateQuery(manifest: SourceManifest, exactExtraction: ExactExtractionSnapshot | null = null): string {
  const runId = ingestionRunIdForManifest(manifest);
  const extractionId = exactExtraction ? sqlText(exactExtraction.extractionRunId) : "NULL";
  return `SELECT
    (SELECT COUNT(*) FROM products WHERE is_active = 1) AS products,
    (SELECT COUNT(*) FROM source_records) AS source_records,
    (SELECT COUNT(*) FROM review_items WHERE status = 'open') AS open_reviews,
    (SELECT COUNT(*) FROM evidence_decisions) AS decisions,
    (SELECT COUNT(*) FROM nutrition_facts WHERE status = 'verified') AS verified_nutrition,
    (SELECT COUNT(*) FROM ingredient_statements WHERE status = 'verified') AS verified_ingredients,
    (SELECT COUNT(*) FROM extraction_runs) AS extraction_runs,
    (SELECT COUNT(*) FROM label_evidence_assets) AS label_assets,
    (SELECT COUNT(*) FROM extraction_attempts) AS extraction_attempts,
    (SELECT COUNT(*) FROM extraction_attempts WHERE is_current = 1) AS current_extraction_attempts,
    (SELECT COUNT(*) FROM extraction_attempt_labels) AS extraction_attempt_labels,
    run.id AS exact_run_id,
    run.status AS exact_run_status,
    run.input_hash AS exact_run_input_hash,
    run.source_complete AS exact_run_source_complete,
    run.staged_records AS exact_run_staged_records,
    exact_extraction.id AS exact_extraction_run_id,
    exact_extraction.status AS exact_extraction_run_status,
    exact_extraction.artifact_digest AS exact_extraction_artifact_digest,
    (SELECT COUNT(*) FROM extraction_attempts WHERE extraction_run_id = exact_extraction.id) AS exact_extraction_attempts,
    (SELECT COUNT(*) FROM extraction_attempt_labels labels JOIN extraction_attempts attempts
      ON attempts.id = labels.attempt_id WHERE attempts.extraction_run_id = exact_extraction.id) AS exact_extraction_attempt_labels
  FROM (SELECT 1) singleton
  LEFT JOIN ingestion_runs run ON run.id = ${sqlText(runId)} AND run.source_id = ${sqlText(manifest.source)} AND run.input_hash = ${sqlText(manifest.inputHash ?? "")}
  LEFT JOIN extraction_runs exact_extraction ON exact_extraction.id = ${extractionId};`;
}

function nonnegativeInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Publication state ${field} is invalid`);
  return value as number;
}

function nullableString(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Publication state ${field} is invalid`);
  return value;
}

function nullableInteger(row: Record<string, unknown>, field: string): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Publication state ${field} is invalid`);
  return value as number;
}

export function parsePublicationState(input: string | unknown): PublicationState {
  const parsed: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!Array.isArray(parsed) || !recordValue(parsed[0]) || parsed[0].success !== true || !Array.isArray(parsed[0].results)) {
    throw new Error("Publication state query did not return a successful D1 result");
  }
  const row = parsed[0].results[0];
  if (!recordValue(row)) throw new Error("Publication state query returned no row");
  return {
    products: nonnegativeInteger(row, "products"),
    sourceRecords: nonnegativeInteger(row, "source_records"),
    openReviews: nonnegativeInteger(row, "open_reviews"),
    decisions: nonnegativeInteger(row, "decisions"),
    verifiedNutrition: nonnegativeInteger(row, "verified_nutrition"),
    verifiedIngredients: nonnegativeInteger(row, "verified_ingredients"),
    extractionRuns: nonnegativeInteger(row, "extraction_runs"),
    labelAssets: nonnegativeInteger(row, "label_assets"),
    extractionAttempts: nonnegativeInteger(row, "extraction_attempts"),
    currentExtractionAttempts: nonnegativeInteger(row, "current_extraction_attempts"),
    extractionAttemptLabels: nonnegativeInteger(row, "extraction_attempt_labels"),
    exactRunId: nullableString(row, "exact_run_id"),
    exactRunStatus: nullableString(row, "exact_run_status"),
    exactRunInputHash: nullableString(row, "exact_run_input_hash"),
    exactRunSourceComplete: nullableInteger(row, "exact_run_source_complete"),
    exactRunStagedRecords: nullableInteger(row, "exact_run_staged_records"),
    exactExtractionRunId: nullableString(row, "exact_extraction_run_id"),
    exactExtractionRunStatus: nullableString(row, "exact_extraction_run_status"),
    exactExtractionArtifactDigest: nullableString(row, "exact_extraction_artifact_digest"),
    exactExtractionAttempts: nullableInteger(row, "exact_extraction_attempts"),
    exactExtractionAttemptLabels: nullableInteger(row, "exact_extraction_attempt_labels"),
  };
}

export interface PublicationPostconditions {
  productDelta: number;
  sourceRecordDelta: number;
  openReviewDelta: number;
  verifiedNutritionDelta: number;
  verifiedIngredientDelta: number;
  extractionRunDelta: number;
  labelAssetDelta: number;
  extractionAttemptDelta: number;
  extractionAttemptLabelDelta: number;
}

export function assertAutomaticPublicationPostconditions(
  before: PublicationState,
  after: PublicationState,
  manifest: SourceManifest,
  exactExtraction: ExactExtractionSnapshot | null = null,
  contract: AutomaticPublicationContract | null = null,
): PublicationPostconditions {
  const failures: string[] = [];
  const expectedRunId = ingestionRunIdForManifest(manifest);
  if (after.products <= 0 || after.sourceRecords <= 0) failures.push("catalog or source ledger is empty");
  if (after.products < before.products) failures.push("active product count regressed");
  if (after.sourceRecords < before.sourceRecords) failures.push("source-record count regressed");
  if (after.decisions !== before.decisions) failures.push("automatic publication changed evidence decisions");
  if (after.verifiedNutrition > before.verifiedNutrition) failures.push("automatic publication increased verified nutrition");
  if (after.verifiedIngredients > before.verifiedIngredients) failures.push("automatic publication increased verified ingredients");
  if (after.extractionRuns < before.extractionRuns || after.labelAssets < before.labelAssets
    || after.extractionAttempts < before.extractionAttempts
    || after.extractionAttemptLabels < before.extractionAttemptLabels) {
    failures.push("exact extraction ledger counts regressed");
  }
  if (after.exactRunId !== expectedRunId || after.exactRunStatus !== "completed") failures.push("exact ingestion run is not completed");
  if (after.exactRunInputHash !== manifest.inputHash) failures.push("exact ingestion run input hash does not match");
  if (after.exactRunSourceComplete !== 1) failures.push("exact ingestion run is not source complete");
  if (after.exactRunStagedRecords !== manifest.stagedRecords) failures.push("exact ingestion run staged count does not match");
  if (exactExtraction) {
    if (after.exactExtractionRunId !== exactExtraction.extractionRunId || after.exactExtractionRunStatus !== "accepted") {
      failures.push("exact extraction run is not accepted");
    }
    if (after.exactExtractionAttempts !== exactExtraction.extractionAttempts
      || after.exactExtractionAttemptLabels !== exactExtraction.extractionAttemptLabels) {
      failures.push("exact extraction ledger counts do not match the artifact");
    }
    if (!contract || after.exactExtractionArtifactDigest !== contract.artifactDigest.slice("sha256:".length)) {
      failures.push("exact extraction artifact digest does not match");
    }
  }
  if (failures.length > 0) throw new Error(`Automatic publication postconditions failed: ${failures.join("; ")}`);
  return {
    productDelta: after.products - before.products,
    sourceRecordDelta: after.sourceRecords - before.sourceRecords,
    openReviewDelta: after.openReviews - before.openReviews,
    verifiedNutritionDelta: after.verifiedNutrition - before.verifiedNutrition,
    verifiedIngredientDelta: after.verifiedIngredients - before.verifiedIngredients,
    extractionRunDelta: after.extractionRuns - before.extractionRuns,
    labelAssetDelta: after.labelAssets - before.labelAssets,
    extractionAttemptDelta: after.extractionAttempts - before.extractionAttempts,
    extractionAttemptLabelDelta: after.extractionAttemptLabels - before.extractionAttemptLabels,
  };
}

export function assertIdempotentPublicationReplay(first: PublicationState, replay: PublicationState): void {
  const countFields = [
    "products", "sourceRecords", "openReviews", "decisions", "verifiedNutrition", "verifiedIngredients",
    "extractionRuns", "labelAssets", "extractionAttempts", "currentExtractionAttempts", "extractionAttemptLabels",
  ] as const;
  const changed = countFields.filter((field) => first[field] !== replay[field]);
  if (changed.length > 0) throw new Error(`Publication replay changed durable counts: ${changed.join(", ")}`);
  if (first.exactRunId !== replay.exactRunId || replay.exactRunStatus !== "completed" || first.exactRunInputHash !== replay.exactRunInputHash) {
    throw new Error("Publication replay changed the exact ingestion-run identity");
  }
  if (first.exactExtractionRunId !== replay.exactExtractionRunId
    || first.exactExtractionArtifactDigest !== replay.exactExtractionArtifactDigest
    || first.exactExtractionAttempts !== replay.exactExtractionAttempts
    || first.exactExtractionAttemptLabels !== replay.exactExtractionAttemptLabels) {
    throw new Error("Publication replay changed the exact extraction-run identity");
  }
}
