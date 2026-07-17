import type {
  CompletionFamily,
  CompletionLabelEvidence,
  CompletionLabelEvidenceResponse,
  CompletionLane,
  CompletionLedgerFilters,
  CompletionLedgerItem,
  CompletionLedgerResponse,
  CompletionState,
  CompletionSummary,
  TerminalUnavailableOutcome,
} from "../shared/api";
import { normalizeText } from "../shared/gtin";
import type { EvidenceStatus, ProductCategory } from "../shared/types";

const FAMILIES: CompletionFamily[] = ["identity", "nutrition", "ingredients"];
const STATES = ["all", "verified", "terminal_unavailable", "outstanding"] as const;
const LANES = [
  "all",
  "evidence_inconsistent",
  "conflict_resolution",
  "review_ready",
  "retry_extraction",
  "run_extraction",
  "manual_label_review",
  "structured_evidence_review",
  "source_evidence_needed",
] as const;
const COMPLETION_LANES = LANES.filter((lane): lane is CompletionLane => lane !== "all");

interface SummaryRow {
  active_products: number;
  verified: number;
  terminal_unavailable: number;
  outstanding: number;
  contradictions: number;
  evidence_inconsistent: number;
  conflict_resolution: number;
  review_ready: number;
  retry_extraction: number;
  run_extraction: number;
  manual_label_review: number;
  structured_evidence_review: number;
  source_evidence_needed: number;
}

interface LedgerRow {
  id: string;
  gtin: string | null;
  brand: string;
  name: string;
  category: ProductCategory;
  image_url: string | null;
  completion_state: CompletionState;
  lane: CompletionLane | null;
  field_status: EvidenceStatus | null;
  terminal_outcome: TerminalUnavailableOutcome | null;
  label_url: string | null;
  source_url: string | null;
  source_id: string | null;
  source_record_id: string | null;
  evidence_observed_at: string | null;
  open_candidate_count: number;
  open_review_count: number;
  primary_review_id: string | null;
  extraction_labels: number;
  extraction_candidate: number;
  extraction_no_prediction: number;
  extraction_rejected: number;
  extraction_failed: number;
  extraction_unattempted: number;
  extraction_stale: number;
  extraction_conflicts: number;
  reason_codes_json: string;
  labels_json: string;
}

interface LabelRow {
  attempt_id: string;
  label_asset_id: string;
  source_image_id: string;
  role: CompletionLabelEvidence["role"];
  outcome: CompletionLabelEvidence["outcome"];
  effective_url: string;
  content_sha256: string;
  fetched_at: string;
  attempted_at: string;
  reasons_json: string;
}

interface CountRow { total: number }
interface SnapshotRow { snapshot_at: string | null }

const INLINE_LABEL_LIMIT = 4;

function parseReasonCodes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function parseLabelEvidence(value: string): CompletionLabelEvidence[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, INLINE_LABEL_LIMIT).flatMap((item): CompletionLabelEvidence[] => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const valid = typeof value.attemptId === "string"
        && typeof value.labelAssetId === "string"
        && typeof value.sourceImageId === "string"
        && ["requested", "prediction"].includes(String(value.role))
        && ["candidate", "no_prediction", "rejected", "failed"].includes(String(value.outcome))
        && typeof value.labelUrl === "string"
        && typeof value.contentSha256 === "string"
        && typeof value.fetchedAt === "string"
        && typeof value.attemptedAt === "string";
      if (!valid) return [];
      return [{
        attemptId: value.attemptId as string,
        labelAssetId: value.labelAssetId as string,
        sourceImageId: value.sourceImageId as string,
        role: value.role as CompletionLabelEvidence["role"],
        outcome: value.outcome as CompletionLabelEvidence["outcome"],
        labelUrl: value.labelUrl as string,
        contentSha256: value.contentSha256 as string,
        fetchedAt: value.fetchedAt as string,
        attemptedAt: value.attemptedAt as string,
        reasonCodes: parseReasonCodes(value.reasonsJson),
      }];
    });
  } catch {
    return [];
  }
}

function labelFromRow(row: LabelRow): CompletionLabelEvidence {
  return {
    attemptId: row.attempt_id,
    labelAssetId: row.label_asset_id,
    sourceImageId: row.source_image_id,
    role: row.role,
    outcome: row.outcome,
    labelUrl: row.effective_url,
    contentSha256: row.content_sha256,
    fetchedAt: row.fetched_at,
    attemptedAt: row.attempted_at,
    reasonCodes: parseReasonCodes(row.reasons_json),
  };
}

function completionReasonCodes(row: LedgerRow): string[] {
  if (row.completion_state !== "outstanding") return [];
  const codes = new Set(parseReasonCodes(row.reason_codes_json));
  if (row.lane === "evidence_inconsistent") codes.add("evidence_binding_inconsistent");
  if (row.lane === "conflict_resolution" || row.field_status === "conflict" || row.extraction_conflicts > 0) {
    codes.add("evidence_conflict");
  }
  if (row.open_candidate_count > 0) codes.add("review_candidate_pending");
  if (row.extraction_failed > 0) codes.add("extraction_failed");
  if (row.extraction_unattempted > 0) codes.add("extraction_unattempted");
  if (row.extraction_no_prediction > 0) codes.add("no_prediction");
  if (row.extraction_rejected > 0) codes.add("automated_result_rejected");
  if (row.field_status === "unverified") codes.add("structured_evidence_unverified");
  if (row.lane === "source_evidence_needed") codes.add("authoritative_source_missing");
  if (row.extraction_stale > 0) codes.add("stale_extraction_evidence");
  return [...codes].sort();
}

function familySql(family: CompletionFamily, includeSources = true): string {
  const supportsExtraction = family !== "identity";
  const factJoin = family === "nutrition"
    ? "LEFT JOIN nutrition_facts f ON f.product_id = p.id"
    : family === "ingredients"
      ? "LEFT JOIN ingredient_statements f ON f.product_id = p.id"
      : "";
  const currentFactJoin = family === "nutrition"
    ? "LEFT JOIN current_verified_nutrition_facts current_fact ON current_fact.product_id = p.id"
    : family === "ingredients"
      ? "LEFT JOIN current_verified_ingredient_statements current_fact ON current_fact.product_id = p.id"
      : "";
  const fieldStatus = family === "identity" ? "NULL" : "f.status";
  const factAuthority = family === "identity" ? "0" : "COALESCE(f.authority, 0)";
  const factSourceRecord = family === "identity" ? "NULL" : "f.source_record_id";
  const factObservedAt = family === "identity" ? "NULL" : "f.observed_at";
  const labelUrl = family === "nutrition"
    ? "p.nutrition_image_url"
    : family === "ingredients" ? "p.ingredient_image_url" : "p.image_url";
  const sourceAuthority = family === "nutrition"
    ? "s.nutrition_authority"
    : family === "ingredients" ? "s.ingredient_authority" : "s.identity_authority";
  const reviewType = family === "nutrition"
    ? "r.type IN ('nutrition_validation', 'nutrition_conflict', 'coverage_gap')"
    : family === "ingredients"
      ? "r.type = 'ingredient_conflict'"
      : "r.type IN ('identity', 'invalid_gtin')";
  const candidateReviewType = family === "nutrition"
    ? "r.type = 'nutrition_validation'"
    : family === "ingredients" ? "r.type = 'ingredient_conflict'" : "0";
  const extractionSourceId = family === "nutrition"
    ? "open_food_facts_robotoff"
    : family === "ingredients" ? "open_food_facts_robotoff_ingredients" : "";
  const verifiedFact = family === "identity"
    ? "0"
    : "j.current_verified_fact = 1";
  const legacyTerminal = family === "identity"
    ? "0"
    : `(COALESCE(j.outcome, '') IN ('not_applicable', 'not_declared')
      AND j.outcome_decided_by <> 'terminal_evidence_projection')`;
  const staleProjectedTerminal = family === "identity"
    ? "0"
    : `(COALESCE(j.outcome, '') IN ('not_applicable', 'not_declared')
      AND j.outcome_decided_by = 'terminal_evidence_projection'
      AND j.current_terminal_decision_count = 0)`;
  const contradiction = family === "identity"
    ? `((j.outcome IS NULL AND j.historical_identity_decision_count > 0)
      OR (j.outcome IS NOT NULL AND (
        j.outcome <> 'verified'
        OR substr(j.outcome_evidence_url, 1, 8) <> 'https://'
        OR j.identity_decision_id IS NULL
      )))`
    : `((j.outcome = 'verified' AND NOT (${verifiedFact}))
      OR j.current_terminal_outcome_count > 1
      OR (j.historical_terminal_decision_count > 0 AND j.current_terminal_decision_count = 0
        AND NOT (${verifiedFact}))
      OR (j.current_terminal_decision_count > 0 AND j.field_status IS NOT NULL)
      OR ${legacyTerminal}
      OR (${staleProjectedTerminal} AND NOT (${verifiedFact}))
      OR (j.field_status = 'verified' AND NOT (${verifiedFact}))
      OR (${legacyTerminal}
        AND j.outcome_source_origin_id IN (
          'open_food_facts_robotoff', 'open_food_facts_robotoff_ingredients'
        ))
      OR (${legacyTerminal}
        AND j.outcome_source_record_id IS NOT NULL
        AND COALESCE(j.outcome_source_record_observed_at, '') <> COALESCE(j.outcome_observed_at, ''))
      OR (j.outcome_source_record_id IS NOT NULL AND COALESCE(j.outcome_source_product_id, '') <> j.id)
      OR (j.linked_verify_count > j.current_linked_verify_count AND NOT (${verifiedFact})))`;
  const materialConflict = supportsExtraction ? "j.extraction_conflicts > 0" : "0";
  const verified = family === "identity"
    ? `j.outcome = 'verified'
      AND substr(j.outcome_evidence_url, 1, 8) = 'https://'
      AND j.identity_decision_id IS NOT NULL`
    : `(${verifiedFact}) AND j.current_terminal_decision_count = 0
      AND NOT (${legacyTerminal})`;
  const terminal = family === "identity"
    ? "0"
    : `j.current_terminal_decision_count > 0
      AND j.current_terminal_outcome_count = 1
      AND NOT (${verifiedFact})
      AND j.field_status IS NULL`;

  const extractionCtes = supportsExtraction ? `, current_label_ranked AS (
    SELECT a.product_id, a.id AS attempt_id, l.id AS label_asset_id, l.source_image_id,
      al.role, al.outcome, l.effective_url, l.content_sha256, l.fetched_at, a.attempted_at,
      al.candidate_count, al.rejection_count, al.failure_count, al.conflict_count, al.reasons_json,
      ROW_NUMBER() OVER (PARTITION BY a.product_id ORDER BY a.attempted_at DESC,
        l.source_image_id, l.id, al.role) AS label_rank
    FROM extraction_attempts a
    JOIN source_records subject ON subject.id = a.subject_source_record_id
      AND subject.product_id = a.product_id
      AND subject.content_hash = a.subject_source_content_hash
    JOIN extraction_attempt_labels al ON al.attempt_id = a.id
    JOIN current_label_evidence_assets l ON l.id = al.label_asset_id
      AND l.subject_source_record_id = a.subject_source_record_id
      AND l.subject_source_content_hash = a.subject_source_content_hash
      AND l.product_id = a.product_id AND l.field_family = a.field_family
    WHERE a.is_current = 1 AND a.field_family = '${family}'
  ), current_label_summary AS (
    SELECT product_id, COUNT(*) AS extraction_labels,
      SUM(CASE WHEN outcome = 'candidate' THEN 1 ELSE 0 END) AS extraction_candidate,
      SUM(CASE WHEN outcome = 'no_prediction' THEN 1 ELSE 0 END) AS extraction_no_prediction,
      SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END) AS extraction_rejected,
      SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS extraction_failed,
      SUM(conflict_count) AS extraction_conflicts,
      COALESCE(json_group_array(json_object(
        'attemptId', attempt_id, 'labelAssetId', label_asset_id,
        'sourceImageId', source_image_id, 'role', role, 'outcome', outcome,
        'labelUrl', effective_url, 'contentSha256', content_sha256,
        'fetchedAt', fetched_at, 'attemptedAt', attempted_at, 'reasonsJson', reasons_json
      )) FILTER (WHERE label_rank <= 4), '[]') AS labels_json
    FROM current_label_ranked GROUP BY product_id
  ), current_label_reason_summary AS (
    SELECT product_id, json_group_array(reason_code) AS reason_codes_json
    FROM (
      SELECT DISTINCT ranked.product_id, CAST(reason.value AS TEXT) AS reason_code
      FROM current_label_ranked ranked
      JOIN json_each(ranked.reasons_json) reason
      WHERE reason.type = 'text'
      ORDER BY ranked.product_id, reason_code
    ) GROUP BY product_id
  ), stale_label_summary AS (
    SELECT a.product_id, COUNT(DISTINCT al.label_asset_id) AS extraction_stale
    FROM extraction_attempts a
    JOIN extraction_attempt_labels al ON al.attempt_id = a.id
    LEFT JOIN source_records subject ON subject.id = a.subject_source_record_id
    LEFT JOIN current_label_evidence_assets current_label
      ON current_label.id = al.label_asset_id
      AND current_label.subject_source_record_id = a.subject_source_record_id
      AND current_label.subject_source_content_hash = a.subject_source_content_hash
      AND current_label.product_id = a.product_id
      AND current_label.field_family = a.field_family
    WHERE a.field_family = '${family}' AND (
      a.is_current = 0 OR subject.id IS NULL OR subject.product_id <> a.product_id
      OR subject.content_hash <> a.subject_source_content_hash OR current_label.id IS NULL
    ) GROUP BY a.product_id
  ), linked_decision_summary AS (
    SELECT d.product_id, d.source_record_id AS fact_source_record_id,
      COUNT(*) AS linked_verify_count,
      SUM(CASE WHEN a.is_current = 1
        AND subject.product_id = d.product_id AND subject.content_hash = a.subject_source_content_hash
        AND derived.product_id = d.product_id AND derived.content_hash = d.source_content_hash
        AND json_extract(derived.raw_evidence_json, '$.extractionAttemptId') = a.id
        AND json_extract(derived.raw_evidence_json, '$.labelAssetId') = d.label_asset_id
        AND json_extract(derived.raw_evidence_json, '$.labelContentSha256') = l.content_sha256
        AND al.label_asset_id = d.label_asset_id
        AND d.evidence_url IN (l.requested_url, l.effective_url)
        AND instr(al.candidate_hashes_json, '"' || d.candidate_hash || '"') > 0
        THEN 1 ELSE 0 END) AS current_linked_verify_count
    FROM evidence_decisions d
    JOIN extraction_attempts a ON a.id = d.extraction_attempt_id
    JOIN extraction_attempt_labels al ON al.attempt_id = a.id AND al.label_asset_id = d.label_asset_id
    JOIN current_label_evidence_assets l
      ON l.id = d.label_asset_id
      AND l.subject_source_record_id = a.subject_source_record_id
      AND l.subject_source_content_hash = a.subject_source_content_hash
      AND l.product_id = a.product_id
      AND l.field_family = a.field_family
    JOIN source_records derived ON derived.id = d.source_record_id
    JOIN source_records subject ON subject.id = a.subject_source_record_id
    WHERE d.active = 1 AND d.decision = 'verify' AND d.field_family = '${family}'
      AND derived.source_id = '${extractionSourceId}'
    GROUP BY d.product_id, d.source_record_id
  )` : "";
  const exactCandidateCte = supportsExtraction ? `, exact_candidate_ranked AS (
    SELECT r.product_id, r.id AS review_id,
      ROW_NUMBER() OVER (PARTITION BY r.product_id ORDER BY r.priority DESC, r.created_at, r.id) AS candidate_rank
    FROM review_items r
    JOIN source_records sr ON sr.id = r.source_record_id AND sr.product_id = r.product_id
    JOIN extraction_attempts a
      ON a.id = json_extract(r.evidence_json, '$.details.extractionAttemptId')
      AND a.is_current = 1 AND a.product_id = r.product_id AND a.field_family = '${family}'
    JOIN source_records subject ON subject.id = a.subject_source_record_id
      AND subject.product_id = a.product_id AND subject.content_hash = a.subject_source_content_hash
    JOIN extraction_attempt_labels al
      ON al.attempt_id = a.id
      AND al.label_asset_id = json_extract(r.evidence_json, '$.details.labelAssetId')
      AND al.outcome = 'candidate'
    JOIN current_label_evidence_assets l ON l.id = al.label_asset_id
      AND l.product_id = r.product_id AND l.field_family = '${family}'
      AND l.subject_source_record_id = a.subject_source_record_id
      AND l.subject_source_content_hash = a.subject_source_content_hash
    WHERE r.status = 'open' AND r.product_id IS NOT NULL AND ${candidateReviewType}
      AND sr.source_id = '${extractionSourceId}'
      AND json_type(r.evidence_json, '$.details.candidateHash') = 'text'
      AND json_extract(sr.raw_evidence_json, '$.extractionAttemptId') = a.id
      AND json_extract(sr.raw_evidence_json, '$.labelAssetId') = l.id
      AND json_extract(sr.raw_evidence_json, '$.labelContentSha256') = l.content_sha256
      AND json_extract(sr.raw_evidence_json, '$.candidateHash') =
        json_extract(r.evidence_json, '$.details.candidateHash')
      AND instr(al.candidate_hashes_json,
        '"' || json_extract(r.evidence_json, '$.details.candidateHash') || '"') > 0
  ), exact_candidate_summary AS (
    SELECT product_id, COUNT(*) AS open_candidate_count,
      MAX(CASE WHEN candidate_rank = 1 THEN review_id END) AS primary_candidate_review_id
    FROM exact_candidate_ranked GROUP BY product_id
  )` : "";
  const terminalDecisionCte = supportsExtraction ? `, current_terminal_ranked AS (
    SELECT decision.*,
      ROW_NUMBER() OVER (
        PARTITION BY decision.product_id, decision.field_family
        ORDER BY decision.source_authority DESC, decision.decided_at DESC, decision.id DESC
      ) AS decision_rank
    FROM current_terminal_evidence_decisions decision
    WHERE decision.field_family = '${family}'
  ), current_terminal_summary AS (
    SELECT product_id,
      COUNT(*) AS current_terminal_decision_count,
      COUNT(DISTINCT outcome) AS current_terminal_outcome_count,
      MIN(outcome) AS current_terminal_outcome,
      MAX(CASE WHEN decision_rank = 1 THEN source_id END) AS terminal_source_id,
      MAX(CASE WHEN decision_rank = 1 THEN source_record_id END) AS terminal_source_record_id,
      MAX(CASE WHEN decision_rank = 1 THEN evidence_url END) AS terminal_evidence_url,
      MAX(CASE WHEN decision_rank = 1 THEN source_observed_at END) AS terminal_source_observed_at
    FROM current_terminal_ranked
    GROUP BY product_id
  ), terminal_history_summary AS (
    SELECT product_id, COUNT(*) AS historical_terminal_decision_count
    FROM terminal_evidence_decisions
    WHERE field_family = '${family}'
    GROUP BY product_id
  )` : "";
  const identityDecisionCte = family === "identity" ? `, current_identity_decision_summary AS (
    SELECT decision.product_id, COUNT(*) AS current_identity_decision_count
    FROM current_identity_evidence_decisions decision
    GROUP BY decision.product_id
  ), identity_decision_history_summary AS (
    SELECT product_id, COUNT(*) AS historical_identity_decision_count
    FROM identity_evidence_decisions
    GROUP BY product_id
  )` : "";
  const sourceCtes = includeSources ? `, source_ranked AS (
    SELECT sr.product_id, sr.id AS source_record_id, sr.source_id, sr.source_url, sr.observed_at,
      ROW_NUMBER() OVER (PARTITION BY sr.product_id
        ORDER BY ${sourceAuthority} DESC, sr.observed_at DESC, sr.id) AS source_rank
    FROM source_records sr JOIN sources s ON s.id = sr.source_id
    WHERE sr.product_id IS NOT NULL
  ), source_best AS (
    SELECT product_id, source_record_id, source_id, source_url, observed_at
    FROM source_ranked WHERE source_rank = 1
  )` : "";
  const sourceColumns = includeSources
    ? `sb.source_record_id AS best_source_record_id, sb.source_id AS best_source_id,
      sb.source_url AS best_source_url, sb.observed_at AS best_source_observed_at`
    : `NULL AS best_source_record_id, NULL AS best_source_id,
      NULL AS best_source_url, NULL AS best_source_observed_at`;
  const sourceJoin = includeSources ? "LEFT JOIN source_best sb ON sb.product_id = p.id" : "";
  const factSourceColumns = family === "identity"
    ? "NULL AS fact_source_record_id, NULL AS fact_source_id, NULL AS fact_source_url, NULL AS fact_observed_at"
    : `fsr.id AS fact_source_record_id, fsr.source_id AS fact_source_id,
      fsr.source_url AS fact_source_url, ${factObservedAt} AS fact_observed_at`;
  const evidenceSourceColumns = includeSources
    ? `osr.source_id AS outcome_source_id, osr.source_url AS outcome_source_url,
      ${factSourceColumns}`
    : `NULL AS outcome_source_id, NULL AS outcome_source_url,
      NULL AS fact_source_record_id, NULL AS fact_source_id,
      NULL AS fact_source_url, NULL AS fact_observed_at`;
  const evidenceSourceJoin = includeSources
    ? `LEFT JOIN source_records osr ON osr.id = eo.source_record_id
    ${family === "identity" ? "" : `LEFT JOIN source_records fsr ON fsr.id = ${factSourceRecord}`}`
    : `LEFT JOIN source_records osr ON osr.id = eo.source_record_id
    ${family === "identity" ? "" : `LEFT JOIN source_records fsr ON fsr.id = ${factSourceRecord}`}`;
  const identityDecisionColumns = family === "identity"
    ? `identity_decision.id AS identity_decision_id,
      COALESCE(identity_summary.current_identity_decision_count, 0) AS current_identity_decision_count,
      COALESCE(identity_history.historical_identity_decision_count, 0) AS historical_identity_decision_count`
    : `NULL AS identity_decision_id, 0 AS current_identity_decision_count,
      0 AS historical_identity_decision_count`;
  const terminalDecisionColumns = supportsExtraction
    ? `COALESCE(terminal_summary.current_terminal_decision_count, 0) AS current_terminal_decision_count,
      COALESCE(terminal_summary.current_terminal_outcome_count, 0) AS current_terminal_outcome_count,
      COALESCE(terminal_history.historical_terminal_decision_count, 0) AS historical_terminal_decision_count,
      terminal_summary.current_terminal_outcome,
      terminal_summary.terminal_source_id,
      terminal_summary.terminal_source_record_id,
      terminal_summary.terminal_evidence_url,
      terminal_summary.terminal_source_observed_at`
    : `0 AS current_terminal_decision_count, 0 AS current_terminal_outcome_count,
      0 AS historical_terminal_decision_count,
      NULL AS current_terminal_outcome, NULL AS terminal_source_id,
      NULL AS terminal_source_record_id, NULL AS terminal_evidence_url,
      NULL AS terminal_source_observed_at`;
  const terminalDecisionJoin = supportsExtraction
    ? `LEFT JOIN current_terminal_summary terminal_summary ON terminal_summary.product_id = p.id
      LEFT JOIN terminal_history_summary terminal_history ON terminal_history.product_id = p.id`
    : "";
  const identityDecisionJoin = family === "identity" ? `
    LEFT JOIN current_identity_decision_summary identity_summary ON identity_summary.product_id = p.id
    LEFT JOIN identity_decision_history_summary identity_history ON identity_history.product_id = p.id
    LEFT JOIN current_identity_evidence_decisions identity_decision
      ON identity_decision.product_id = p.id
      AND identity_decision.source_record_id = eo.source_record_id
      AND identity_decision.evidence_url = eo.evidence_url
      AND identity_decision.source_observed_at = eo.observed_at
      AND identity_decision.decided_at = eo.verified_at
      AND identity_decision.decided_by = eo.decided_by
      AND identity_decision.rationale = eo.notes
      AND osr.id = identity_decision.source_record_id`
    : "";
  const extractionColumns = supportsExtraction ? `
      COALESCE(cls.extraction_labels, 0) AS extraction_labels,
      COALESCE(cls.extraction_candidate, 0) AS extraction_candidate,
      COALESCE(cls.extraction_no_prediction, 0) AS extraction_no_prediction,
      COALESCE(cls.extraction_rejected, 0) AS extraction_rejected,
      COALESCE(cls.extraction_failed, 0) AS extraction_failed,
      CASE WHEN TRIM(COALESCE(${labelUrl}, '')) <> '' AND COALESCE(cls.extraction_labels, 0) = 0 THEN 1 ELSE 0 END AS extraction_unattempted,
      COALESCE(sls.extraction_stale, 0) AS extraction_stale,
      COALESCE(cls.extraction_conflicts, 0) AS extraction_conflicts,
      COALESCE(clrs.reason_codes_json, '[]') AS reason_codes_json,
      COALESCE(cls.labels_json, '[]') AS labels_json,
      COALESCE(lds.linked_verify_count, 0) AS linked_verify_count,
      COALESCE(lds.current_linked_verify_count, 0) AS current_linked_verify_count`
    : `0 AS extraction_labels, 0 AS extraction_candidate, 0 AS extraction_no_prediction,
      0 AS extraction_rejected, 0 AS extraction_failed, 0 AS extraction_unattempted,
      0 AS extraction_stale, 0 AS extraction_conflicts, '[]' AS reason_codes_json, '[]' AS labels_json,
      0 AS linked_verify_count, 0 AS current_linked_verify_count`;
  const extractionJoins = supportsExtraction ? `
    LEFT JOIN current_label_summary cls ON cls.product_id = p.id
    LEFT JOIN current_label_reason_summary clrs ON clrs.product_id = p.id
    LEFT JOIN stale_label_summary sls ON sls.product_id = p.id
    LEFT JOIN linked_decision_summary lds
      ON lds.product_id = p.id AND lds.fact_source_record_id = f.source_record_id
    LEFT JOIN exact_candidate_summary ecs ON ecs.product_id = p.id` : "";
  const candidateColumns = supportsExtraction
    ? "COALESCE(ecs.open_candidate_count, 0) AS open_candidate_count, COALESCE(ecs.primary_candidate_review_id, rs.primary_review_id) AS primary_review_id"
    : "0 AS open_candidate_count, rs.primary_review_id";

  return `WITH review_ranked AS (
    SELECT r.product_id, r.id AS review_id,
      ROW_NUMBER() OVER (PARTITION BY r.product_id ORDER BY r.priority DESC, r.created_at, r.id) AS review_rank
    FROM review_items r
    WHERE r.status = 'open' AND r.product_id IS NOT NULL AND ${reviewType}
  ), review_summary AS (
    SELECT product_id, COUNT(*) AS open_review_count,
      MAX(CASE WHEN review_rank = 1 THEN review_id END) AS primary_review_id
    FROM review_ranked GROUP BY product_id
  )${extractionCtes}${exactCandidateCte}${terminalDecisionCte}${identityDecisionCte}${sourceCtes}, joined AS (
    SELECT p.id, p.gtin, p.brand, p.brand_normalized, p.name, p.name_normalized,
      p.category, p.image_url, ${labelUrl} AS label_url,
      ${fieldStatus} AS field_status, ${factAuthority} AS fact_authority,
      ${family === "identity" ? "0" : "CASE WHEN current_fact.product_id IS NULL THEN 0 ELSE 1 END"} AS current_verified_fact,
      eo.outcome, eo.evidence_url AS outcome_evidence_url,
      eo.decided_by AS outcome_decided_by,
      eo.source_record_id AS outcome_source_record_id, osr.product_id AS outcome_source_product_id,
      osr.source_id AS outcome_source_origin_id,
      osr.observed_at AS outcome_source_record_observed_at,
      ${family === "identity" ? "NULL" : "fsr.source_id"} AS fact_source_origin_id,
      eo.observed_at AS outcome_observed_at, ${evidenceSourceColumns}, ${identityDecisionColumns},
      ${terminalDecisionColumns},
      COALESCE(rs.open_review_count, 0) AS open_review_count,
      ${candidateColumns}, ${extractionColumns}, ${sourceColumns}
    FROM products p ${factJoin}
    ${currentFactJoin}
    LEFT JOIN evidence_outcomes eo ON eo.product_id = p.id AND eo.field_family = '${family}'
    ${evidenceSourceJoin}
    ${identityDecisionJoin}
    ${terminalDecisionJoin}
    LEFT JOIN review_summary rs ON rs.product_id = p.id
    ${extractionJoins}
    ${sourceJoin}
    WHERE p.is_active = 1
  ), classified AS (
    SELECT j.*,
      CASE WHEN ${contradiction} THEN 1 ELSE 0 END AS contradiction,
      CASE WHEN ${contradiction} OR ${materialConflict} THEN 'outstanding'
        WHEN ${verified} THEN 'verified'
        WHEN ${terminal} THEN 'terminal_unavailable'
        ELSE 'outstanding' END AS completion_state
    FROM joined j
  ), ledger AS (
    SELECT c.*,
      CASE WHEN c.completion_state <> 'outstanding' THEN NULL
        WHEN c.contradiction = 1 THEN 'evidence_inconsistent'
        WHEN c.field_status = 'conflict' OR c.extraction_conflicts > 0 THEN 'conflict_resolution'
        WHEN c.open_candidate_count > 0 THEN 'review_ready'
        WHEN c.extraction_failed > 0 THEN 'retry_extraction'
        WHEN c.extraction_unattempted > 0 THEN 'run_extraction'
        WHEN c.extraction_labels > 0 AND c.extraction_candidate = 0
          AND (c.extraction_no_prediction > 0 OR c.extraction_rejected > 0) THEN 'manual_label_review'
        WHEN c.field_status = 'unverified' THEN 'structured_evidence_review'
        ELSE 'source_evidence_needed' END AS lane,
      CASE WHEN c.current_terminal_decision_count > 0 THEN c.current_terminal_outcome
        WHEN c.outcome IN ('not_applicable', 'not_declared') THEN c.outcome ELSE NULL END AS terminal_outcome,
      CASE WHEN c.current_terminal_decision_count > 0 THEN c.terminal_evidence_url
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' THEN c.outcome_evidence_url
        WHEN c.outcome_source_record_id IS NOT NULL THEN c.outcome_source_url
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_source_url ELSE c.best_source_url END AS source_url,
      CASE WHEN c.current_terminal_decision_count > 0 THEN c.terminal_source_id
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' OR c.outcome_source_record_id IS NOT NULL THEN c.outcome_source_id
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_source_id ELSE c.best_source_id END AS source_id,
      CASE WHEN c.current_terminal_decision_count > 0 THEN c.terminal_source_record_id
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' OR c.outcome_source_record_id IS NOT NULL THEN c.outcome_source_record_id
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_source_record_id ELSE c.best_source_record_id END AS source_record_id,
      CASE WHEN c.current_terminal_decision_count > 0 THEN c.terminal_source_observed_at
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' OR c.outcome_source_record_id IS NOT NULL THEN c.outcome_observed_at
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_observed_at ELSE c.best_source_observed_at END AS evidence_observed_at,
      CASE WHEN c.completion_state = 'outstanding' AND c.contradiction = 1 THEN 1
        WHEN c.completion_state = 'outstanding' AND (c.field_status = 'conflict' OR c.extraction_conflicts > 0) THEN 2
        WHEN c.completion_state = 'outstanding' AND c.open_candidate_count > 0 THEN 3
        WHEN c.completion_state = 'outstanding' AND c.extraction_failed > 0 THEN 4
        WHEN c.completion_state = 'outstanding' AND c.extraction_unattempted > 0 THEN 5
        WHEN c.completion_state = 'outstanding' AND c.extraction_labels > 0 AND c.extraction_candidate = 0
          AND (c.extraction_no_prediction > 0 OR c.extraction_rejected > 0) THEN 6
        WHEN c.completion_state = 'outstanding' AND c.field_status = 'unverified' THEN 7
        WHEN c.completion_state = 'outstanding' THEN 8
        WHEN c.completion_state = 'verified' THEN 9 ELSE 10 END AS lane_priority
    FROM classified c
  )`;
}

function summarySql(family: CompletionFamily): string {
  return `${familySql(family, false)} SELECT COUNT(*) AS active_products,
    SUM(CASE WHEN completion_state = 'verified' THEN 1 ELSE 0 END) AS verified,
    SUM(CASE WHEN completion_state = 'terminal_unavailable' THEN 1 ELSE 0 END) AS terminal_unavailable,
    SUM(CASE WHEN completion_state = 'outstanding' THEN 1 ELSE 0 END) AS outstanding,
    SUM(contradiction) AS contradictions,
    ${COMPLETION_LANES.map((lane) => `SUM(CASE WHEN lane = '${lane}' THEN 1 ELSE 0 END) AS ${lane}`).join(",\n    ")}
    FROM ledger`;
}

function summaryFromRow(family: CompletionFamily, row: SummaryRow | undefined): CompletionSummary {
  const activeProducts = row?.active_products ?? 0;
  const verified = row?.verified ?? 0;
  const terminalUnavailable = row?.terminal_unavailable ?? 0;
  const outstanding = row?.outstanding ?? 0;
  const lanes = Object.fromEntries(COMPLETION_LANES.map((lane) => [lane, row?.[lane] ?? 0])) as Record<CompletionLane, number>;
  const accounted = verified + terminalUnavailable + outstanding;
  return {
    family,
    activeProducts,
    verified,
    terminalUnavailable,
    outstanding,
    contradictions: row?.contradictions ?? 0,
    accounted,
    invariantHolds: accounted === activeProducts,
    lanes,
  };
}

export function validateCompletionLedger(input: URLSearchParams): { value?: CompletionLedgerFilters; error?: string } {
  const q = input.get("q")?.trim() ?? "";
  const family = input.get("family") ?? "nutrition";
  const state = input.get("state") ?? "outstanding";
  const lane = input.get("lane") ?? "all";
  const page = Number(input.get("page") ?? 1);
  const pageSize = Number(input.get("pageSize") ?? 50);
  if (!FAMILIES.includes(family as CompletionFamily)) return { error: "Invalid completion family" };
  if (!STATES.includes(state as typeof STATES[number])) return { error: "Invalid completion state" };
  if (!LANES.includes(lane as typeof LANES[number])) return { error: "Invalid completion lane" };
  const searchTerms = normalizeText(q).split(" ").filter(Boolean);
  if (q.length > 200 || searchTerms.length > 12) return { error: "Search query is too long" };
  if (!Number.isInteger(page) || page < 1) return { error: "Page must be a positive integer" };
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return { error: "Page size must be between 1 and 100" };
  return {
    value: {
      family: family as CompletionFamily,
      state: state as CompletionLedgerFilters["state"],
      lane: lane as CompletionLedgerFilters["lane"],
      q,
      page,
      pageSize,
    },
  };
}

function filtersSql(input: CompletionLedgerFilters): { sql: string; bindings: Array<string | number> } {
  const clauses: string[] = [];
  const bindings: Array<string | number> = [];
  if (input.state !== "all") {
    clauses.push("completion_state = ?");
    bindings.push(input.state);
  }
  if (input.lane !== "all") {
    clauses.push("lane = ?");
    bindings.push(input.lane);
  }
  for (const term of normalizeText(input.q).split(" ").filter(Boolean)) {
    clauses.push("(name_normalized LIKE ? OR brand_normalized LIKE ? OR gtin LIKE ?)");
    const like = `%${term}%`;
    bindings.push(like, like, like);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", bindings };
}

export async function getCompletionSummaries(db: D1Database): Promise<{
  families: Record<CompletionFamily, CompletionSummary>;
  snapshotAt: string | null;
}> {
  const results = await db.batch([
    ...FAMILIES.map((family) => db.prepare(summarySql(family))),
    db.prepare("SELECT MAX(completed_at) AS snapshot_at FROM ingestion_runs WHERE status = 'completed'"),
  ]);
  return {
    families: {
      identity: summaryFromRow("identity", results[0]?.results[0] as SummaryRow | undefined),
      nutrition: summaryFromRow("nutrition", results[1]?.results[0] as SummaryRow | undefined),
      ingredients: summaryFromRow("ingredients", results[2]?.results[0] as SummaryRow | undefined),
    },
    snapshotAt: (results[3]?.results[0] as SnapshotRow | undefined)?.snapshot_at ?? null,
  };
}

export async function getCompletionLedger(
  db: D1Database,
  input: CompletionLedgerFilters,
): Promise<CompletionLedgerResponse> {
  const base = familySql(input.family);
  const filters = filtersSql(input);
  const listSql = `${base} SELECT id, gtin, brand, name, category, image_url,
    completion_state, lane, field_status, terminal_outcome, label_url, source_url,
    source_id, source_record_id, evidence_observed_at, open_candidate_count,
    open_review_count, primary_review_id, extraction_labels, extraction_candidate,
    extraction_no_prediction, extraction_rejected, extraction_failed,
    extraction_unattempted, extraction_stale, extraction_conflicts, reason_codes_json, labels_json
    FROM ledger ${filters.sql}
    ORDER BY lane_priority, brand_normalized, name_normalized, id LIMIT ? OFFSET ?`;
  const countSql = `${familySql(input.family, false)} SELECT COUNT(*) AS total FROM ledger ${filters.sql}`;
  const offset = (input.page - 1) * input.pageSize;
  const [summaryResult, countResult, pageResult, snapshotResult] = await db.batch([
    db.prepare(summarySql(input.family)),
    db.prepare(countSql).bind(...filters.bindings),
    db.prepare(listSql).bind(...filters.bindings, input.pageSize, offset),
    db.prepare("SELECT MAX(completed_at) AS snapshot_at FROM ingestion_runs WHERE status = 'completed'"),
  ]);
  const summary = summaryFromRow(input.family, summaryResult?.results[0] as SummaryRow | undefined);
  const total = (countResult?.results[0] as CountRow | undefined)?.total ?? 0;
  const rows = (pageResult?.results ?? []) as unknown as LedgerRow[];
  return {
    items: rows.map((row): CompletionLedgerItem => ({
      product: {
        id: row.id,
        gtin: row.gtin,
        brand: row.brand,
        name: row.name,
        category: row.category,
        imageUrl: row.image_url,
      },
      family: input.family,
      state: row.completion_state,
      lane: row.lane,
      fieldStatus: row.field_status,
      terminalOutcome: row.terminal_outcome,
      labelUrl: row.label_url,
      sourceUrl: row.source_url,
      sourceId: row.source_id,
      sourceRecordId: row.source_record_id,
      evidenceObservedAt: row.evidence_observed_at,
      openCandidateCount: row.open_candidate_count,
      openReviewCount: row.open_review_count,
      primaryReviewId: row.lane === "review_ready" ? row.primary_review_id : null,
      primaryActionId: row.lane === "review_ready" && row.primary_review_id ? row.primary_review_id : row.id,
      extraction: {
        labels: row.extraction_labels,
        candidate: row.extraction_candidate,
        noPrediction: row.extraction_no_prediction,
        rejected: row.extraction_rejected,
        failed: row.extraction_failed,
        unattempted: row.extraction_unattempted,
        stale: row.extraction_stale,
        conflicts: row.extraction_conflicts,
      },
      reasonCodes: completionReasonCodes(row),
      labels: parseLabelEvidence(row.labels_json),
      labelsTruncated: row.extraction_labels > INLINE_LABEL_LIMIT,
    })),
    summary,
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      pages: Math.ceil(total / input.pageSize),
    },
    filters: input,
    snapshotAt: (snapshotResult?.results[0] as SnapshotRow | undefined)?.snapshot_at ?? null,
  };
}

export function validateCompletionLabels(input: URLSearchParams): {
  value?: { family: "nutrition" | "ingredients"; page: number; pageSize: number };
  error?: string;
} {
  const family = input.get("family") ?? "nutrition";
  const page = Number(input.get("page") ?? 1);
  const pageSize = Number(input.get("pageSize") ?? 25);
  if (!(["nutrition", "ingredients"] as const).includes(family as "nutrition" | "ingredients")) {
    return { error: "Invalid extraction family" };
  }
  if (!Number.isInteger(page) || page < 1) return { error: "Page must be a positive integer" };
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return { error: "Page size must be between 1 and 100" };
  }
  return { value: { family: family as "nutrition" | "ingredients", page, pageSize } };
}

export async function getCompletionLabels(
  db: D1Database,
  productId: string,
  input: { family: "nutrition" | "ingredients"; page: number; pageSize: number },
): Promise<CompletionLabelEvidenceResponse | null> {
  const product = await db.prepare("SELECT id FROM products WHERE id = ? AND is_active = 1")
    .bind(productId).first<{ id: string }>();
  if (!product) return null;
  const offset = (input.page - 1) * input.pageSize;
  const currentBinding = `a.is_current = 1 AND a.product_id = ? AND a.field_family = ?
    AND subject.product_id = a.product_id AND subject.content_hash = a.subject_source_content_hash
    AND l.subject_source_record_id = a.subject_source_record_id
    AND l.subject_source_content_hash = a.subject_source_content_hash
    AND l.product_id = a.product_id AND l.field_family = a.field_family`;
  const from = `FROM extraction_attempts a
    JOIN source_records subject ON subject.id = a.subject_source_record_id
    JOIN extraction_attempt_labels al ON al.attempt_id = a.id
    JOIN label_evidence_assets l ON l.id = al.label_asset_id`;
  const [countResult, pageResult] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total ${from} WHERE ${currentBinding}`).bind(productId, input.family),
    db.prepare(`SELECT a.id AS attempt_id, l.id AS label_asset_id, l.source_image_id,
      al.role, al.outcome, l.effective_url, l.content_sha256, l.fetched_at, a.attempted_at,
      al.reasons_json
      ${from} WHERE ${currentBinding}
      ORDER BY a.attempted_at DESC, l.source_image_id, l.id, al.role LIMIT ? OFFSET ?`)
      .bind(productId, input.family, input.pageSize, offset),
  ]);
  const total = (countResult?.results[0] as CountRow | undefined)?.total ?? 0;
  return {
    productId,
    family: input.family,
    items: (pageResult?.results ?? []).map((row) => labelFromRow(row as unknown as LabelRow)),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      pages: Math.ceil(total / input.pageSize),
    },
  };
}

export const completionSummaryQuery = summarySql;
