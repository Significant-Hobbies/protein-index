import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  canonicalJson,
  canonicalNutritionCandidate,
  nutritionDecisionCandidate,
  nutritionCandidateHash,
  type NutritionCandidate,
} from "../shared/evidence-decisions";
import {
  canonicalIngredientCandidate,
  ingredientCandidateHash,
  type IngredientCandidate,
} from "../shared/ingredient-evidence";
import { normalizeGtin } from "../shared/gtin";
import type { ExtractionFieldFamily } from "../shared/extraction-outcomes";
import type { StagedProduct } from "../shared/types";
import {
  validateRobotoffNutritionArtifact,
  type RobotoffNutritionArtifact,
} from "./adapters/robotoff-api";
import {
  validateRobotoffIngredientArtifact,
  type RobotoffIngredientArtifact,
} from "./adapters/robotoff-ingredients-api";
import { stagedProductId, stagedSourceRecordId } from "./adapters/label-image";
import {
  readReviewDecisionBundle,
  type ReviewDecisionBundle,
  type ReviewEvidenceDecision,
} from "./review-bundles";

export const DECISION_DRIFT_CLASSIFICATIONS = [
  "candidate_key_active_state_ambiguous",
  "unsupported_source_or_family",
  "artifact_candidate_missing",
  "candidate_drift",
  "identity_drift",
  "source_revision_drift_candidate_unchanged",
  "exact_proof_incomplete_or_inconsistent",
  "linked_proof_drift",
  "requires_selected_projection_state",
  "legacy_proof_match_requires_new_decision",
  "exact_link_valid",
] as const;

export type DecisionDriftClassification = (typeof DECISION_DRIFT_CLASSIFICATIONS)[number];

export interface DecisionDriftAuditOptions {
  artifactDirectory: string;
  bundlesDirectory: string;
  bundleSetFile?: string;
}

export interface CurrentArtifactCandidate {
  fieldFamily: ExtractionFieldFamily;
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  sourceContentHash: string;
  productId: string;
  gtin: string | null;
  candidateHash: string;
  candidate: NutritionCandidate | IngredientCandidate;
  canonicalCandidate: string;
  evidenceUrl: string;
  extractionAttemptId: string;
  labelAssetId: string;
  labelContentSha256: string;
  proofValid: boolean;
  proofIssues: string[];
}

export interface DecisionDriftArtifactContext {
  fieldFamily: ExtractionFieldFamily;
  sourceId: string;
}

export interface DecisionDriftClassificationResult {
  classification: DecisionDriftClassification;
  current: CurrentArtifactCandidate | null;
  differences: string[];
}

export interface DecisionBundleProvenance {
  bundleId: string;
  directory: string;
  ledgerSha256: string;
}

export interface DecisionDriftConflict {
  code: "decision_id_payload_conflict";
  decisionId: string;
  canonicalPayloadHashes: string[];
  bundles: DecisionBundleProvenance[];
  message: string;
}

export interface DecisionDriftFinding {
  decisionId: string;
  fieldFamily: ExtractionFieldFamily;
  decision: ReviewEvidenceDecision["decision"];
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  sourceContentHash: string;
  productId: string;
  candidateHash: string;
  evidenceUrl: string;
  extractionAttemptId: string | null;
  labelAssetId: string | null;
  classification: DecisionDriftClassification;
  differences: string[];
  current: null | {
    sourceRecordId: string;
    sourceContentHash: string;
    productId: string;
    gtin: string | null;
    candidateHash: string;
    evidenceUrl: string;
    extractionAttemptId: string;
    labelAssetId: string;
    labelContentSha256: string;
    proofValid: boolean;
    proofIssues: string[];
  };
  bundles: DecisionBundleProvenance[];
}

export interface UnreviewedCurrentCandidate {
  classification: "unreviewed_current_candidate";
  fieldFamily: ExtractionFieldFamily;
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  sourceContentHash: string;
  productId: string;
  gtin: string | null;
  candidateHash: string;
  evidenceUrl: string;
  extractionAttemptId: string;
  labelAssetId: string;
  labelContentSha256: string;
}

export interface DecisionDriftAuditReport {
  schemaVersion: 1;
  artifact: {
    directory: string;
    fieldFamily: ExtractionFieldFamily;
    sourceId: string;
    adapterVersion: string;
    inputHash: string | null;
    extractionRunId: string;
    parentSourceRunId: string;
    sourceComplete: true;
    candidateCount: number;
  };
  inputs: {
    bundleSetFile: string | null;
    bundleSetSha256: string | null;
    bundleIds: string[];
    bundleCount: number;
    decisionRecords: number;
    uniqueDecisions: number;
    duplicateDecisionRecords: number;
    currentCandidates: number;
  };
  classificationCounts: Record<DecisionDriftClassification, number>;
  conflicts: DecisionDriftConflict[];
  findings: DecisionDriftFinding[];
  unreviewedCurrentCandidates: UnreviewedCurrentCandidate[];
  hasHardFailure: boolean;
}

interface DecisionOccurrence {
  decision: ReviewEvidenceDecision;
  provenance: DecisionBundleProvenance;
}

interface UniqueDecision {
  decision: ReviewEvidenceDecision;
  provenance: DecisionBundleProvenance[];
}

type ValidatedArtifact =
  | { fieldFamily: "nutrition"; sourceId: "open_food_facts_robotoff"; artifact: RobotoffNutritionArtifact }
  | { fieldFamily: "ingredients"; sourceId: "open_food_facts_robotoff_ingredients"; artifact: RobotoffIngredientArtifact };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateKey(value: Pick<ReviewEvidenceDecision, "sourceId" | "sourceRecordKey" | "candidateHash" | "fieldFamily">): string {
  return [value.sourceId, value.sourceRecordKey, value.candidateHash, value.fieldFamily].join("\u0000");
}

function sourceKey(value: Pick<ReviewEvidenceDecision, "sourceId" | "sourceRecordKey" | "fieldFamily">): string {
  return [value.sourceId, value.sourceRecordKey, value.fieldFamily].join("\u0000");
}

function decisionCandidate(decision: ReviewEvidenceDecision): NutritionCandidate | IngredientCandidate {
  return decision.fieldFamily === "nutrition"
    ? nutritionDecisionCandidate(decision.payload)
    : decision.payload.candidate;
}

function candidateBarcode(candidate: NutritionCandidate | IngredientCandidate): string | null {
  return normalizeGtin(candidate.barcode);
}

function canonicalCandidate(candidate: NutritionCandidate | IngredientCandidate, family: ExtractionFieldFamily): string {
  return family === "nutrition"
    ? canonicalJson(canonicalNutritionCandidate(candidate as NutritionCandidate))
    : canonicalJson(canonicalIngredientCandidate(candidate as IngredientCandidate));
}

async function recomputeCandidateHash(candidate: NutritionCandidate | IngredientCandidate, family: ExtractionFieldFamily): Promise<string> {
  return family === "nutrition"
    ? nutritionCandidateHash(candidate as NutritionCandidate)
    : ingredientCandidateHash(candidate as IngredientCandidate);
}

function emptyClassificationCounts(): Record<DecisionDriftClassification, number> {
  return Object.fromEntries(
    DECISION_DRIFT_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as Record<DecisionDriftClassification, number>;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareProvenance(left: DecisionBundleProvenance, right: DecisionBundleProvenance): number {
  return left.bundleId.localeCompare(right.bundleId) || left.directory.localeCompare(right.directory);
}

function deduplicateOccurrences(occurrences: DecisionOccurrence[]): {
  decisions: UniqueDecision[];
  duplicateCount: number;
  conflicts: DecisionDriftConflict[];
} {
  const byId = new Map<string, Map<string, DecisionOccurrence[]>>();
  for (const occurrence of occurrences) {
    const canonical = canonicalJson(occurrence.decision);
    const payloads = byId.get(occurrence.decision.id) ?? new Map<string, DecisionOccurrence[]>();
    const rows = payloads.get(canonical) ?? [];
    rows.push(occurrence);
    payloads.set(canonical, rows);
    byId.set(occurrence.decision.id, payloads);
  }

  const decisions: UniqueDecision[] = [];
  const conflicts: DecisionDriftConflict[] = [];
  let duplicateCount = 0;
  for (const [decisionId, payloads] of [...byId].sort(([left], [right]) => left.localeCompare(right))) {
    const rows = [...payloads.values()].flat();
    if (payloads.size > 1) {
      conflicts.push({
        code: "decision_id_payload_conflict",
        decisionId,
        canonicalPayloadHashes: [...payloads.keys()].map(sha256Text).sort(),
        bundles: rows.map(({ provenance }) => provenance).sort(compareProvenance),
        message: `Decision ${decisionId} has conflicting canonical payloads.`,
      });
      continue;
    }
    duplicateCount += rows.length - 1;
    const first = rows[0];
    if (!first) continue;
    decisions.push({
      decision: first.decision,
      provenance: rows.map(({ provenance }) => provenance).sort(compareProvenance),
    });
  }
  return { decisions, duplicateCount, conflicts };
}

export function deduplicateReviewDecisions(decisions: ReviewEvidenceDecision[]): {
  decisions: ReviewEvidenceDecision[];
  duplicateCount: number;
} {
  const occurrences = decisions.map((decision, index) => ({
    decision,
    provenance: { bundleId: `input-${index}`, directory: "", ledgerSha256: sha256Text(canonicalJson(decision)) },
  }));
  const result = deduplicateOccurrences(occurrences);
  if (result.conflicts.length > 0) throw new Error(result.conflicts[0]?.message ?? "Decision identifiers conflict");
  return { decisions: result.decisions.map(({ decision }) => decision), duplicateCount: result.duplicateCount };
}

async function validateSelectedArtifact(directory: string): Promise<ValidatedArtifact> {
  const manifest = record(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
  if (manifest?.source === "open_food_facts_robotoff") {
    return { fieldFamily: "nutrition", sourceId: "open_food_facts_robotoff", artifact: await validateRobotoffNutritionArtifact(directory) };
  }
  if (manifest?.source === "open_food_facts_robotoff_ingredients") {
    return {
      fieldFamily: "ingredients",
      sourceId: "open_food_facts_robotoff_ingredients",
      artifact: await validateRobotoffIngredientArtifact(directory),
    };
  }
  throw new Error("Decision drift audit requires a supported nutrition or ingredient extraction artifact");
}

export async function readActiveReviewBundleSet(
  path: string,
  fieldFamily: ExtractionFieldFamily,
): Promise<{ bundleIds: string[]; sha256: string }> {
  const text = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Active review bundle set is not valid JSON");
  }
  const input = record(parsed);
  const families = record(input?.families);
  if (!input || input.schemaVersion !== 1 || !families
    || Object.keys(input).sort().join("\0") !== ["families", "schemaVersion"].join("\0")
    || Object.keys(families).sort().join("\0") !== ["ingredients", "nutrition"].join("\0")) {
    throw new Error("Active review bundle set has an unsupported shape");
  }
  const selected = families[fieldFamily];
  if (!Array.isArray(selected) || selected.length === 0
    || !selected.every((value) => typeof value === "string" && /^review-[a-f0-9]{20}$/.test(value))) {
    throw new Error(`Active review bundle set has no valid ${fieldFamily} selection`);
  }
  const bundleIds = [...selected] as string[];
  if (new Set(bundleIds).size !== bundleIds.length) throw new Error("Active review bundle set repeats a bundle ID");
  if (JSON.stringify(bundleIds) !== JSON.stringify([...bundleIds].sort())) {
    throw new Error("Active review bundle set must be sorted deterministically");
  }
  return { bundleIds, sha256: createHash("sha256").update(text).digest("hex") };
}

async function discoverReviewBundles(
  directory: string,
  fieldFamily: ExtractionFieldFamily,
  selectedBundleIds?: readonly string[],
): Promise<ReviewDecisionBundle[]> {
  if (selectedBundleIds) {
    const bundles: ReviewDecisionBundle[] = [];
    for (const bundleId of selectedBundleIds) {
      const bundle = await readReviewDecisionBundle(join(directory, bundleId));
      if (bundle.manifest.bundleId !== bundleId || bundle.decisions.some((decision) => decision.fieldFamily !== fieldFamily)) {
        throw new Error(`Active review bundle ${bundleId} is not a pure ${fieldFamily} bundle`);
      }
      bundles.push(bundle);
    }
    return bundles;
  }
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const bundles: ReviewDecisionBundle[] = [];
  for (const entry of entries) {
    const bundleDirectory = join(directory, entry.name);
    try {
      await access(join(bundleDirectory, "manifest.json"));
    } catch {
      continue;
    }
    bundles.push(await readReviewDecisionBundle(bundleDirectory));
  }
  return bundles;
}

async function buildCurrentCandidates(validated: ValidatedArtifact): Promise<CurrentArtifactCandidate[]> {
  const { fieldFamily, sourceId, artifact } = validated;
  const attempts = new Map(artifact.extractionAttempts.map((attempt) => [attempt.id, attempt]));
  const assets = new Map(artifact.labelAssets.map((asset) => [asset.id, asset]));
  const labels = new Map<string, typeof artifact.extractionAttemptLabels>();
  for (const label of artifact.extractionAttemptLabels) {
    const key = `${label.attemptId}\u0000${label.labelAssetId}`;
    const rows = labels.get(key) ?? [];
    rows.push(label);
    labels.set(key, rows);
  }

  const candidates: CurrentArtifactCandidate[] = [];
  for (const product of artifact.staged) {
    const raw = record(product.rawEvidence);
    const rawCandidate = record(raw?.candidate);
    const storedCandidateHash = typeof raw?.candidateHash === "string" ? raw.candidateHash : null;
    if (!rawCandidate || !storedCandidateHash) continue;
    const candidate = rawCandidate as unknown as NutritionCandidate | IngredientCandidate;
    const extractionAttemptId = typeof raw?.extractionAttemptId === "string" ? raw.extractionAttemptId : "";
    const labelAssetId = typeof raw?.labelAssetId === "string" ? raw.labelAssetId : "";
    const labelContentSha256 = typeof raw?.labelContentSha256 === "string" ? raw.labelContentSha256 : "";
    const attempt = attempts.get(extractionAttemptId);
    const asset = assets.get(labelAssetId);
    const matchingLabels = labels.get(`${extractionAttemptId}\u0000${labelAssetId}`) ?? [];
    const proofIssues: string[] = [];
    const computedHash = await recomputeCandidateHash(candidate, fieldFamily);
    const computedRawHash = sha256Text(JSON.stringify(product.rawEvidence));
    const productId = stagedProductId(product);
    const sourceRecordId = stagedSourceRecordId(product);
    const barcode = candidateBarcode(candidate);
    const expectedSourceKey = fieldFamily === "nutrition"
      ? `${barcode ?? ""}:${candidate.predictionId}`
      : `${barcode ?? ""}:${candidate.predictionId}:${(candidate as IngredientCandidate).entityIndex}`;
    if (computedHash !== storedCandidateHash) proofIssues.push("candidate_hash_mismatch");
    if (computedRawHash !== product.contentHash) proofIssues.push("raw_evidence_hash_mismatch");
    if (product.source !== sourceId) proofIssues.push("candidate_source_mismatch");
    if (product.sourceRecordId !== expectedSourceKey) proofIssues.push("source_record_key_mismatch");
    if (!barcode || barcode !== normalizeGtin(product.gtin)) proofIssues.push("candidate_gtin_mismatch");
    const imageUrl = candidate.imageUrl;
    const productImageUrl = fieldFamily === "nutrition" ? product.nutritionImageUrl : product.ingredientImageUrl;
    if (productImageUrl !== imageUrl) proofIssues.push("candidate_product_image_mismatch");
    if (!attempt || attempt.isCurrent !== true || attempt.status !== "candidate" || attempt.fieldFamily !== fieldFamily
      || attempt.productId !== productId) proofIssues.push("current_attempt_binding_mismatch");
    if (!asset || asset.fieldFamily !== fieldFamily || asset.productId !== productId
      || asset.requestedUrl !== imageUrl || asset.contentSha256 !== labelContentSha256) {
      proofIssues.push("label_asset_binding_mismatch");
    }
    if (attempt && asset && (asset.subjectSourceRecordId !== attempt.subjectSourceRecordId
      || asset.subjectSourceContentHash !== attempt.subjectSourceContentHash)) {
      proofIssues.push("attempt_label_subject_mismatch");
    }
    if (!matchingLabels.some((label) => label.outcome === "candidate" && label.candidateHashes.includes(storedCandidateHash))) {
      proofIssues.push("attempt_label_candidate_missing");
    }
    const issueCode = fieldFamily === "nutrition"
      ? new Set(["robotoff_nutrition_candidate", "robotoff_image_conflict"])
      : new Set(["robotoff_ingredient_candidate"]);
    const issueMatches = product.validationIssues.some((issue) => {
      const details = record(issue.details);
      const issueCandidate = record(details?.candidate);
      return issueCode.has(issue.code) && issue.field === fieldFamily
        && details?.candidateHash === storedCandidateHash
        && details?.extractionAttemptId === extractionAttemptId
        && details?.labelAssetId === labelAssetId
        && details?.labelContentSha256 === labelContentSha256
        && issueCandidate !== null
        && canonicalCandidate(issueCandidate as unknown as NutritionCandidate | IngredientCandidate, fieldFamily)
          === canonicalCandidate(candidate, fieldFamily);
    });
    if (!issueMatches) proofIssues.push("review_issue_binding_mismatch");
    candidates.push({
      fieldFamily,
      sourceId,
      sourceRecordKey: product.sourceRecordId,
      sourceRecordId,
      sourceContentHash: product.contentHash,
      productId,
      gtin: normalizeGtin(product.gtin),
      candidateHash: storedCandidateHash,
      candidate,
      canonicalCandidate: canonicalCandidate(candidate, fieldFamily),
      evidenceUrl: imageUrl,
      extractionAttemptId,
      labelAssetId,
      labelContentSha256,
      proofValid: proofIssues.length === 0,
      proofIssues: sortedUnique(proofIssues),
    });
  }
  return candidates.sort((left, right) => candidateKey(left).localeCompare(candidateKey(right)));
}

export async function classifyDecisionDrift(
  decision: ReviewEvidenceDecision,
  currentCandidates: CurrentArtifactCandidate[],
  artifact?: DecisionDriftArtifactContext,
): Promise<DecisionDriftClassificationResult> {
  const context = artifact ?? currentCandidates[0] ?? {
    fieldFamily: decision.fieldFamily,
    sourceId: decision.fieldFamily === "nutrition"
      ? "open_food_facts_robotoff"
      : "open_food_facts_robotoff_ingredients",
  };
  if (decision.fieldFamily !== context.fieldFamily || decision.sourceId !== context.sourceId) {
    return { classification: "unsupported_source_or_family", current: null, differences: ["artifact_source_or_family"] };
  }
  const atSource = currentCandidates.filter((candidate) => sourceKey(candidate) === sourceKey(decision));
  if (atSource.length === 0) {
    return { classification: "artifact_candidate_missing", current: null, differences: ["source_record_key"] };
  }
  const current = atSource.find((candidate) => candidate.candidateHash === decision.candidateHash) ?? null;
  if (!current) {
    return {
      classification: "candidate_drift",
      current: atSource[0] ?? null,
      differences: ["candidate_hash"],
    };
  }
  const expectedCandidate = decisionCandidate(decision);
  if (await recomputeCandidateHash(expectedCandidate, decision.fieldFamily) !== decision.candidateHash
    || canonicalCandidate(expectedCandidate, decision.fieldFamily) !== current.canonicalCandidate) {
    return { classification: "candidate_drift", current, differences: ["canonical_candidate"] };
  }
  const identityDifferences = [
    decision.sourceRecordId === current.sourceRecordId ? null : "source_record_id",
    decision.productId === current.productId ? null : "product_id",
    candidateBarcode(expectedCandidate) === current.gtin ? null : "gtin",
  ].filter((value): value is string => value !== null);
  if (identityDifferences.length > 0) return { classification: "identity_drift", current, differences: identityDifferences };
  if (decision.sourceContentHash !== current.sourceContentHash) {
    return {
      classification: "source_revision_drift_candidate_unchanged",
      current,
      differences: ["source_content_hash"],
    };
  }
  if (!current.proofValid) {
    return {
      classification: "exact_proof_incomplete_or_inconsistent",
      current,
      differences: current.proofIssues,
    };
  }
  const linkedAttempt = decision.extractionAttemptId ?? null;
  const linkedAsset = decision.labelAssetId ?? null;
  if (linkedAttempt !== null || linkedAsset !== null) {
    const differences = [
      linkedAttempt === current.extractionAttemptId ? null : "extraction_attempt_id",
      linkedAsset === current.labelAssetId ? null : "label_asset_id",
      decision.evidenceUrl === current.evidenceUrl ? null : "evidence_url",
    ].filter((value): value is string => value !== null);
    if (differences.length > 0) return { classification: "linked_proof_drift", current, differences };
  }
  if (decision.decision === "redundant") {
    return { classification: "requires_selected_projection_state", current, differences: ["selected_projection_state"] };
  }
  if (linkedAttempt === null && linkedAsset === null) {
    return { classification: "legacy_proof_match_requires_new_decision", current, differences: ["immutable_extraction_link"] };
  }
  return { classification: "exact_link_valid", current, differences: [] };
}

export function findAmbiguousDecisionIds(
  decisions: ReviewEvidenceDecision[],
  currentCandidates: CurrentArtifactCandidate[],
  artifact: DecisionDriftArtifactContext,
): Map<string, string[]> {
  const decisionIdsByCandidate = new Map<string, string[]>();
  for (const decision of decisions) {
    const key = candidateKey(decision);
    const ids = decisionIdsByCandidate.get(key) ?? [];
    ids.push(decision.id);
    decisionIdsByCandidate.set(key, ids);
  }
  const ambiguousIds = new Map<string, string[]>();
  for (const ids of decisionIdsByCandidate.values()) {
    if (new Set(ids).size > 1) {
      for (const id of ids) ambiguousIds.set(id, ["multiple_decision_ids_for_candidate_key"]);
    }
  }

  const currentCandidateKeys = new Set(currentCandidates.map(candidateKey));
  const currentVerifiesByProduct = new Map<string, string[]>();
  for (const decision of decisions) {
    if (decision.decision !== "verify" || decision.fieldFamily !== artifact.fieldFamily
      || decision.sourceId !== artifact.sourceId || !currentCandidateKeys.has(candidateKey(decision))) continue;
    const key = `${decision.fieldFamily}\u0000${decision.productId}`;
    const ids = currentVerifiesByProduct.get(key) ?? [];
    ids.push(decision.id);
    currentVerifiesByProduct.set(key, ids);
  }
  for (const ids of currentVerifiesByProduct.values()) {
    if (new Set(ids).size > 1) {
      for (const id of ids) {
        ambiguousIds.set(id, sortedUnique([
          ...(ambiguousIds.get(id) ?? []),
          "multiple_current_verifies_for_product",
        ]));
      }
    }
  }
  return new Map([...ambiguousIds].sort(([left], [right]) => left.localeCompare(right)));
}

function finding(
  unique: UniqueDecision,
  result: DecisionDriftClassificationResult,
): DecisionDriftFinding {
  const { decision, provenance } = unique;
  return {
    decisionId: decision.id,
    fieldFamily: decision.fieldFamily,
    decision: decision.decision,
    sourceId: decision.sourceId,
    sourceRecordKey: decision.sourceRecordKey,
    sourceRecordId: decision.sourceRecordId,
    sourceContentHash: decision.sourceContentHash,
    productId: decision.productId,
    candidateHash: decision.candidateHash,
    evidenceUrl: decision.evidenceUrl,
    extractionAttemptId: decision.extractionAttemptId ?? null,
    labelAssetId: decision.labelAssetId ?? null,
    classification: result.classification,
    differences: sortedUnique(result.differences),
    current: result.current ? {
      sourceRecordId: result.current.sourceRecordId,
      sourceContentHash: result.current.sourceContentHash,
      productId: result.current.productId,
      gtin: result.current.gtin,
      candidateHash: result.current.candidateHash,
      evidenceUrl: result.current.evidenceUrl,
      extractionAttemptId: result.current.extractionAttemptId,
      labelAssetId: result.current.labelAssetId,
      labelContentSha256: result.current.labelContentSha256,
      proofValid: result.current.proofValid,
      proofIssues: result.current.proofIssues,
    } : null,
    bundles: provenance,
  };
}

export async function auditDecisionDrift(options: DecisionDriftAuditOptions): Promise<DecisionDriftAuditReport> {
  const validated = await validateSelectedArtifact(options.artifactDirectory);
  const bundleSet = options.bundleSetFile
    ? await readActiveReviewBundleSet(options.bundleSetFile, validated.fieldFamily)
    : null;
  const bundles = await discoverReviewBundles(
    options.bundlesDirectory,
    validated.fieldFamily,
    bundleSet?.bundleIds,
  );
  const currentCandidates = await buildCurrentCandidates(validated);
  const occurrences = bundles.flatMap((bundle) => {
    const provenance: DecisionBundleProvenance = {
      bundleId: bundle.manifest.bundleId,
      directory: basename(bundle.directory),
      ledgerSha256: bundle.manifest.ledgerSha256,
    };
    return bundle.decisions.map((decision) => ({ decision, provenance }));
  });
  if (bundleSet) {
    const decisionIds = occurrences.map(({ decision }) => decision.id);
    const candidateKeys = occurrences.map(({ decision }) => candidateKey(decision));
    const sourceKeys = occurrences.map(({ decision }) => sourceKey(decision));
    const verifiedProducts = occurrences
      .filter(({ decision }) => decision.decision === "verify")
      .map(({ decision }) => `${decision.fieldFamily}\u0000${decision.productId}`);
    for (const [values, message] of [
      [decisionIds, "Active review bundle set repeats a decision ID"],
      [candidateKeys, "Active review bundle set repeats a candidate key"],
      [sourceKeys, "Active review bundle set repeats a source key"],
      [verifiedProducts, "Active review bundle set verifies one product more than once"],
    ] as const) {
      if (new Set(values).size !== values.length) throw new Error(message);
    }
  }
  const deduplicated = deduplicateOccurrences(occurrences);
  const reportBase = {
    schemaVersion: 1 as const,
    artifact: {
      directory: basename(options.artifactDirectory),
      fieldFamily: validated.fieldFamily,
      sourceId: validated.sourceId,
      adapterVersion: validated.artifact.manifest.adapterVersion,
      inputHash: validated.artifact.manifest.inputHash,
      extractionRunId: String(validated.artifact.report.extractionRunId),
      parentSourceRunId: String(validated.artifact.report.parentSourceRunId),
      sourceComplete: true as const,
      candidateCount: currentCandidates.length,
    },
    inputs: {
      bundleSetFile: options.bundleSetFile ? basename(options.bundleSetFile) : null,
      bundleSetSha256: bundleSet?.sha256 ?? null,
      bundleIds: bundles.map(({ manifest }) => manifest.bundleId),
      bundleCount: bundles.length,
      decisionRecords: occurrences.length,
      uniqueDecisions: deduplicated.decisions.length,
      duplicateDecisionRecords: deduplicated.duplicateCount,
      currentCandidates: currentCandidates.length,
    },
  };
  if (deduplicated.conflicts.length > 0) {
    return {
      ...reportBase,
      classificationCounts: emptyClassificationCounts(),
      conflicts: deduplicated.conflicts,
      findings: [],
      unreviewedCurrentCandidates: [],
      hasHardFailure: true,
    };
  }

  const ambiguousIds = findAmbiguousDecisionIds(
    deduplicated.decisions.map(({ decision }) => decision),
    currentCandidates,
    validated,
  );

  const findings: DecisionDriftFinding[] = [];
  const counts = emptyClassificationCounts();
  for (const unique of deduplicated.decisions) {
    const ambiguity = ambiguousIds.get(unique.decision.id);
    const result = ambiguity
      ? { classification: "candidate_key_active_state_ambiguous" as const, current: null, differences: ambiguity }
      : await classifyDecisionDrift(unique.decision, currentCandidates, validated);
    counts[result.classification] += 1;
    findings.push(finding(unique, result));
  }
  findings.sort((left, right) => left.decisionId.localeCompare(right.decisionId));

  const decidedCandidateKeys = new Set(deduplicated.decisions.map(({ decision }) => candidateKey(decision)));
  const unreviewedCurrentCandidates: UnreviewedCurrentCandidate[] = currentCandidates
    .filter((candidate) => !decidedCandidateKeys.has(candidateKey(candidate)))
    .map((candidate) => ({
      classification: "unreviewed_current_candidate",
      fieldFamily: candidate.fieldFamily,
      sourceId: candidate.sourceId,
      sourceRecordKey: candidate.sourceRecordKey,
      sourceRecordId: candidate.sourceRecordId,
      sourceContentHash: candidate.sourceContentHash,
      productId: candidate.productId,
      gtin: candidate.gtin,
      candidateHash: candidate.candidateHash,
      evidenceUrl: candidate.evidenceUrl,
      extractionAttemptId: candidate.extractionAttemptId,
      labelAssetId: candidate.labelAssetId,
      labelContentSha256: candidate.labelContentSha256,
    }));

  return {
    ...reportBase,
    classificationCounts: counts,
    conflicts: [],
    findings,
    unreviewedCurrentCandidates,
    hasHardFailure: counts.exact_proof_incomplete_or_inconsistent > 0 || counts.linked_proof_drift > 0,
  };
}
