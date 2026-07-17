import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  auditDecisionDrift,
  readActiveReviewBundleSet,
  type DecisionDriftAuditReport,
} from "./decision-drift-audit";
import {
  readReviewDecisionBundle,
  writeReviewDecisionBundle,
  type ReviewEvidenceDecision,
} from "./review-bundles";

export interface LiveNutritionSelectionRow {
  productId: string;
  sourceRecordId: string;
  labelVerifiedAt: string;
  decisionId: string;
  sourceRecordKey: string;
  sourceContentHash: string;
  candidateHash: string;
  decidedAt: string;
  active: 1;
  currentSourceContentHash: string;
}

export interface LiveNutritionSelectionReport {
  schemaVersion: 1;
  selectedState: {
    expected: number;
    actual: number;
    products: number;
    decisions: number;
    stateSha256: string;
    publishedBundleIds: string[];
  };
  artifact: DecisionDriftAuditReport["artifact"];
  classifications: DecisionDriftAuditReport["classificationCounts"];
  eligible: {
    expected: number;
    actual: number;
    bundleId: string;
    ledgerSha256: string;
  };
  exceptions: Array<{
    decisionId: string;
    productId: string;
    sourceRecordKey: string;
    candidateHash: string;
    classification: "candidate_drift" | "artifact_candidate_missing";
    differences: string[];
  }>;
  expandedActiveSet: {
    file: "active-bundles.expanded.json";
    sha256: string;
    nutritionDecisions: number;
    pendingDecisions: number;
    eligibleLiveDecisions: number;
  };
}

interface D1Result {
  success?: boolean;
  results?: Array<Record<string, unknown>>;
}

interface ActiveManifest {
  schemaVersion: 1;
  families: {
    nutrition: string[];
    ingredients: string[];
  };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Live nutrition selection ${field} is required`);
  return value;
}

function requiredHash(row: Record<string, unknown>, field: string): string {
  const value = requiredString(row, field);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Live nutrition selection ${field} must be a lowercase SHA-256`);
  return value;
}

function canonicalTimestamp(row: Record<string, unknown>, field: string): string {
  const value = requiredString(row, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`Live nutrition selection ${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function activeDecision(row: Record<string, unknown>): 1 {
  if (row.active !== 1) throw new Error("Live nutrition selection decision must be active");
  return 1;
}

function parseD1Rows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Live nutrition selection requires exactly one D1 result");
  const result = value[0] as D1Result | null;
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Live nutrition selection D1 query failed or is malformed");
  }
  return result.results;
}

export function liveNutritionSelectionQuery(): string {
  return `SELECT nf.product_id, nf.source_record_id, nf.label_verified_at,
    ed.id AS decision_id, ed.source_record_key, ed.source_content_hash,
    ed.candidate_hash, ed.decided_at, ed.active,
    sr.content_hash AS current_source_content_hash
  FROM nutrition_facts nf
  JOIN evidence_decisions ed
    ON ed.product_id = nf.product_id
   AND ed.source_record_id = nf.source_record_id
   AND ed.field_family = 'nutrition'
   AND ed.decision = 'verify'
   AND ed.decided_at = nf.label_verified_at
  JOIN source_records sr ON sr.id = nf.source_record_id
  WHERE nf.status = 'verified' AND nf.authority = 100
  ORDER BY nf.product_id, ed.id;`;
}

export function validateLiveNutritionSelection(input: {
  state: unknown;
  decisions: ReviewEvidenceDecision[];
  expectedCount: number;
}): { rows: LiveNutritionSelectionRow[]; decisions: ReviewEvidenceDecision[] } {
  if (!Number.isSafeInteger(input.expectedCount) || input.expectedCount <= 0) {
    throw new Error("Expected live nutrition selection count must be a positive integer");
  }
  const rows: LiveNutritionSelectionRow[] = parseD1Rows(input.state).map((row) => ({
    productId: requiredString(row, "product_id"),
    sourceRecordId: requiredString(row, "source_record_id"),
    labelVerifiedAt: canonicalTimestamp(row, "label_verified_at"),
    decisionId: requiredString(row, "decision_id"),
    sourceRecordKey: requiredString(row, "source_record_key"),
    sourceContentHash: requiredHash(row, "source_content_hash"),
    candidateHash: requiredHash(row, "candidate_hash"),
    decidedAt: canonicalTimestamp(row, "decided_at"),
    active: activeDecision(row),
    currentSourceContentHash: requiredHash(row, "current_source_content_hash"),
  }));
  if (rows.length !== input.expectedCount
    || new Set(rows.map(({ productId }) => productId)).size !== rows.length
    || new Set(rows.map(({ decisionId }) => decisionId)).size !== rows.length) {
    throw new Error("Live nutrition selection is not exactly one active decision per expected product");
  }
  const byId = new Map<string, ReviewEvidenceDecision>();
  for (const decision of input.decisions) {
    const existing = byId.get(decision.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(decision)) {
      throw new Error(`Published decision ${decision.id} has conflicting immutable records`);
    }
    byId.set(decision.id, decision);
  }
  const selected: ReviewEvidenceDecision[] = [];
  for (const row of rows) {
    const decision = byId.get(row.decisionId);
    if (!decision) throw new Error(`Selected live decision ${row.decisionId} is absent from the published bundles`);
    if (decision.fieldFamily !== "nutrition" || decision.decision !== "verify"
      || decision.productId !== row.productId
      || decision.sourceRecordId !== row.sourceRecordId
      || decision.sourceRecordKey !== row.sourceRecordKey
      || decision.sourceContentHash !== row.sourceContentHash
      || decision.candidateHash !== row.candidateHash
      || decision.decidedAt !== row.decidedAt
      || row.labelVerifiedAt !== row.decidedAt
      || row.currentSourceContentHash !== row.sourceContentHash) {
      throw new Error(`Selected live decision ${row.decisionId} does not match the authoritative fact projection`);
    }
    selected.push(decision);
  }
  selected.sort((left, right) => left.id.localeCompare(right.id));
  rows.sort((left, right) => left.productId.localeCompare(right.productId));
  return { rows, decisions: selected };
}

async function loadPublishedDecisions(directory: string, bundleIds: string[]): Promise<ReviewEvidenceDecision[]> {
  if (bundleIds.length === 0 || new Set(bundleIds).size !== bundleIds.length
    || JSON.stringify(bundleIds) !== JSON.stringify([...bundleIds].sort())) {
    throw new Error("Published live nutrition bundle IDs must be a non-empty sorted unique list");
  }
  const bundles = await Promise.all(bundleIds.map((bundleId) => readReviewDecisionBundle(join(directory, bundleId))));
  return bundles.flatMap(({ decisions }) => decisions);
}

function assertExpectedClassifications(input: {
  audit: DecisionDriftAuditReport;
  expectedSelected: number;
  expectedEligible: number;
  expectedCandidateDriftId: string;
  expectedMissingId: string;
}): void {
  const { audit } = input;
  if (audit.hasHardFailure || audit.conflicts.length > 0 || audit.findings.length !== input.expectedSelected
    || audit.classificationCounts.source_revision_drift_candidate_unchanged !== input.expectedEligible
    || audit.classificationCounts.candidate_drift !== 1
    || audit.classificationCounts.artifact_candidate_missing !== 1) {
    throw new Error("Live nutrition selection classifications differ from the approved accounting");
  }
  const allowed = new Set(["source_revision_drift_candidate_unchanged", "candidate_drift", "artifact_candidate_missing"]);
  if (audit.findings.some(({ classification }) => !allowed.has(classification))) {
    throw new Error("Live nutrition selection contains an unapproved drift classification");
  }
  const candidateDrift = audit.findings.filter(({ classification }) => classification === "candidate_drift");
  const missing = audit.findings.filter(({ classification }) => classification === "artifact_candidate_missing");
  if (candidateDrift[0]?.decisionId !== input.expectedCandidateDriftId || missing[0]?.decisionId !== input.expectedMissingId) {
    throw new Error("Live nutrition exception identities differ from the approved accounting");
  }
}

export async function prepareLiveNutritionSelection(input: {
  artifactDirectory: string;
  bundlesDirectory: string;
  activeSetFile: string;
  publishedBundleIds: string[];
  stateFile: string;
  outputRoot: string;
  scratchRoot: string;
  expectedSelected: number;
  expectedEligible: number;
  expectedPending: number;
  expectedCandidateDriftId: string;
  expectedMissingId: string;
}): Promise<LiveNutritionSelectionReport> {
  const artifactDirectory = resolve(input.artifactDirectory);
  const bundlesDirectory = resolve(input.bundlesDirectory);
  const outputRoot = resolve(input.outputRoot);
  const scratchRoot = resolve(input.scratchRoot);
  if (outputRoot !== bundlesDirectory) throw new Error("Live nutrition eligible bundle output must be the reviewed bundle root");
  const stateText = await readFile(resolve(input.stateFile), "utf8");
  const publishedDecisions = await loadPublishedDecisions(bundlesDirectory, input.publishedBundleIds);
  const selected = validateLiveNutritionSelection({
    state: JSON.parse(stateText) as unknown,
    decisions: publishedDecisions,
    expectedCount: input.expectedSelected,
  });

  await mkdir(scratchRoot, { recursive: true });
  const selectedBundle = await writeReviewDecisionBundle({
    decisions: selected.decisions,
    outputRoot: scratchRoot,
    createdAt: "2026-07-17T00:00:00.000Z",
  });
  const selectedManifest: ActiveManifest = {
    schemaVersion: 1,
    families: {
      ingredients: ["review-00000000000000000000"],
      nutrition: [selectedBundle.manifest.bundleId],
    },
  };
  const selectedManifestPath = join(scratchRoot, "live-selected.active.json");
  await writeFile(selectedManifestPath, `${JSON.stringify(selectedManifest, null, 2)}\n`, "utf8");
  const selectionAudit = await auditDecisionDrift({
    artifactDirectory,
    bundlesDirectory: scratchRoot,
    bundleSetFile: selectedManifestPath,
  });
  assertExpectedClassifications({
    audit: selectionAudit,
    expectedSelected: input.expectedSelected,
    expectedEligible: input.expectedEligible,
    expectedCandidateDriftId: input.expectedCandidateDriftId,
    expectedMissingId: input.expectedMissingId,
  });

  const eligibleIds = new Set(selectionAudit.findings
    .filter(({ classification }) => classification === "source_revision_drift_candidate_unchanged")
    .map(({ decisionId }) => decisionId));
  const eligibleDecisions = selected.decisions.filter(({ id }) => eligibleIds.has(id));
  if (eligibleDecisions.length !== input.expectedEligible) throw new Error("Eligible live predecessor selection count is incomplete");
  const eligibleBundle = await writeReviewDecisionBundle({
    decisions: eligibleDecisions,
    outputRoot,
    createdAt: "2026-07-17T00:00:00.000Z",
  });

  const [nutritionSet, ingredientSet] = await Promise.all([
    readActiveReviewBundleSet(resolve(input.activeSetFile), "nutrition"),
    readActiveReviewBundleSet(resolve(input.activeSetFile), "ingredients"),
  ]);
  const pendingAudit = await auditDecisionDrift({
    artifactDirectory,
    bundlesDirectory,
    bundleSetFile: resolve(input.activeSetFile),
  });
  if (!Number.isSafeInteger(input.expectedPending) || input.expectedPending <= 0
    || pendingAudit.hasHardFailure || pendingAudit.conflicts.length > 0
    || pendingAudit.inputs.decisionRecords !== input.expectedPending
    || pendingAudit.inputs.uniqueDecisions !== input.expectedPending
    || pendingAudit.classificationCounts.source_revision_drift_candidate_unchanged !== input.expectedPending
    || pendingAudit.findings.some(({ classification }) => classification !== "source_revision_drift_candidate_unchanged")) {
    throw new Error("Pending nutrition predecessor set differs from the approved source-revision-only accounting");
  }
  const expandedManifest: ActiveManifest = {
    schemaVersion: 1,
    families: {
      ingredients: ingredientSet.bundleIds,
      nutrition: [...nutritionSet.bundleIds, eligibleBundle.manifest.bundleId].sort(),
    },
  };
  const expandedText = `${JSON.stringify(expandedManifest, null, 2)}\n`;
  const expandedPath = join(outputRoot, "active-bundles.expanded.json");
  await writeFile(expandedPath, expandedText, "utf8");
  const expandedAudit = await auditDecisionDrift({
    artifactDirectory,
    bundlesDirectory,
    bundleSetFile: expandedPath,
  });
  const expectedExpanded = input.expectedPending + input.expectedEligible;
  if (expandedAudit.hasHardFailure || expandedAudit.conflicts.length > 0
    || expandedAudit.inputs.uniqueDecisions !== expectedExpanded
    || expandedAudit.classificationCounts.source_revision_drift_candidate_unchanged !== expectedExpanded
    || expandedAudit.findings.some(({ classification }) => classification !== "source_revision_drift_candidate_unchanged")) {
    throw new Error("Expanded nutrition predecessor set is not a complete source-revision-only cohort");
  }

  const exceptions = selectionAudit.findings
    .filter((finding): finding is typeof finding & { classification: "candidate_drift" | "artifact_candidate_missing" } =>
      finding.classification === "candidate_drift" || finding.classification === "artifact_candidate_missing")
    .map((finding) => ({
      decisionId: finding.decisionId,
      productId: finding.productId,
      sourceRecordKey: finding.sourceRecordKey,
      candidateHash: finding.candidateHash,
      classification: finding.classification,
      differences: finding.differences,
    }));
  const report: LiveNutritionSelectionReport = {
    schemaVersion: 1,
    selectedState: {
      expected: input.expectedSelected,
      actual: selected.rows.length,
      products: new Set(selected.rows.map(({ productId }) => productId)).size,
      decisions: new Set(selected.rows.map(({ decisionId }) => decisionId)).size,
      stateSha256: sha256Text(stateText),
      publishedBundleIds: input.publishedBundleIds,
    },
    artifact: selectionAudit.artifact,
    classifications: selectionAudit.classificationCounts,
    eligible: {
      expected: input.expectedEligible,
      actual: eligibleDecisions.length,
      bundleId: eligibleBundle.manifest.bundleId,
      ledgerSha256: eligibleBundle.manifest.ledgerSha256,
    },
    exceptions,
    expandedActiveSet: {
      file: "active-bundles.expanded.json",
      sha256: sha256Text(expandedText),
      nutritionDecisions: expandedAudit.inputs.uniqueDecisions,
      pendingDecisions: input.expectedPending,
      eligibleLiveDecisions: input.expectedEligible,
    },
  };
  await writeFile(join(outputRoot, "live-nutrition-selection-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(scratchRoot, "live-selection-audit.json"), `${JSON.stringify(selectionAudit, null, 2)}\n`, "utf8");
  await writeFile(join(scratchRoot, "expanded-selection-audit.json"), `${JSON.stringify(expandedAudit, null, 2)}\n`, "utf8");
  return report;
}
