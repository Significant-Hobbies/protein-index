import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson } from "../shared/evidence-decisions";
import type { ExtractionFieldFamily } from "../shared/extraction-outcomes";
import {
  DECISION_DRIFT_CLASSIFICATIONS,
  auditDecisionDrift,
  readActiveReviewBundleSet,
  type DecisionDriftAuditReport,
  type DecisionDriftFinding,
} from "./decision-drift-audit";
import {
  readReviewDecisionBundle,
  writeReviewDecisionBundle,
  type ReviewEvidenceDecision,
} from "./review-bundles";

const EXACT_LABEL_REATTESTATION_CONFIRMATION_PREFIX = "RE-ATTEST EXACT LABEL DECISIONS";

export interface ExactLabelReattestationInputs {
  artifactDirectory: string;
  bundlesDirectory: string;
  activeSetFile: string;
  fieldFamily: ExtractionFieldFamily;
  expectedDecisionCount: number;
  outputRoot: string;
  decidedBy: string;
  decidedAt: string;
  confirmation: string;
}

export interface ExactLabelReattestationEntry {
  predecessorDecisionId: string;
  replacementDecisionId: string;
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  productId: string;
  candidateHash: string;
  previousSourceContentHash: string;
  currentSourceContentHash: string;
  evidenceUrl: string;
  extractionAttemptId: string;
  labelAssetId: string;
  labelContentSha256: string;
  predecessorBundles: Array<{
    bundleId: string;
    ledgerSha256: string;
  }>;
}

export interface ExactLabelReattestationPlan {
  replacements: ReviewEvidenceDecision[];
  entries: ExactLabelReattestationEntry[];
}

export interface ExactLabelReattestationReport {
  schemaVersion: 1;
  artifact: DecisionDriftAuditReport["artifact"] & {
    checksumsSha256: string;
  };
  activeSet: {
    file: string;
    sha256: string;
    selectedBundleIds: string[];
  };
  authorization: {
    confirmed: true;
    decidedBy: string;
    decidedAt: string;
    confirmationBatchDigest: string;
  };
  fieldFamily: ExtractionFieldFamily;
  expectedDecisionCount: number;
  predecessorCount: number;
  replacementCount: number;
  replacementBundle: {
    bundleId: string;
    ledgerSha256: string;
    decisionCount: number;
    verifyCount: number;
    rejectCount: number;
  };
  proposedActiveSet: {
    file: "active-bundles.next.json";
    sha256: string;
  };
  exactLinkAudit: {
    exactLinkValid: number;
    uniqueDecisions: number;
    conflicts: number;
    hasHardFailure: false;
  };
  entries: ExactLabelReattestationEntry[];
}

interface ActiveBundleManifest {
  schemaVersion: 1;
  families: Record<ExtractionFieldFamily, string[]>;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value || parsed.valueOf() < Date.UTC(2000, 0, 1)) {
    throw new Error("Re-attestation --decided-at must be a canonical ISO-8601 UTC timestamp");
  }
  return value;
}

function exactReviewer(value: string): string {
  if (value !== value.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,99}$/.test(value)) {
    throw new Error("Re-attestation --decided-by must be a stable 2-100 character operator identity");
  }
  return value;
}

export function exactLabelReattestationConfirmation(input: {
  fieldFamily: ExtractionFieldFamily;
  extractionRunId: string;
  activeSetSha256: string;
  decisionCount: number;
}): string {
  return [
    EXACT_LABEL_REATTESTATION_CONFIRMATION_PREFIX,
    input.fieldFamily,
    input.extractionRunId,
    input.activeSetSha256,
    String(input.decisionCount),
  ].join(" ");
}

function assertConfirmation(value: string, audit: DecisionDriftAuditReport, fieldFamily: ExtractionFieldFamily, decisionCount: number): string {
  const activeSetSha256 = audit.inputs.bundleSetSha256;
  if (!activeSetSha256) throw new Error("Re-attestation requires a hashed active decision set");
  const expected = exactLabelReattestationConfirmation({
    fieldFamily,
    extractionRunId: audit.artifact.extractionRunId,
    activeSetSha256,
    decisionCount,
  });
  if (value !== expected) {
    throw new Error(`Re-attestation confirmation does not bind the exact artifact and active set; expected: ${expected}`);
  }
  return sha256Text(expected);
}

function exactCurrent(finding: DecisionDriftFinding): NonNullable<DecisionDriftFinding["current"]> {
  const current = finding.current;
  if (!current) throw new Error(`Decision ${finding.decisionId} has no current exact candidate`);
  return current;
}

function ensureEligibleFinding(finding: DecisionDriftFinding): void {
  if (finding.classification !== "source_revision_drift_candidate_unchanged") {
    throw new Error(`Decision ${finding.decisionId} is not source-revision-only: ${finding.classification}`);
  }
  if (canonicalJson(finding.differences) !== canonicalJson(["source_content_hash"])) {
    throw new Error(`Decision ${finding.decisionId} has unexpected drift fields`);
  }
  const current = exactCurrent(finding);
  if (!current.proofValid || current.proofIssues.length > 0) throw new Error(`Decision ${finding.decisionId} has an invalid current proof chain`);
  if (finding.sourceContentHash === current.sourceContentHash) {
    throw new Error(`Decision ${finding.decisionId} does not contain a source revision to re-attest`);
  }
  if (finding.evidenceUrl !== current.evidenceUrl) {
    throw new Error(`Decision ${finding.decisionId} evidence URL differs from the exact current label`);
  }
  if (!/^[a-f0-9]{64}$/.test(current.sourceContentHash)
    || !/^[a-f0-9]{64}$/.test(current.labelContentSha256)
    || !/^xat_[a-f0-9]{24}$/.test(current.extractionAttemptId)
    || !/^lbl_[a-f0-9]{24}$/.test(current.labelAssetId)) {
    throw new Error(`Decision ${finding.decisionId} has malformed exact-link identifiers`);
  }
}

function replacementId(input: {
  predecessorDecisionId: string;
  sourceContentHash: string;
  extractionAttemptId: string;
  labelAssetId: string;
  decidedBy: string;
  decidedAt: string;
}): string {
  return `evd_reattest_${sha256Text(canonicalJson(input)).slice(0, 24)}`;
}

function lineageRationale(predecessor: ReviewEvidenceDecision, finding: DecisionDriftFinding, extractionRunId: string): string {
  const current = exactCurrent(finding);
  const rationale = `${predecessor.rationale.trim()} Exact label lineage re-attested from ${predecessor.id} against extraction run ${extractionRunId}; retained label SHA-256 ${current.labelContentSha256}.`;
  if (rationale.length > 4_000) throw new Error(`Decision ${predecessor.id} lineage rationale exceeds the 4,000 character limit`);
  return rationale;
}

export function planExactLabelReattestation(input: {
  audit: DecisionDriftAuditReport;
  predecessors: ReviewEvidenceDecision[];
  fieldFamily: ExtractionFieldFamily;
  expectedDecisionCount: number;
  decidedBy: string;
  decidedAt: string;
  confirmation: string;
}): ExactLabelReattestationPlan {
  const decidedBy = exactReviewer(input.decidedBy);
  const decidedAt = exactTimestamp(input.decidedAt);
  const { audit } = input;
  if (!Number.isSafeInteger(input.expectedDecisionCount) || input.expectedDecisionCount <= 0) {
    throw new Error("Re-attestation expected decision count must be a positive integer");
  }
  assertConfirmation(input.confirmation, audit, input.fieldFamily, input.expectedDecisionCount);
  if (audit.artifact.fieldFamily !== input.fieldFamily) throw new Error("Artifact family does not match the requested re-attestation family");
  if (audit.hasHardFailure || audit.conflicts.length > 0) throw new Error("Decision drift audit contains a hard failure or conflict");
  if (audit.inputs.duplicateDecisionRecords !== 0
    || audit.inputs.uniqueDecisions !== audit.inputs.decisionRecords
    || audit.findings.length !== audit.inputs.uniqueDecisions
    || audit.findings.length !== input.expectedDecisionCount) {
    throw new Error("The selected active decision set is incomplete, duplicated, or empty");
  }
  const predecessors = new Map<string, ReviewEvidenceDecision>();
  for (const predecessor of input.predecessors) {
    if (predecessor.fieldFamily !== input.fieldFamily) throw new Error(`Predecessor ${predecessor.id} is from the wrong family`);
    if (predecessors.has(predecessor.id)) throw new Error(`Predecessor decision ${predecessor.id} is duplicated`);
    predecessors.set(predecessor.id, predecessor);
  }
  if (predecessors.size !== audit.findings.length) throw new Error("Predecessor selection does not exactly match the audited active set");

  const entries: ExactLabelReattestationEntry[] = [];
  const replacements: ReviewEvidenceDecision[] = [];
  const replacementIds = new Set<string>();
  const candidateKeys = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const finding of audit.findings) {
    ensureEligibleFinding(finding);
    const predecessor = predecessors.get(finding.decisionId);
    if (!predecessor) throw new Error(`Audited predecessor ${finding.decisionId} is missing`);
    const current = exactCurrent(finding);
    if (predecessor.sourceId !== finding.sourceId
      || predecessor.sourceRecordKey !== finding.sourceRecordKey
      || predecessor.sourceRecordId !== finding.sourceRecordId
      || predecessor.sourceContentHash !== finding.sourceContentHash
      || predecessor.productId !== finding.productId
      || predecessor.candidateHash !== finding.candidateHash
      || predecessor.evidenceUrl !== finding.evidenceUrl) {
      throw new Error(`Audited predecessor ${finding.decisionId} does not match its immutable bundle record`);
    }
    const id = replacementId({
      predecessorDecisionId: predecessor.id,
      sourceContentHash: current.sourceContentHash,
      extractionAttemptId: current.extractionAttemptId,
      labelAssetId: current.labelAssetId,
      decidedBy,
      decidedAt,
    });
    const candidateKey = [finding.sourceId, finding.sourceRecordKey, finding.candidateHash, finding.fieldFamily].join("\0");
    const sourceKey = [finding.sourceId, finding.sourceRecordKey, finding.fieldFamily].join("\0");
    if (replacementIds.has(id) || candidateKeys.has(candidateKey) || sourceKeys.has(sourceKey)) {
      throw new Error(`Replacement selection repeats an ID, candidate key, or source key at ${finding.decisionId}`);
    }
    replacementIds.add(id);
    candidateKeys.add(candidateKey);
    sourceKeys.add(sourceKey);
    const replacement: ReviewEvidenceDecision = {
      ...predecessor,
      id,
      sourceRecordId: current.sourceRecordId,
      sourceContentHash: current.sourceContentHash,
      productId: current.productId,
      extractionAttemptId: current.extractionAttemptId,
      labelAssetId: current.labelAssetId,
      evidenceUrl: current.evidenceUrl,
      rationale: lineageRationale(predecessor, finding, audit.artifact.extractionRunId),
      decidedBy,
      decidedAt,
    };
    replacements.push(replacement);
    entries.push({
      predecessorDecisionId: predecessor.id,
      replacementDecisionId: id,
      sourceId: finding.sourceId,
      sourceRecordKey: finding.sourceRecordKey,
      sourceRecordId: current.sourceRecordId,
      productId: current.productId,
      candidateHash: finding.candidateHash,
      previousSourceContentHash: predecessor.sourceContentHash,
      currentSourceContentHash: current.sourceContentHash,
      evidenceUrl: current.evidenceUrl,
      extractionAttemptId: current.extractionAttemptId,
      labelAssetId: current.labelAssetId,
      labelContentSha256: current.labelContentSha256,
      predecessorBundles: finding.bundles.map(({ bundleId, ledgerSha256 }) => ({ bundleId, ledgerSha256 })),
    });
  }
  if ([...predecessors.keys()].some((id) => !audit.findings.some((finding) => finding.decisionId === id))) {
    throw new Error("Predecessor selection contains a decision outside the audited active set");
  }
  replacements.sort((left, right) => left.id.localeCompare(right.id));
  entries.sort((left, right) => left.predecessorDecisionId.localeCompare(right.predecessorDecisionId));
  return { replacements, entries };
}

async function loadActiveManifest(path: string): Promise<ActiveBundleManifest> {
  const [nutrition, ingredients, text] = await Promise.all([
    readActiveReviewBundleSet(path, "nutrition"),
    readActiveReviewBundleSet(path, "ingredients"),
    readFile(path, "utf8"),
  ]);
  const parsed = JSON.parse(text) as ActiveBundleManifest;
  return {
    schemaVersion: 1,
    families: { nutrition: nutrition.bundleIds, ingredients: ingredients.bundleIds },
  };
}

async function loadPredecessors(directory: string, bundleIds: string[]): Promise<ReviewEvidenceDecision[]> {
  const bundles = await Promise.all(bundleIds.map((bundleId) => readReviewDecisionBundle(join(directory, bundleId))));
  return bundles.flatMap(({ decisions }) => decisions);
}

function assertExactReplacementAudit(report: DecisionDriftAuditReport, expected: number): void {
  if (report.hasHardFailure || report.conflicts.length > 0
    || report.inputs.uniqueDecisions !== expected
    || report.inputs.decisionRecords !== expected
    || report.inputs.duplicateDecisionRecords !== 0
    || report.findings.length !== expected
    || report.classificationCounts.exact_link_valid !== expected
    || report.findings.some((finding) => finding.classification !== "exact_link_valid")) {
    throw new Error("Proposed replacement bundle did not pass an all-exact-link audit");
  }
  for (const classification of DECISION_DRIFT_CLASSIFICATIONS) {
    if (classification !== "exact_link_valid" && report.classificationCounts[classification] !== 0) {
      throw new Error(`Proposed replacement audit retained ${classification} decisions`);
    }
  }
}

export async function generateExactLabelReattestation(inputs: ExactLabelReattestationInputs): Promise<ExactLabelReattestationReport> {
  const decidedBy = exactReviewer(inputs.decidedBy);
  const decidedAt = exactTimestamp(inputs.decidedAt);
  const artifactDirectory = resolve(inputs.artifactDirectory);
  const bundlesDirectory = resolve(inputs.bundlesDirectory);
  const activeSetFile = resolve(inputs.activeSetFile);
  const outputRoot = resolve(inputs.outputRoot);
  const [activeSet, initialAudit] = await Promise.all([
    loadActiveManifest(activeSetFile),
    auditDecisionDrift({ artifactDirectory, bundlesDirectory, bundleSetFile: activeSetFile }),
  ]);
  const selectedBundleIds = activeSet.families[inputs.fieldFamily];
  const predecessors = await loadPredecessors(bundlesDirectory, selectedBundleIds);
  const plan = planExactLabelReattestation({
    audit: initialAudit,
    predecessors,
    fieldFamily: inputs.fieldFamily,
    expectedDecisionCount: inputs.expectedDecisionCount,
    decidedBy,
    decidedAt,
    confirmation: inputs.confirmation,
  });

  await mkdir(outputRoot, { recursive: true });
  const bundle = await writeReviewDecisionBundle({ decisions: plan.replacements, outputRoot, createdAt: decidedAt });
  const proposed: ActiveBundleManifest = {
    schemaVersion: 1,
    families: {
      ingredients: inputs.fieldFamily === "ingredients" ? [bundle.manifest.bundleId] : activeSet.families.ingredients,
      nutrition: inputs.fieldFamily === "nutrition" ? [bundle.manifest.bundleId] : activeSet.families.nutrition,
    },
  };
  const proposedText = `${JSON.stringify(proposed, null, 2)}\n`;
  const pendingManifestPath = join(outputRoot, ".active-bundles.next.pending.json");
  const proposedManifestPath = join(outputRoot, "active-bundles.next.json");
  await writeFile(pendingManifestPath, proposedText, "utf8");
  const proposedAudit = await auditDecisionDrift({
    artifactDirectory,
    bundlesDirectory: outputRoot,
    bundleSetFile: pendingManifestPath,
  });
  assertExactReplacementAudit(proposedAudit, plan.replacements.length);

  const report: ExactLabelReattestationReport = {
    schemaVersion: 1,
    artifact: {
      ...initialAudit.artifact,
      checksumsSha256: sha256Text(await readFile(join(artifactDirectory, "checksums.sha256"), "utf8")),
    },
    activeSet: {
      file: basename(activeSetFile),
      sha256: initialAudit.inputs.bundleSetSha256 ?? sha256Text(await readFile(activeSetFile, "utf8")),
      selectedBundleIds,
    },
    authorization: {
      confirmed: true,
      decidedBy,
      decidedAt,
      confirmationBatchDigest: sha256Text(inputs.confirmation),
    },
    fieldFamily: inputs.fieldFamily,
    expectedDecisionCount: inputs.expectedDecisionCount,
    predecessorCount: predecessors.length,
    replacementCount: plan.replacements.length,
    replacementBundle: {
      bundleId: bundle.manifest.bundleId,
      ledgerSha256: bundle.manifest.ledgerSha256,
      decisionCount: bundle.manifest.decisionCount,
      verifyCount: bundle.manifest.verifyCount,
      rejectCount: bundle.manifest.rejectCount,
    },
    proposedActiveSet: {
      file: "active-bundles.next.json",
      sha256: sha256Text(proposedText),
    },
    exactLinkAudit: {
      exactLinkValid: proposedAudit.classificationCounts.exact_link_valid,
      uniqueDecisions: proposedAudit.inputs.uniqueDecisions,
      conflicts: proposedAudit.conflicts.length,
      hasHardFailure: false,
    },
    entries: plan.entries,
  };
  const reportPath = join(outputRoot, `reattestation-report.${inputs.fieldFamily}.json`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await rename(pendingManifestPath, proposedManifestPath);
  return report;
}
