import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import {
  validateExtractionAttempt,
  validateExtractionAttemptLabel,
  validateExtractionRun,
  validateLabelEvidenceAsset,
  type ExtractionAttempt,
  type ExtractionAttemptLabel,
  type ExtractionRun,
  type LabelEvidenceAsset,
} from "../shared/extraction-outcomes";
import {
  nutritionCandidateFromEvidence,
  nutritionCandidateHash,
  nutritionCandidateNormalizedBasis,
  nutritionCandidateValues,
  type NutritionCandidate,
} from "../shared/evidence-decisions";
import { ingredientCandidateFromEvidence, ingredientCandidateHash, type IngredientCandidate } from "../shared/ingredient-evidence";
import { compositeIdentityKey, normalizeText } from "../shared/gtin";
import type { NormalizedIngredient, SourceManifest, StagedProduct } from "../shared/types";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function ingestionRunIdForManifest(manifest: Pick<SourceManifest, "source" | "startedAt" | "inputHash" | "input">): string {
  return stableId("run", `${manifest.source}:${manifest.startedAt}:${manifest.inputHash ?? manifest.input}`);
}

function sql(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot serialize non-finite SQL number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${value.replace(/'/g, "''")}'`;
}

function json(value: unknown): string {
  return sql(JSON.stringify(value) ?? "null");
}

const NUTRITION_PROJECTION_COLUMNS = [
  "calories",
  "protein_grams",
  "carbohydrate_grams",
  "sugar_grams",
  "fat_grams",
  "saturated_fat_grams",
  "fibre_grams",
  "sodium_mg",
] as const;

const REVIEWED_NUTRIENT_CODES = new Set([
  "calories", "proteinGrams", "carbohydrateGrams", "sugarGrams",
  "fatGrams", "saturatedFatGrams", "fibreGrams", "sodiumMg",
]);

export function nutritionProjectionCompletenessSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error("Nutrition SQL alias is invalid");
  return NUTRITION_PROJECTION_COLUMNS
    .map((column) => `CASE WHEN ${alias}.${column} IS NOT NULL THEN 1 ELSE 0 END`)
    .join(" + ");
}

async function write(stream: NodeJS.WritableStream, statement: string): Promise<void> {
  if (!stream.write(`${statement}\n`)) await once(stream, "drain");
}

function productIdFor(product: StagedProduct): string {
  const composite = compositeIdentityKey(product);
  const identity = product.gtin ? `gtin:${product.gtin}` : composite ? `composite:${composite}` : `source:${product.source}:${product.sourceRecordId}`;
  return stableId("prd", identity);
}

export function identityEvidenceHash(product: Pick<StagedProduct, "gtin" | "brand" | "name" | "flavour" | "netQuantityGrams">): string {
  const evidence = {
    gtin: product.gtin,
    brand: normalizeText(product.brand),
    name: normalizeText(product.name),
    flavour: normalizeText(product.flavour) || null,
    netQuantityGrams: product.netQuantityGrams,
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

interface PendingIdentityReview {
  reviewId: string;
  sourceRecordId: string;
  proposedProductId: string;
  source: string;
  sourceRecordKey: string;
  identityHash: string;
  brand: string;
  name: string;
  flavour: string | null;
  netQuantityGrams: number | null;
  createdAt: string;
}

interface NutritionDecisionCandidate {
  candidate: NutritionCandidate;
  candidateHash: string;
}

interface IngredientDecisionCandidate {
  candidate: IngredientCandidate;
  candidateHash: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface ExtractionImportInput {
  run: ExtractionRun;
  labelAssetsPath: string;
  extractionAttemptsPath: string;
  extractionAttemptLabelsPath: string;
}

async function validatedJsonLines<T>(
  path: string,
  name: string,
  validate: (value: unknown) => string[],
): Promise<T[]> {
  const values: T[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${name} line ${lineNumber} is invalid JSON`);
    }
    const errors = validate(value);
    if (errors.length > 0) throw new Error(`${name} line ${lineNumber} is invalid: ${errors.join("; ")}`);
    values.push(value as T);
  }
  return values;
}

async function emitExtractionImport(
  output: NodeJS.WritableStream,
  extraction: {
    run: ExtractionRun;
    labelAssets: LabelEvidenceAsset[];
    attempts: ExtractionAttempt[];
    attemptLabels: ExtractionAttemptLabel[];
  },
): Promise<void> {
  const run = extraction.run;
  await write(output, `INSERT OR IGNORE INTO extraction_runs (
    id, ingestion_run_id, field_family, request_schema_hash, artifact_digest, adapter_version,
    model_name, model_version, parent_source_run_id, parent_source_input_hash, repository,
    workflow, branch, head_sha, source_complete, status, started_at, completed_at, accepted_at,
    manifest_json
  ) VALUES (${sql(run.id)}, ${sql(run.ingestionRunId)}, ${sql(run.fieldFamily)},
    ${sql(run.requestSchemaHash)}, ${sql(run.artifactDigest)}, ${sql(run.adapterVersion)},
    ${sql(run.modelName)}, ${sql(run.modelVersion)}, ${sql(run.parentSourceRunId)},
    ${sql(run.parentSourceInputHash)}, ${sql(run.repository)}, ${sql(run.workflow)},
    ${sql(run.branch)}, ${sql(run.headSha)}, ${sql(run.sourceComplete)}, ${sql(run.status)},
    ${sql(run.startedAt)}, ${sql(run.completedAt)}, ${sql(run.acceptedAt)}, ${json(run.manifest)});`);
  for (const asset of extraction.labelAssets) {
    await write(output, `INSERT OR IGNORE INTO label_evidence_assets (
      id, subject_source_record_id, subject_source_content_hash, product_id, field_family,
      source_image_id, source_image_revision, requested_url, effective_url, content_sha256,
      byte_length, media_type, fetched_at
    ) VALUES (${sql(asset.id)}, ${sql(asset.subjectSourceRecordId)},
      ${sql(asset.subjectSourceContentHash)}, ${sql(asset.productId)}, ${sql(asset.fieldFamily)},
      ${sql(asset.sourceImageId)}, ${sql(asset.sourceImageRevision)}, ${sql(asset.requestedUrl)},
      ${sql(asset.effectiveUrl)}, ${sql(asset.contentSha256)}, ${asset.byteLength},
      ${sql(asset.mediaType)}, ${sql(asset.fetchedAt)});`);
  }
  for (const attempt of extraction.attempts) {
    await write(output, `INSERT OR IGNORE INTO extraction_attempts (
      id, extraction_run_id, subject_source_record_id, subject_source_record_key,
      subject_source_content_hash, product_id, field_family, response_evidence_hash, status,
      prediction_count, candidate_count, rejection_count, failure_count, conflict_count,
      reasons_json, attempted_at, is_current
    ) VALUES (${sql(attempt.id)}, ${sql(attempt.extractionRunId)},
      ${sql(attempt.subjectSourceRecordId)}, ${sql(attempt.subjectSourceRecordKey)},
      ${sql(attempt.subjectSourceContentHash)}, ${sql(attempt.productId)},
      ${sql(attempt.fieldFamily)}, ${sql(attempt.responseEvidenceHash)}, ${sql(attempt.status)},
      ${attempt.predictionCount}, ${attempt.candidateCount}, ${attempt.rejectionCount},
      ${attempt.failureCount}, ${attempt.conflictCount}, ${json(attempt.reasons)},
      ${sql(attempt.attemptedAt)}, 0);`);
  }
  for (const label of extraction.attemptLabels) {
    await write(output, `INSERT OR IGNORE INTO extraction_attempt_labels (
      id, attempt_id, label_asset_id, role, outcome, prediction_count, candidate_count,
      rejection_count, failure_count, conflict_count, candidate_hashes_json, reasons_json
    ) VALUES (${sql(label.id)}, ${sql(label.attemptId)}, ${sql(label.labelAssetId)},
      ${sql(label.role)}, ${sql(label.outcome)}, ${label.predictionCount}, ${label.candidateCount},
      ${label.rejectionCount}, ${label.failureCount}, ${label.conflictCount},
      ${json(label.candidateHashes)}, ${json(label.reasons)});`);
  }
  for (const attempt of extraction.attempts.filter(({ isCurrent }) => isCurrent)) {
    const newerThanCurrent = `(attempted_at < ${sql(attempt.attemptedAt)} OR (attempted_at = ${sql(attempt.attemptedAt)} AND id < ${sql(attempt.id)}))`;
    const currentNewer = `(current.attempted_at > ${sql(attempt.attemptedAt)} OR (current.attempted_at = ${sql(attempt.attemptedAt)} AND current.id > ${sql(attempt.id)}))`;
    await write(output, `UPDATE extraction_attempts SET is_current = 0
      WHERE subject_source_record_id = ${sql(attempt.subjectSourceRecordId)}
        AND field_family = ${sql(attempt.fieldFamily)} AND is_current = 1
        AND id <> ${sql(attempt.id)} AND ${newerThanCurrent};`);
    await write(output, `UPDATE extraction_attempts SET is_current = 1 WHERE id = ${sql(attempt.id)}
      AND NOT EXISTS (SELECT 1 FROM extraction_attempts current
        WHERE current.subject_source_record_id = ${sql(attempt.subjectSourceRecordId)}
          AND current.field_family = ${sql(attempt.fieldFamily)} AND current.is_current = 1
          AND current.id <> ${sql(attempt.id)} AND ${currentNewer});`);
  }
}

async function nutritionDecisionCandidate(product: StagedProduct): Promise<NutritionDecisionCandidate | null> {
  const issue = product.validationIssues.find(({ code }) => code === "robotoff_nutrition_candidate");
  if (!issue) return null;
  const candidate = nutritionCandidateFromEvidence(issue, product.gtin);
  const declaredHash = record(issue.details)?.candidateHash;
  if (!candidate || (declaredHash !== undefined && typeof declaredHash !== "string")) return null;
  const computedHash = await nutritionCandidateHash(candidate);
  return declaredHash === undefined || computedHash === declaredHash
    ? { candidate, candidateHash: computedHash }
    : null;
}

function exactNutritionProjectionWhere(candidate: NutritionCandidate, productIdSql: string): string {
  const basis = nutritionCandidateNormalizedBasis(candidate);
  const nutrition = nutritionCandidateValues(candidate);
  const columns = [
    ["calories", nutrition.calories],
    ["protein_grams", nutrition.proteinGrams],
    ["carbohydrate_grams", nutrition.carbohydrateGrams],
    ["sugar_grams", nutrition.sugarGrams],
    ["fat_grams", nutrition.fatGrams],
    ["saturated_fat_grams", nutrition.saturatedFatGrams],
    ["fibre_grams", nutrition.fibreGrams],
    ["sodium_mg", nutrition.sodiumMg],
  ] as const;
  return `EXISTS (SELECT 1 FROM nutrition_facts selected WHERE selected.product_id = ${productIdSql} AND selected.status = 'verified' AND selected.authority = 100 AND selected.basis = ${sql(basis)} AND ${columns.map(([column, value]) => `selected.${column} IS ${sql(value)}`).join(" AND ")})`;
}

function exactCurrentLabelProofWhere(input: {
  product: StagedProduct;
  sourceRecordId: string;
  productIdSql: string;
  fieldFamily: "nutrition" | "ingredients";
  candidateHash: string;
  evidenceUrl: string;
}): string | null {
  const rawEvidence = record(input.product.rawEvidence);
  const extractionAttemptId = rawEvidence?.extractionAttemptId;
  const labelAssetId = rawEvidence?.labelAssetId;
  const labelContentSha256 = rawEvidence?.labelContentSha256;
  if (typeof extractionAttemptId !== "string" || !extractionAttemptId
    || typeof labelAssetId !== "string" || !labelAssetId
    || typeof labelContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(labelContentSha256)) {
    return null;
  }
  return `d.extraction_attempt_id = ${sql(extractionAttemptId)} AND d.label_asset_id = ${sql(labelAssetId)} AND d.evidence_url = ${sql(input.evidenceUrl)} AND EXISTS (SELECT 1 FROM extraction_attempts current_attempt JOIN extraction_attempt_labels current_label ON current_label.attempt_id = current_attempt.id AND current_label.label_asset_id = ${sql(labelAssetId)} JOIN label_evidence_assets current_asset ON current_asset.id = current_label.label_asset_id WHERE current_attempt.id = ${sql(extractionAttemptId)} AND current_attempt.subject_source_record_id = ${sql(input.sourceRecordId)} AND current_attempt.subject_source_record_key = ${sql(input.product.sourceRecordId)} AND current_attempt.subject_source_content_hash = ${sql(input.product.contentHash)} AND current_attempt.product_id = ${input.productIdSql} AND current_attempt.field_family = ${sql(input.fieldFamily)} AND current_attempt.status = 'candidate' AND current_attempt.is_current = 1 AND current_label.outcome = 'candidate' AND current_asset.subject_source_record_id = ${sql(input.sourceRecordId)} AND current_asset.subject_source_content_hash = ${sql(input.product.contentHash)} AND current_asset.product_id = ${input.productIdSql} AND current_asset.field_family = ${sql(input.fieldFamily)} AND current_asset.content_sha256 = ${sql(labelContentSha256)} AND current_asset.effective_url = ${sql(input.evidenceUrl)} AND EXISTS (SELECT 1 FROM json_each(current_label.candidate_hashes_json) candidate_hash WHERE candidate_hash.value = ${sql(input.candidateHash)}))`;
}

async function ingredientDecisionCandidate(product: StagedProduct): Promise<IngredientDecisionCandidate | null> {
  const issue = product.validationIssues.find(({ code }) => code === "robotoff_ingredient_candidate");
  const details = record(issue?.details);
  const declaredHash = details?.candidateHash;
  if (!issue || (declaredHash !== undefined && typeof declaredHash !== "string")) return null;
  try {
    const candidate = ingredientCandidateFromEvidence(issue, product.gtin);
    if (!candidate) return null;
    const computedHash = await ingredientCandidateHash(candidate);
    return declaredHash === undefined || computedHash === declaredHash
      ? { candidate, candidateHash: computedHash }
      : null;
  } catch {
    return null;
  }
}

function flattenIngredients(
  ingredients: NormalizedIngredient[],
  parentId: string | null,
  sourceRecordId: string,
  productId: string,
): Array<{ id: string; parentId: string | null; ingredient: NormalizedIngredient }> {
  return ingredients.flatMap((ingredient) => {
    const id = stableId("ing", `${sourceRecordId}:${parentId ?? "root"}:${ingredient.position}:${ingredient.raw}`);
    return [
      { id, parentId, ingredient },
      ...flattenIngredients(ingredient.children, id, sourceRecordId, productId),
    ];
  });
}

export async function emitImportSql(input: {
  stagedPath: string;
  manifestPath: string;
  outputPath: string;
  includeTransaction?: boolean;
  includePragma?: boolean;
  applyEvidenceDecisions?: boolean;
  extraction?: ExtractionImportInput;
}): Promise<{ products: number; outputPath: string; runId: string }> {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8")) as SourceManifest;
  const runId = ingestionRunIdForManifest(manifest);
  const expectedExtractionFamily = manifest.source === "open_food_facts_robotoff"
    ? "nutrition"
    : manifest.source === "open_food_facts_robotoff_ingredients" ? "ingredients" : null;
  const extraction = input.extraction ? {
    run: input.extraction.run,
    labelAssets: await validatedJsonLines<LabelEvidenceAsset>(
      input.extraction.labelAssetsPath,
      "label-assets.jsonl",
      validateLabelEvidenceAsset,
    ),
    attempts: await validatedJsonLines<ExtractionAttempt>(
      input.extraction.extractionAttemptsPath,
      "extraction-attempts.jsonl",
      validateExtractionAttempt,
    ),
    attemptLabels: await validatedJsonLines<ExtractionAttemptLabel>(
      input.extraction.extractionAttemptLabelsPath,
      "extraction-attempt-labels.jsonl",
      validateExtractionAttemptLabel,
    ),
  } : null;
  if (extraction) {
    const runErrors = validateExtractionRun(extraction.run);
    if (runErrors.length > 0) throw new Error(`Extraction run is invalid: ${runErrors.join("; ")}`);
    if (!expectedExtractionFamily || extraction.run.fieldFamily !== expectedExtractionFamily) {
      throw new Error("Extraction run family does not match the publication source");
    }
    if (extraction.run.ingestionRunId !== runId || extraction.run.adapterVersion !== manifest.adapterVersion) {
      throw new Error("Extraction run does not match the exact ingestion manifest");
    }
    if (extraction.run.status !== "accepted" || !extraction.run.sourceComplete) {
      throw new Error("Only an accepted source-complete extraction run can be imported");
    }
    const assetIds = new Set(extraction.labelAssets.map(({ id }) => id));
    const attemptIds = new Set(extraction.attempts.map(({ id }) => id));
    if (assetIds.size !== extraction.labelAssets.length || attemptIds.size !== extraction.attempts.length) {
      throw new Error("Extraction artifact contains duplicate immutable IDs");
    }
    if (extraction.attempts.some((attempt) => attempt.extractionRunId !== extraction.run.id)
      || extraction.attemptLabels.some((label) => !attemptIds.has(label.attemptId) || !assetIds.has(label.labelAssetId))) {
      throw new Error("Extraction artifact contains a cross-run or missing label binding");
    }
  } else if (expectedExtractionFamily && manifest.mode === "production") {
    throw new Error("Production Robotoff imports require exact label and extraction ledgers");
  }
  const applyEvidenceDecisions = input.applyEvidenceDecisions !== false;
  const output = createWriteStream(input.outputPath, { encoding: "utf8" });
  if (input.includePragma !== false) await write(output, "PRAGMA foreign_keys = ON;");
  if (input.includeTransaction !== false) await write(output, "BEGIN IMMEDIATE;");
  await write(
    output,
    `INSERT INTO sources (id, name, kind, identity_authority, nutrition_authority, ingredient_authority, license_url, retention_notes, credential_requirement, created_at) VALUES (${sql(manifest.source)}, ${sql(manifest.source)}, ${sql(manifest.sourceKind)}, ${manifest.sourceAuthority.identity}, ${manifest.sourceAuthority.nutrition}, ${manifest.sourceAuthority.ingredients}, ${sql(manifest.sourceLicenseUrl)}, ${sql(manifest.sourceRetentionNotes)}, NULL, ${sql(manifest.startedAt)}) ON CONFLICT(id) DO UPDATE SET identity_authority = excluded.identity_authority, nutrition_authority = excluded.nutrition_authority, ingredient_authority = excluded.ingredient_authority, license_url = excluded.license_url, retention_notes = excluded.retention_notes;`,
  );
  await write(
    output,
    `INSERT INTO ingestion_runs (id, source_id, adapter_version, mode, input_identifier, input_hash, input_bytes, advertised_total, records_read, india_records, staged_records, invalid_records, duplicate_records, terminal_evidence, source_complete, market_complete, status, started_at, completed_at, manifest_json) VALUES (${sql(runId)}, ${sql(manifest.source)}, ${sql(manifest.adapterVersion)}, ${sql(manifest.mode)}, ${sql(manifest.input)}, ${sql(manifest.inputHash)}, ${sql(manifest.inputBytes)}, ${sql(manifest.advertisedTotal)}, ${manifest.recordsRead}, ${manifest.indiaRecords}, ${manifest.stagedRecords}, ${manifest.invalidRecords}, ${manifest.duplicateRecords}, ${sql(manifest.terminalEvidence)}, ${sql(manifest.sourceComplete)}, 0, 'running', ${sql(manifest.startedAt)}, NULL, ${json(manifest)}) ON CONFLICT(id) DO UPDATE SET status = 'running', completed_at = NULL, manifest_json = excluded.manifest_json;`,
  );
  if (extraction) await emitExtractionImport(output, extraction);

  const lines = createInterface({ input: createReadStream(input.stagedPath), crlfDelay: Infinity });
  let products = 0;
  const pendingIdentityReviews: PendingIdentityReview[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const product = JSON.parse(line) as StagedProduct;
    const deferredNutritionDriftCleanup: string[] = [];
    const productId = productIdFor(product);
    const sourceRecordId = stableId("src", `${product.source}:${product.sourceRecordId}`);
    const identityHash = identityEvidenceHash(product);
    const nutritionCandidate = await nutritionDecisionCandidate(product);
    const ingredientCandidate = await ingredientDecisionCandidate(product);
    const decisionProductSql = `(SELECT identity_decision.target_product_id FROM identity_decisions identity_decision WHERE identity_decision.source_id = ${sql(product.source)} AND identity_decision.source_record_key = ${sql(product.sourceRecordId)} AND identity_decision.identity_hash = ${sql(identityHash)} AND identity_decision.active = 1 ORDER BY identity_decision.decided_at DESC LIMIT 1)`;
    const decisionKindSql = `(SELECT identity_decision.decision FROM identity_decisions identity_decision WHERE identity_decision.source_id = ${sql(product.source)} AND identity_decision.source_record_key = ${sql(product.sourceRecordId)} AND identity_decision.identity_hash = ${sql(identityHash)} AND identity_decision.active = 1 ORDER BY identity_decision.decided_at DESC LIMIT 1)`;
    const productIdSql = `COALESCE(${decisionProductSql}, ${sql(productId)})`;
    const sourceProductIdSql = `CASE WHEN ${decisionKindSql} = 'no_match' THEN NULL ELSE ${productIdSql} END`;
    const automaticRule = product.gtin ? "exact_gtin" : compositeIdentityKey(product) ? "deterministic_composite" : "source_identity";
    const resolutionRuleSql = `COALESCE('manual_' || ${decisionKindSql}, ${sql(automaticRule)})`;
    const extractionCurrentGuard = extraction
      ? ` WHERE EXISTS (SELECT 1 FROM extraction_attempts current_attempt
          WHERE current_attempt.id = json_extract(excluded.raw_evidence_json, '$.extractionAttemptId')
            AND current_attempt.product_id = excluded.product_id
            AND current_attempt.field_family = ${sql(extraction.run.fieldFamily)}
            AND current_attempt.is_current = 1)`
      : "";
    const now = manifest.completedAt;
    const nutritionExactLabelProof = nutritionCandidate
      ? exactCurrentLabelProofWhere({
        product,
        sourceRecordId,
        productIdSql,
        fieldFamily: "nutrition",
        candidateHash: nutritionCandidate.candidateHash,
        evidenceUrl: nutritionCandidate.candidate.imageUrl,
      })
      : null;
    const ingredientExactLabelProof = ingredientCandidate
      ? exactCurrentLabelProofWhere({
        product,
        sourceRecordId,
        productIdSql,
        fieldFamily: "ingredients",
        candidateHash: ingredientCandidate.candidateHash,
        evidenceUrl: ingredientCandidate.candidate.imageUrl,
      })
      : null;
    await write(
      output,
      `INSERT INTO products (id, product_kind, gtin, brand, brand_normalized, name, name_normalized, flavour, flavour_normalized, category, category_raw, net_quantity_grams, serving_size_grams, image_url, nutrition_image_url, ingredient_image_url, marketed_protein, marketed_reasons_json, nutritionally_protein_dense, nutrition_reasons_json, classifier_version, completeness, completeness_missing_json, identity_authority, created_at, updated_at) VALUES (${productIdSql}, ${sql(product.productKind)}, ${sql(product.gtin)}, ${sql(product.brand)}, ${sql(normalizeText(product.brand))}, ${sql(product.name)}, ${sql(normalizeText(product.name))}, ${sql(product.flavour)}, ${sql(normalizeText(product.flavour) || null)}, ${sql(product.category)}, ${sql(product.categoryRaw)}, ${sql(product.netQuantityGrams)}, ${sql(product.servingSizeGrams)}, ${sql(product.imageUrl)}, ${sql(product.nutritionImageUrl)}, ${sql(product.ingredientImageUrl)}, ${sql(product.classification.marketed)}, ${json(product.classification.marketedReasons)}, ${sql(product.classification.nutritionallyDense)}, ${json(product.classification.nutritionReasons)}, ${sql(product.classification.version)}, ${product.completeness}, ${json(product.completenessMissing)}, ${product.sourceAuthority.identity}, ${sql(now)}, ${sql(now)}) ON CONFLICT(id) DO UPDATE SET brand = excluded.brand, brand_normalized = excluded.brand_normalized, name = excluded.name, name_normalized = excluded.name_normalized, flavour = COALESCE(excluded.flavour, products.flavour), flavour_normalized = COALESCE(excluded.flavour_normalized, products.flavour_normalized), category = excluded.category, category_raw = COALESCE(excluded.category_raw, products.category_raw), net_quantity_grams = COALESCE(excluded.net_quantity_grams, products.net_quantity_grams), serving_size_grams = COALESCE(excluded.serving_size_grams, products.serving_size_grams), image_url = COALESCE(excluded.image_url, products.image_url), nutrition_image_url = COALESCE(excluded.nutrition_image_url, products.nutrition_image_url), ingredient_image_url = COALESCE(excluded.ingredient_image_url, products.ingredient_image_url), marketed_protein = excluded.marketed_protein, marketed_reasons_json = excluded.marketed_reasons_json, nutritionally_protein_dense = CASE WHEN EXISTS (SELECT 1 FROM nutrition_facts selected WHERE selected.product_id = products.id AND selected.status = 'verified') THEN products.nutritionally_protein_dense ELSE excluded.nutritionally_protein_dense END, nutrition_reasons_json = CASE WHEN EXISTS (SELECT 1 FROM nutrition_facts selected WHERE selected.product_id = products.id AND selected.status = 'verified') THEN products.nutrition_reasons_json ELSE excluded.nutrition_reasons_json END, classifier_version = excluded.classifier_version, completeness_missing_json = CASE WHEN excluded.completeness >= products.completeness THEN excluded.completeness_missing_json ELSE products.completeness_missing_json END, completeness = MAX(products.completeness, excluded.completeness), identity_authority = MAX(products.identity_authority, excluded.identity_authority), updated_at = excluded.updated_at WHERE excluded.identity_authority >= products.identity_authority;`,
    );
    await write(
      output,
      `INSERT INTO source_records (id, source_id, source_record_id, product_id, source_url, content_hash, identity_hash, observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule) VALUES (${sql(sourceRecordId)}, ${sql(product.source)}, ${sql(product.sourceRecordId)}, ${sourceProductIdSql}, ${sql(product.sourceUrl)}, ${sql(product.contentHash)}, ${sql(identityHash)}, ${sql(product.observedAt)}, ${sql(runId)}, ${sql(runId)}, ${json(product.rawEvidence)}, ${resolutionRuleSql}) ON CONFLICT(source_id, source_record_id) DO UPDATE SET product_id = excluded.product_id, source_url = excluded.source_url, content_hash = excluded.content_hash, identity_hash = excluded.identity_hash, observed_at = excluded.observed_at, last_seen_run_id = excluded.last_seen_run_id, raw_evidence_json = excluded.raw_evidence_json, resolution_rule = excluded.resolution_rule${extractionCurrentGuard};`,
    );
    await write(
      output,
      `DELETE FROM product_ingredients WHERE source_record_id = ${sql(sourceRecordId)} AND NOT EXISTS (SELECT 1 FROM ingredient_statements statement WHERE statement.product_id = ${productIdSql} AND statement.source_record_id = ${sql(sourceRecordId)} AND statement.authority >= 100);`,
    );
    await write(
      output,
      `UPDATE products SET is_active = 1 WHERE id = ${sql(productId)} AND NOT EXISTS (SELECT 1 FROM identity_decisions d WHERE d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.identity_hash = ${sql(identityHash)} AND d.active = 1 AND (d.decision = 'no_match' OR d.target_product_id <> ${sql(productId)}));`,
    );
    await write(
      output,
      `DELETE FROM evidence_outcomes AS outcome WHERE outcome.field_family = 'identity' AND outcome.source_record_id = ${sql(sourceRecordId)} AND NOT EXISTS (SELECT 1 FROM current_identity_evidence_decisions decision WHERE decision.product_id = outcome.product_id AND decision.source_record_id = outcome.source_record_id AND decision.evidence_url = outcome.evidence_url AND decision.source_observed_at = outcome.observed_at AND decision.decided_at = outcome.verified_at AND decision.decided_by = outcome.decided_by AND decision.rationale = outcome.notes);`,
    );
    await write(
      output,
      `WITH affected_products AS (SELECT decision.product_id FROM identity_evidence_decisions decision WHERE decision.source_record_id = ${sql(sourceRecordId)} UNION SELECT current_source.product_id FROM source_records current_source WHERE current_source.id = ${sql(sourceRecordId)} AND current_source.product_id IS NOT NULL), valid_identity_decisions AS (SELECT decision.*, ROW_NUMBER() OVER (PARTITION BY decision.product_id ORDER BY decision.decided_at DESC, decision.id DESC) AS decision_rank FROM current_identity_evidence_decisions decision JOIN affected_products affected ON affected.product_id = decision.product_id) INSERT INTO evidence_outcomes (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes) SELECT decision.product_id, 'identity', 'verified', decision.source_record_id, decision.evidence_url, decision.source_observed_at, decision.decided_at, decision.decided_by, decision.rationale FROM valid_identity_decisions decision WHERE decision.decision_rank = 1 ON CONFLICT(product_id, field_family) DO UPDATE SET outcome = excluded.outcome, source_record_id = excluded.source_record_id, evidence_url = excluded.evidence_url, observed_at = excluded.observed_at, verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes WHERE evidence_outcomes.outcome IS NOT excluded.outcome OR evidence_outcomes.source_record_id IS NOT excluded.source_record_id OR evidence_outcomes.evidence_url IS NOT excluded.evidence_url OR evidence_outcomes.observed_at IS NOT excluded.observed_at OR evidence_outcomes.verified_at IS NOT excluded.verified_at OR evidence_outcomes.decided_by IS NOT excluded.decided_by OR evidence_outcomes.notes IS NOT excluded.notes;`,
    );
    if (product.source === "open_food_facts_robotoff") {
      const candidateHash = nutritionCandidate?.candidateHash ?? null;
      await write(
        output,
        `UPDATE review_items SET status = 'dismissed', decision = 'dismiss', decision_rationale = 'Superseded by corrected source evidence', decided_by = 'system_reconciliation', resolved_at = ${sql(now)} WHERE status = 'open' AND source_record_id = ${sql(sourceRecordId)} AND type = 'nutrition_validation' AND json_valid(evidence_json) AND json_extract(evidence_json, '$.code') = 'robotoff_nutrition_candidate' AND (${sql(candidateHash)} IS NULL OR COALESCE(json_extract(evidence_json, '$.details.candidateHash'), '') <> ${sql(candidateHash)});`,
      );
    }
    if (product.source === "open_food_facts_robotoff_ingredients") {
      const candidateHash = ingredientCandidate?.candidateHash ?? null;
      await write(
        output,
        `UPDATE review_items SET status = 'dismissed', decision = 'dismiss', decision_rationale = 'Superseded by corrected source evidence', decided_by = 'system_reconciliation', resolved_at = ${sql(now)} WHERE status = 'open' AND source_record_id = ${sql(sourceRecordId)} AND type = 'ingredient_conflict' AND json_valid(evidence_json) AND json_extract(evidence_json, '$.code') = 'robotoff_ingredient_candidate' AND (${sql(candidateHash)} IS NULL OR COALESCE(json_extract(evidence_json, '$.details.candidateHash'), '') <> ${sql(candidateHash)});`,
      );
    }
    if (!product.gtin && !compositeIdentityKey(product)) {
      pendingIdentityReviews.push({
        reviewId: stableId("rev", `${sourceRecordId}:identity:${identityHash}`),
        sourceRecordId,
        proposedProductId: productId,
        source: product.source,
        sourceRecordKey: product.sourceRecordId,
        identityHash,
        brand: normalizeText(product.brand),
        name: normalizeText(product.name),
        flavour: normalizeText(product.flavour) || null,
        netQuantityGrams: product.netQuantityGrams,
        createdAt: now,
      });
    }

    const nutritionHasError = product.validationIssues.some((issue) => issue.severity === "error" && issue.field !== "gtin");
    if (!nutritionHasError && product.nutrition.status !== "missing") {
      const nutrient = product.nutrition.per100g;
      const incomingNutritionCompleteness = nutritionProjectionCompletenessSql("excluded");
      const selectedNutritionCompleteness = nutritionProjectionCompletenessSql("nutrition_facts");
      await write(
        output,
        `INSERT INTO nutrition_facts (product_id, source_record_id, status, confidence, authority, basis, preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at) VALUES (${productIdSql}, ${sql(sourceRecordId)}, ${sql(product.nutrition.status)}, ${sql(product.nutrition.confidence)}, ${product.sourceAuthority.nutrition}, ${sql(product.nutrition.basis)}, ${sql(product.nutrition.preparationState)}, ${sql(nutrient.calories)}, ${sql(nutrient.proteinGrams)}, ${sql(nutrient.carbohydrateGrams)}, ${sql(nutrient.sugarGrams)}, ${sql(nutrient.fatGrams)}, ${sql(nutrient.saturatedFatGrams)}, ${sql(nutrient.fibreGrams)}, ${sql(nutrient.sodiumMg)}, ${sql(product.nutrition.labelVerifiedAt)}, ${sql(product.nutrition.observedAt)}, ${sql(now)}) ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence, authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state, calories = excluded.calories, protein_grams = excluded.protein_grams, carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams, fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams, fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg, label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at, updated_at = excluded.updated_at WHERE excluded.authority > nutrition_facts.authority OR (excluded.authority = nutrition_facts.authority AND excluded.observed_at > nutrition_facts.observed_at AND (${incomingNutritionCompleteness}) >= (${selectedNutritionCompleteness}));`,
      );
    }

    const redundantNutritionDecisionWhere = nutritionCandidate
      ? `d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.candidate_hash = ${sql(nutritionCandidate.candidateHash)} AND d.field_family = 'nutrition' AND d.decision = 'redundant' AND d.active = 1`
      : null;
    const exactNutritionProjection = nutritionCandidate
      ? exactNutritionProjectionWhere(nutritionCandidate.candidate, productIdSql)
      : null;
    if (redundantNutritionDecisionWhere && exactNutritionProjection) {
      await write(
        output,
        `UPDATE evidence_decisions AS d SET active = 0 WHERE ${redundantNutritionDecisionWhere} AND NOT (d.source_record_id = ${sql(sourceRecordId)} AND d.source_content_hash = ${sql(product.contentHash)} AND d.product_id = ${productIdSql} AND ${exactNutritionProjection});`,
      );
    }
    const nutritionDecisionWhere = nutritionCandidate && exactNutritionProjection
      ? `d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.source_record_id = ${sql(sourceRecordId)} AND d.source_content_hash = ${sql(product.contentHash)} AND d.product_id = ${productIdSql} AND d.candidate_hash = ${sql(nutritionCandidate.candidateHash)} AND d.field_family = 'nutrition' AND d.active = 1${nutritionExactLabelProof ? ` AND ${nutritionExactLabelProof}` : ""} AND (d.decision <> 'redundant' OR ${exactNutritionProjection})`
      : null;
    if (product.source === "open_food_facts_robotoff") {
      const exactDecisionAbsent = nutritionDecisionWhere
        ? `NOT EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${nutritionDecisionWhere})`
        : "1 = 1";
      const driftWhere = `d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.product_id = ${productIdSql} AND d.field_family = 'nutrition' AND d.active = 1 AND ${nutritionCandidate
        ? `(d.source_content_hash <> ${sql(product.contentHash)} OR d.source_record_id <> ${sql(sourceRecordId)} OR d.candidate_hash <> ${sql(nutritionCandidate.candidateHash)}${nutritionExactLabelProof ? ` OR NOT COALESCE((${nutritionExactLabelProof}), 0)` : ""})`
        : "1 = 1"}`;
      await write(
        output,
        `UPDATE nutrition_facts SET status = 'conflict', confidence = 'low', label_verified_at = NULL, updated_at = ${sql(now)} WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
      );
      await write(
        output,
        `UPDATE products SET nutritionally_protein_dense = NULL, nutrition_reasons_json = '[]', updated_at = ${sql(now)} WHERE id = ${productIdSql} AND EXISTS (SELECT 1 FROM nutrition_facts selected WHERE selected.product_id = ${productIdSql} AND selected.status = 'conflict');`,
      );
      await write(
        output,
        `DELETE FROM evidence_outcomes WHERE product_id = ${productIdSql} AND field_family = 'nutrition' AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
      );
      await write(
        output,
        `DELETE FROM nutrient_values WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND nutrient_code IN ('calories', 'proteinGrams', 'carbohydrateGrams', 'sugarGrams', 'fatGrams', 'saturatedFatGrams', 'fibreGrams', 'sodiumMg') AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
      );
      deferredNutritionDriftCleanup.push(
        `UPDATE field_observations SET selected = 0 WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND authority = 100 AND field_path LIKE 'nutrition.%' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
        `UPDATE evidence_decisions AS d SET active = 0 WHERE ${driftWhere};`,
      );
    }
    if (nutritionCandidate && nutritionDecisionWhere) {
      const reviewedNutritionBasis = nutritionCandidateNormalizedBasis(nutritionCandidate.candidate);
      const reviewedNutritionKey = reviewedNutritionBasis === "per_100ml" ? "nutritionPer100ml" : "nutritionPer100g";
      const effectiveBasis = `COALESCE(json_extract(d.payload_json, '$.reviewedProjection.basis'), ${sql(reviewedNutritionBasis)})`;
      const effectiveObservedAt = "COALESCE(json_extract(d.payload_json, '$.candidate.observedAt'), json_extract(d.payload_json, '$.observedAt'))";
      const effectiveNutritionValue = (field: string): string => `CASE json_extract(d.payload_json, '$.reviewedProjection.basis') WHEN 'per_100g' THEN json_extract(d.payload_json, '$.reviewedProjection.nutritionPer100g.${field}') WHEN 'per_100ml' THEN json_extract(d.payload_json, '$.reviewedProjection.nutritionPer100ml.${field}') ELSE json_extract(d.payload_json, '$.${reviewedNutritionKey}.${field}') END`;
      const verifyWhere = `${nutritionDecisionWhere} AND d.decision = 'verify'`;
      if (applyEvidenceDecisions) {
        await write(
          output,
          `INSERT INTO nutrition_facts (product_id, source_record_id, status, confidence, authority, basis, preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at) SELECT d.product_id, d.source_record_id, 'verified', 'high', 100, ${effectiveBasis}, 'as_sold', ${effectiveNutritionValue("calories")}, ${effectiveNutritionValue("proteinGrams")}, ${effectiveNutritionValue("carbohydrateGrams")}, ${effectiveNutritionValue("sugarGrams")}, ${effectiveNutritionValue("fatGrams")}, ${effectiveNutritionValue("saturatedFatGrams")}, ${effectiveNutritionValue("fibreGrams")}, ${effectiveNutritionValue("sodiumMg")}, d.decided_at, ${effectiveObservedAt}, d.decided_at FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence, authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state, calories = excluded.calories, protein_grams = excluded.protein_grams, carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams, fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams, fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg, label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at, updated_at = excluded.updated_at;`,
        );
        const effectiveCalories = effectiveNutritionValue("calories");
        const effectiveProtein = effectiveNutritionValue("proteinGrams");
        await write(
          output,
          `WITH latest_verified AS (SELECT ${effectiveBasis} AS basis, ${effectiveCalories} AS calories, ${effectiveProtein} AS protein FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1) UPDATE products SET nutritionally_protein_dense = CASE WHEN EXISTS (SELECT 1 FROM latest_verified v WHERE (v.protein / v.calories) * 100 >= 10 OR ((v.protein * 4) / v.calories) * 100 >= 20 OR (v.basis = 'per_100g' AND v.protein * products.serving_size_grams / 100.0 >= 10)) THEN 1 ELSE 0 END, nutrition_reasons_json = (SELECT json_group_array(reason) FROM (SELECT 'protein_at_least_10g_per_100kcal' AS reason FROM latest_verified v WHERE (v.protein / v.calories) * 100 >= 10 UNION ALL SELECT 'protein_at_least_20_percent_calories' FROM latest_verified v WHERE ((v.protein * 4) / v.calories) * 100 >= 20 UNION ALL SELECT 'protein_at_least_10g_per_serving' FROM latest_verified v WHERE v.basis = 'per_100g' AND v.protein * products.serving_size_grams / 100.0 >= 10)), classifier_version = 'protein-v1', updated_at = ${sql(now)} WHERE id = ${productIdSql} AND EXISTS (SELECT 1 FROM latest_verified);`,
        );
        await write(
          output,
          `UPDATE field_observations SET selected = 0 WHERE product_id = ${productIdSql} AND field_path LIKE 'nutrition.%' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${verifyWhere});`,
        );
        await write(
          output,
          `DELETE FROM nutrient_values WHERE product_id = ${productIdSql} AND nutrient_code IN ('calories', 'proteinGrams', 'carbohydrateGrams', 'sugarGrams', 'fatGrams', 'saturatedFatGrams', 'fibreGrams', 'sodiumMg') AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${verifyWhere});`,
        );
        const reviewedNutritionFields = [
          ["calories", "kcal"],
          ["proteinGrams", "g"],
          ["carbohydrateGrams", "g"],
          ["sugarGrams", "g"],
          ["fatGrams", "g"],
          ["saturatedFatGrams", "g"],
          ["fibreGrams", "g"],
          ["sodiumMg", "mg"],
        ] as const;
        for (const [field, unit] of reviewedNutritionFields) {
          const valueExpression = effectiveNutritionValue(field);
          const valueHash = `reviewed:${nutritionCandidate.candidateHash}:${field}`;
          const observationId = stableId("obs", `${sourceRecordId}:${valueHash}`);
          const nutrientId = stableId("nut", `${sourceRecordId}:${nutritionCandidate.candidateHash}:${field}`);
          await write(
            output,
            `INSERT INTO field_observations (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json, confidence, authority, observed_at, evidence_url, selected, value_hash) SELECT ${sql(observationId)}, d.product_id, d.source_record_id, ${sql(`nutrition.${field}`)}, json(${valueExpression}), json(${valueExpression}), 'high', 100, ${effectiveObservedAt}, d.evidence_url, 1, ${sql(valueHash)} FROM evidence_decisions d WHERE ${verifyWhere} AND ${valueExpression} IS NOT NULL ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET product_id = excluded.product_id, raw_value_json = excluded.raw_value_json, normalized_value_json = excluded.normalized_value_json, confidence = excluded.confidence, authority = excluded.authority, observed_at = excluded.observed_at, evidence_url = excluded.evidence_url, selected = 1;`,
          );
          await write(
            output,
            `INSERT INTO nutrient_values (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at) SELECT ${sql(nutrientId)}, d.product_id, d.source_record_id, ${sql(field)}, ${valueExpression}, ${sql(unit)}, ${effectiveBasis}, 'as_sold', 'verified', ${effectiveObservedAt} FROM evidence_decisions d WHERE ${verifyWhere} AND ${valueExpression} IS NOT NULL ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(source_record_id, nutrient_code, basis, preparation_state) DO UPDATE SET product_id = excluded.product_id, quantity = excluded.quantity, unit = excluded.unit, status = excluded.status, observed_at = excluded.observed_at;`,
          );
        }
        await write(
          output,
          `INSERT INTO evidence_outcomes (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes) SELECT d.product_id, 'nutrition', 'verified', d.source_record_id, d.evidence_url, ${effectiveObservedAt}, d.decided_at, d.decided_by, d.rationale FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(product_id, field_family) DO UPDATE SET outcome = excluded.outcome, source_record_id = excluded.source_record_id, evidence_url = excluded.evidence_url, observed_at = excluded.observed_at, verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes;`,
        );
      }
    }

    const ingredientDecisionWhere = ingredientCandidate
      ? `d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.source_record_id = ${sql(sourceRecordId)} AND d.source_content_hash = ${sql(product.contentHash)} AND d.product_id = ${productIdSql} AND d.candidate_hash = ${sql(ingredientCandidate.candidateHash)} AND d.field_family = 'ingredients' AND d.active = 1${ingredientExactLabelProof ? ` AND ${ingredientExactLabelProof}` : ""}`
      : null;
    if (product.source === "open_food_facts_robotoff_ingredients") {
      const exactDecisionAbsent = ingredientDecisionWhere
        ? `NOT EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${ingredientDecisionWhere})`
        : "1 = 1";
      const driftWhere = `d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.product_id = ${productIdSql} AND d.field_family = 'ingredients' AND d.active = 1 AND ${ingredientCandidate
        ? `(d.source_content_hash <> ${sql(product.contentHash)} OR d.candidate_hash <> ${sql(ingredientCandidate.candidateHash)}${ingredientExactLabelProof ? ` OR NOT COALESCE((${ingredientExactLabelProof}), 0)` : ""})`
        : "1 = 1"}`;
      await write(
        output,
        `UPDATE ingredient_statements SET status = 'conflict', confidence = 'low', authority = MIN(authority, 20), updated_at = ${sql(now)} WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
      );
      await write(
        output,
        `DELETE FROM product_ingredients WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
      );
      await write(
        output,
        `UPDATE field_observations SET selected = 0 WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND field_path = 'ingredients.raw' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
      );
      await write(
        output,
        `DELETE FROM evidence_outcomes WHERE product_id = ${productIdSql} AND field_family = 'ingredients' AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND ${exactDecisionAbsent};`,
      );
      await write(
        output,
        `UPDATE evidence_decisions AS d SET active = 0 WHERE ${driftWhere} AND ${exactDecisionAbsent};`,
      );
    }
    if (ingredientCandidate && ingredientDecisionWhere) {
      const verifyWhere = `${ingredientDecisionWhere} AND d.decision = 'verify'`;
      if (applyEvidenceDecisions) {
        await write(
          output,
          `INSERT INTO ingredient_statements (product_id, source_record_id, raw_text, language, status, confidence, authority, observed_at, updated_at) SELECT d.product_id, d.source_record_id, json_extract(d.payload_json, '$.reviewedText'), json_extract(d.payload_json, '$.candidate.language.code'), 'verified', 'high', 100, json_extract(d.payload_json, '$.candidate.observedAt'), d.decided_at FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id, raw_text = excluded.raw_text, language = excluded.language, status = excluded.status, confidence = excluded.confidence, authority = excluded.authority, observed_at = excluded.observed_at, updated_at = excluded.updated_at;`,
        );
        await write(
          output,
          `DELETE FROM product_ingredients WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${verifyWhere});`,
        );
        await write(
          output,
          `WITH RECURSIVE decision AS (SELECT d.* FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1), ingredient_nodes(path, parent_path, position, raw_text, normalized_name, percentage, children) AS (SELECT CAST(root.key AS TEXT), NULL, CAST(json_extract(root.value, '$.position') AS INTEGER), json_extract(root.value, '$.raw'), json_extract(root.value, '$.normalizedName'), json_extract(root.value, '$.percentage'), json_extract(root.value, '$.children') FROM decision d, json_each(d.payload_json, '$.normalizedIngredients') root UNION ALL SELECT ingredient_nodes.path || '.' || child.key, ingredient_nodes.path, CAST(json_extract(child.value, '$.position') AS INTEGER), json_extract(child.value, '$.raw'), json_extract(child.value, '$.normalizedName'), json_extract(child.value, '$.percentage'), json_extract(child.value, '$.children') FROM ingredient_nodes, json_each(ingredient_nodes.children) child) INSERT INTO product_ingredients (id, product_id, source_record_id, parent_id, position, raw_text, normalized_name, percentage, resolved) SELECT 'ing_reviewed_' || substr(d.candidate_hash, 1, 16) || '_' || replace(n.path, '.', '_'), d.product_id, d.source_record_id, CASE WHEN n.parent_path IS NULL THEN NULL ELSE 'ing_reviewed_' || substr(d.candidate_hash, 1, 16) || '_' || replace(n.parent_path, '.', '_') END, n.position, n.raw_text, n.normalized_name, n.percentage, CASE WHEN n.normalized_name IS NULL THEN 0 ELSE 1 END FROM decision d, ingredient_nodes n;`,
        );
        await write(
          output,
          `UPDATE field_observations SET selected = 0 WHERE product_id = ${productIdSql} AND field_path = 'ingredients.raw' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${verifyWhere});`,
        );
        const reviewedIngredientValueHash = `reviewed:${ingredientCandidate.candidateHash}:ingredients.raw`;
        const reviewedIngredientObservationId = stableId("obs", `${sourceRecordId}:${reviewedIngredientValueHash}`);
        await write(
          output,
          `INSERT INTO field_observations (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json, confidence, authority, observed_at, evidence_url, selected, value_hash) SELECT ${sql(reviewedIngredientObservationId)}, d.product_id, d.source_record_id, 'ingredients.raw', json_quote(json_extract(d.payload_json, '$.reviewedText')), json(json_extract(d.payload_json, '$.normalizedIngredients')), 'high', 100, json_extract(d.payload_json, '$.candidate.observedAt'), d.evidence_url, 1, ${sql(reviewedIngredientValueHash)} FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET product_id = excluded.product_id, raw_value_json = excluded.raw_value_json, normalized_value_json = excluded.normalized_value_json, confidence = excluded.confidence, authority = excluded.authority, observed_at = excluded.observed_at, evidence_url = excluded.evidence_url, selected = 1;`,
        );
        await write(
          output,
          `INSERT INTO evidence_outcomes (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes) SELECT d.product_id, 'ingredients', 'verified', d.source_record_id, d.evidence_url, json_extract(d.payload_json, '$.candidate.observedAt'), d.decided_at, d.decided_by, d.rationale FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(product_id, field_family) DO UPDATE SET outcome = excluded.outcome, source_record_id = excluded.source_record_id, evidence_url = excluded.evidence_url, observed_at = excluded.observed_at, verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes;`,
        );
      }
    }

    if (product.ingredients.status !== "missing") {
      await write(
        output,
        `INSERT INTO ingredient_statements (product_id, source_record_id, raw_text, language, status, confidence, authority, observed_at, updated_at) VALUES (${productIdSql}, ${sql(sourceRecordId)}, ${sql(product.ingredients.raw)}, ${sql(product.ingredients.language)}, ${sql(product.ingredients.status)}, ${sql(product.ingredients.confidence)}, ${product.sourceAuthority.ingredients}, ${sql(product.ingredients.observedAt)}, ${sql(now)}) ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id, raw_text = excluded.raw_text, language = excluded.language, status = excluded.status, confidence = excluded.confidence, authority = excluded.authority, observed_at = excluded.observed_at, updated_at = excluded.updated_at WHERE excluded.authority > ingredient_statements.authority OR (excluded.authority = ingredient_statements.authority AND excluded.observed_at > ingredient_statements.observed_at);`,
      );
    }

    for (const nutrient of product.nutrients) {
      const nutrientId = stableId("nut", `${sourceRecordId}:${nutrient.code}:${nutrient.basis}:${nutrient.preparationState}`);
      const reviewedCoreGuard = nutritionDecisionWhere && REVIEWED_NUTRIENT_CODES.has(nutrient.code)
        ? `NOT EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${nutritionDecisionWhere} AND d.decision = 'verify')`
        : "1 = 1";
      await write(
        output,
        `INSERT INTO nutrient_values (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at) SELECT ${sql(nutrientId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(nutrient.code)}, ${nutrient.quantity}, ${sql(nutrient.unit)}, ${sql(nutrient.basis)}, ${sql(nutrient.preparationState)}, ${sql(product.nutrition.status === "verified" ? "verified" : "unverified")}, ${sql(product.observedAt)} WHERE ${reviewedCoreGuard} ON CONFLICT(source_record_id, nutrient_code, basis, preparation_state) DO UPDATE SET product_id = excluded.product_id, quantity = excluded.quantity, unit = excluded.unit, status = excluded.status, observed_at = excluded.observed_at;`,
      );
    }

    const flattenedIngredients = flattenIngredients(product.ingredients.normalized, null, sourceRecordId, productId);
    for (const item of flattenedIngredients) {
      const percentage = item.ingredient.percentage !== null && item.ingredient.percentage >= 0 && item.ingredient.percentage <= 100
        ? item.ingredient.percentage
        : null;
      await write(
        output,
        `INSERT INTO product_ingredients (id, product_id, source_record_id, parent_id, position, raw_text, normalized_name, percentage, resolved) VALUES (${sql(item.id)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(item.parentId)}, ${item.ingredient.position}, ${sql(item.ingredient.raw)}, ${sql(item.ingredient.normalizedName)}, ${sql(percentage)}, ${sql(item.ingredient.normalizedName !== null)}) ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id, raw_text = excluded.raw_text, normalized_name = excluded.normalized_name, percentage = excluded.percentage, resolved = excluded.resolved;`,
      );
      if (item.ingredient.percentage !== percentage) {
        const reviewId = stableId("rev", `${sourceRecordId}:invalid_ingredient_percentage:${item.id}`);
        await write(
          output,
          `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) VALUES (${sql(reviewId)}, 'ingredient_conflict', 50, 'open', ${sql(sourceRecordId)}, ${productIdSql}, '[]', ${json({ code: "invalid_ingredient_percentage", raw: item.ingredient.raw, percentage: item.ingredient.percentage })}, ${sql(now)});`,
        );
      }
    }
    for (const allergen of product.ingredients.allergens) {
      await write(
        output,
        `INSERT OR IGNORE INTO product_allergens (product_id, name, declaration, source_record_id) VALUES (${productIdSql}, ${sql(allergen.name)}, ${sql(allergen.declaration)}, ${sql(sourceRecordId)});`,
      );
    }
    for (const additive of product.ingredients.additives) {
      await write(
        output,
        `INSERT OR IGNORE INTO product_additives (product_id, identifier, source_record_id, confidence) VALUES (${productIdSql}, ${sql(additive)}, ${sql(sourceRecordId)}, ${sql(product.ingredients.confidence)});`,
      );
    }
    for (const offer of product.offers) {
      const offerId = stableId("off", `${offer.retailer}:${offer.retailerListingId}:${offer.pincode ?? ""}:${offer.seller ?? ""}:${offer.observedAt}`);
      await write(
        output,
        `INSERT INTO offers (id, product_id, source_record_id, retailer, retailer_listing_id, pincode, seller, mrp, selling_price, available, url, observed_at) VALUES (${sql(offerId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(offer.retailer)}, ${sql(offer.retailerListingId)}, ${sql(offer.pincode)}, ${sql(offer.seller)}, ${sql(offer.mrp)}, ${offer.sellingPrice}, ${sql(offer.available)}, ${sql(offer.url)}, ${sql(offer.observedAt)}) ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id, source_record_id = excluded.source_record_id, mrp = excluded.mrp, selling_price = excluded.selling_price, available = excluded.available, url = excluded.url;`,
      );
    }
    for (const rating of product.ratings) {
      const ratingId = stableId("rat", `${rating.retailer}:${rating.retailerListingId}:${rating.observedAt}`);
      await write(
        output,
        `INSERT INTO ratings (id, product_id, source_record_id, retailer, retailer_listing_id, stars, rating_count, review_count, observed_at) VALUES (${sql(ratingId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(rating.retailer)}, ${sql(rating.retailerListingId)}, ${rating.stars}, ${rating.ratingCount}, ${sql(rating.reviewCount)}, ${sql(rating.observedAt)}) ON CONFLICT(retailer, retailer_listing_id, observed_at) DO UPDATE SET product_id = excluded.product_id, source_record_id = excluded.source_record_id, stars = excluded.stars, rating_count = excluded.rating_count, review_count = excluded.review_count;`,
      );
    }

    const observations: Array<[string, unknown, unknown, number]> = [
      ["identity.brand", product.rawEvidence.brands ?? product.brand, product.brand, product.sourceAuthority.identity],
      ["identity.name", product.rawEvidence.product_name ?? product.name, product.name, product.sourceAuthority.identity],
      ["identity.gtin", product.gtinRaw, product.gtin, product.sourceAuthority.identity],
      ["nutrition.protein_grams_per_100g", product.rawEvidence["proteins_100g"], product.nutrition.per100g.proteinGrams, product.sourceAuthority.nutrition],
      ["nutrition.calories_per_100g", product.rawEvidence["energy-kcal_100g"], product.nutrition.per100g.calories, product.sourceAuthority.nutrition],
      ["ingredients.raw", product.ingredients.raw, product.ingredients.raw, product.sourceAuthority.ingredients],
    ];
    for (const [field, raw, normalized, authority] of observations) {
      if (normalized === null || normalized === undefined) continue;
      const valueHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      const observationId = stableId("obs", `${sourceRecordId}:${field}:${valueHash}`);
      await write(
        output,
        `INSERT INTO field_observations (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json, confidence, authority, observed_at, evidence_url, selected, value_hash) VALUES (${sql(observationId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(field)}, ${json(raw)}, ${json(normalized)}, ${sql(field.startsWith("identity") ? "medium" : product.nutrition.confidence)}, ${authority}, ${sql(product.observedAt)}, ${sql(product.sourceUrl)}, 0, ${sql(valueHash)}) ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET product_id = excluded.product_id, observed_at = excluded.observed_at, evidence_url = excluded.evidence_url;`,
      );
      await write(output, `UPDATE field_observations SET selected = 0 WHERE product_id = ${productIdSql} AND field_path = ${sql(field)};`);
      await write(output, `UPDATE field_observations SET selected = 1 WHERE id = (SELECT id FROM field_observations WHERE product_id = ${productIdSql} AND field_path = ${sql(field)} ORDER BY authority DESC, observed_at DESC, id LIMIT 1);`);
    }
    for (const cleanup of deferredNutritionDriftCleanup) await write(output, cleanup);

    for (const issue of product.validationIssues) {
      const isIngredientCandidate = issue.code === "robotoff_ingredient_candidate" && ingredientCandidate !== null;
      const type = issue.code === "invalid_gtin"
        ? "invalid_gtin"
        : issue.code.startsWith("invalid_ingredient") || isIngredientCandidate
          ? "ingredient_conflict"
          : "nutrition_validation";
      const reviewIdentity = issue.code === "robotoff_nutrition_candidate" && nutritionCandidate
        ? `${sourceRecordId}:${issue.code}:${issue.field}:${product.contentHash}:${nutritionCandidate.candidateHash}`
        : isIngredientCandidate
          ? `${sourceRecordId}:${issue.code}:${issue.field}:${product.contentHash}:${ingredientCandidate.candidateHash}`
        : `${sourceRecordId}:${issue.code}:${issue.field}`;
      const reviewId = stableId("rev", reviewIdentity);
      const matchingDecisionWhere = issue.code === "robotoff_nutrition_candidate"
        ? nutritionDecisionWhere
        : isIngredientCandidate
          ? ingredientDecisionWhere
          : null;
      const issueDetails = record(issue.details);
      const issueAttemptId = typeof issueDetails?.extractionAttemptId === "string" ? issueDetails.extractionAttemptId : null;
      const issueLabelAssetId = typeof issueDetails?.labelAssetId === "string" ? issueDetails.labelAssetId : null;
      const currentExtractionReviewGuard = extraction && (issue.code === "robotoff_nutrition_candidate" || isIngredientCandidate)
        ? `EXISTS (SELECT 1 FROM extraction_attempts exact_attempt
            JOIN extraction_attempt_labels exact_label
              ON exact_label.attempt_id = exact_attempt.id AND exact_label.label_asset_id = ${sql(issueLabelAssetId)}
            WHERE exact_attempt.id = ${sql(issueAttemptId)} AND exact_attempt.is_current = 1
              AND exact_attempt.product_id = ${productIdSql}
              AND exact_attempt.field_family = ${sql(extraction.run.fieldFamily)})`
        : "1 = 1";
      const matchingDecisionAbsent = `${matchingDecisionWhere
        ? `NOT EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${matchingDecisionWhere})`
        : "1 = 1"} AND ${currentExtractionReviewGuard}`;
      const reviewEvidence = issue.code === "robotoff_nutrition_candidate" && nutritionCandidate
        ? { ...issue, details: { ...issue.details, candidateHash: nutritionCandidate.candidateHash } }
        : isIngredientCandidate
          ? { ...issue, details: { ...issue.details, candidateHash: ingredientCandidate.candidateHash } }
        : issue;
      await write(
        output,
        `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) SELECT ${sql(reviewId)}, ${sql(type)}, ${issue.severity === "error" ? 80 : 50}, 'open', ${sql(sourceRecordId)}, ${productIdSql}, '[]', ${json(reviewEvidence)}, ${sql(now)} WHERE ${matchingDecisionAbsent};`,
      );
      if (issue.code === "robotoff_nutrition_candidate" && nutritionDecisionWhere) {
        await write(
          output,
          `UPDATE review_items SET type = ${sql(type)}, priority = ${issue.severity === "error" ? 80 : 50}, status = 'open', source_record_id = ${sql(sourceRecordId)}, product_id = ${productIdSql}, candidate_product_ids_json = '[]', evidence_json = ${json(reviewEvidence)}, decision = NULL, decision_rationale = NULL, decision_evidence_url = NULL, decided_by = NULL, resolved_at = NULL WHERE id = ${sql(reviewId)} AND status = 'resolved' AND decision = 'redundant_nutrition' AND ${matchingDecisionAbsent};`,
        );
        await write(
          output,
          `UPDATE review_items SET status = 'resolved', decision = CASE (SELECT d.decision FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1) WHEN 'verify' THEN 'verify_nutrition' WHEN 'redundant' THEN 'redundant_nutrition' ELSE 'reject_nutrition' END, decision_rationale = (SELECT d.rationale FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), decision_evidence_url = (SELECT d.evidence_url FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), decided_by = (SELECT d.decided_by FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), resolved_at = (SELECT d.decided_at FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1) WHERE id = ${sql(reviewId)} AND status = 'open' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${nutritionDecisionWhere});`,
        );
      }
      if (isIngredientCandidate && ingredientDecisionWhere) {
        await write(
          output,
          `UPDATE review_items SET status = 'resolved', decision = CASE (SELECT d.decision FROM evidence_decisions d WHERE ${ingredientDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1) WHEN 'verify' THEN 'verify_ingredients' ELSE 'reject_ingredients' END, decision_rationale = (SELECT d.rationale FROM evidence_decisions d WHERE ${ingredientDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), decision_evidence_url = (SELECT d.evidence_url FROM evidence_decisions d WHERE ${ingredientDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), decided_by = (SELECT d.decided_by FROM evidence_decisions d WHERE ${ingredientDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), resolved_at = (SELECT d.decided_at FROM evidence_decisions d WHERE ${ingredientDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1) WHERE id = ${sql(reviewId)} AND status = 'open' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${ingredientDecisionWhere});`,
        );
      }
    }
    if (product.source !== "open_food_facts_robotoff_ingredients"
      && product.classification.marketed
      && product.nutrition.status !== "verified") {
      const reviewId = stableId("rev", `${sourceRecordId}:coverage:verified_nutrition`);
      await write(
        output,
        `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) VALUES (${sql(reviewId)}, 'coverage_gap', 70, 'open', ${sql(sourceRecordId)}, ${productIdSql}, '[]', ${json({ gap: "verified_nutrition", marketedReasons: product.classification.marketedReasons })}, ${sql(now)});`,
      );
    }
    products += 1;
  }
  for (const review of pendingIdentityReviews) {
    const candidateFilter = `p.is_active = 1 AND p.id <> ${sql(review.proposedProductId)} AND (p.gtin IS NOT NULL OR p.net_quantity_grams IS NOT NULL OR p.flavour_normalized IS NOT NULL) AND p.brand_normalized = ${sql(review.brand)} AND (p.name_normalized = ${sql(review.name)} OR substr(p.name_normalized, 1, ${review.name.length + 1}) = ${sql(`${review.name} `)} OR substr(${sql(review.name)}, 1, length(p.name_normalized) + 1) = p.name_normalized || ' ')`;
    const candidateRows = `SELECT p.id AS candidate_id, CASE WHEN p.name_normalized = ${sql(review.name)} THEN 92 ELSE 78 END AS score FROM products p WHERE ${candidateFilter} ORDER BY score DESC, p.id LIMIT 8`;
    const decisionAbsent = `NOT EXISTS (SELECT 1 FROM identity_decisions d WHERE d.source_id = ${sql(review.source)} AND d.source_record_key = ${sql(review.sourceRecordKey)} AND d.identity_hash = ${sql(review.identityHash)} AND d.active = 1)`;
    await write(
      output,
      `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) SELECT ${sql(review.reviewId)}, 'identity', 80, 'open', ${sql(review.sourceRecordId)}, ${sql(review.proposedProductId)}, json_group_array(candidate_id), json_object('rule', 'brand_name_similarity', 'identityHash', ${sql(review.identityHash)}, 'incoming', json(${json({ brand: review.brand, name: review.name, flavour: review.flavour, netQuantityGrams: review.netQuantityGrams })}), 'candidateScores', json_group_array(json_object('productId', candidate_id, 'score', score))), ${sql(review.createdAt)} FROM (${candidateRows}) WHERE ${decisionAbsent} HAVING COUNT(*) > 0;`,
    );
    await write(
      output,
      `UPDATE products SET is_active = 0 WHERE id = ${sql(review.proposedProductId)} AND ${decisionAbsent} AND EXISTS (SELECT 1 FROM review_items r WHERE r.id = ${sql(review.reviewId)} AND r.status = 'open');`,
    );
  }
  await write(output, `UPDATE ingestion_runs SET status = 'completed', completed_at = ${sql(manifest.completedAt)} WHERE id = ${sql(runId)};`);
  if (input.includeTransaction !== false) await write(output, "COMMIT;");
  await new Promise<void>((resolve, reject) => {
    output.once("error", reject);
    output.end(resolve);
  });
  return { products, outputPath: input.outputPath, runId };
}
