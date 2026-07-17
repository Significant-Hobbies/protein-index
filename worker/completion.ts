import type {
  CompletionFamily,
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
  "structured_evidence_review",
  "label_evidence_review",
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
  structured_evidence_review: number;
  label_evidence_review: number;
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
}

interface CountRow { total: number }
interface SnapshotRow { snapshot_at: string | null }

function familySql(family: CompletionFamily, includeSources = true): string {
  const factJoin = family === "nutrition"
    ? "LEFT JOIN nutrition_facts f ON f.product_id = p.id"
    : family === "ingredients"
      ? "LEFT JOIN ingredient_statements f ON f.product_id = p.id"
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
  const candidate = family === "nutrition"
    ? "r.type = 'nutrition_validation' AND sr.source_id = 'open_food_facts_robotoff'"
    : family === "ingredients"
      ? "r.type = 'ingredient_conflict' AND sr.source_id = 'open_food_facts_robotoff_ingredients'"
      : "0";
  const verifiedFact = family === "identity"
    ? "0"
    : "j.field_status = 'verified' AND j.fact_authority = 100";
  const contradiction = family === "identity"
    ? `(j.outcome IN ('not_applicable', 'not_declared')
      OR (j.outcome = 'verified' AND TRIM(COALESCE(j.outcome_evidence_url, '')) = ''))`
    : `((j.outcome = 'verified' AND NOT (${verifiedFact}))
      OR (j.outcome IN ('not_applicable', 'not_declared') AND (${verifiedFact}))
      OR (j.outcome IN ('not_applicable', 'not_declared') AND j.field_status = 'conflict')
      OR (j.outcome IN ('not_applicable', 'not_declared') AND TRIM(COALESCE(j.outcome_evidence_url, '')) = '')
      OR (j.field_status = 'verified' AND j.fact_authority <> 100))`;
  const verified = family === "identity"
    ? "j.outcome = 'verified' AND TRIM(COALESCE(j.outcome_evidence_url, '')) <> ''"
    : `(${verifiedFact}) AND COALESCE(j.outcome, '') NOT IN ('not_applicable', 'not_declared')`;
  const terminal = family === "identity"
    ? "0"
    : `j.outcome IN ('not_applicable', 'not_declared')
      AND NOT (${verifiedFact})
      AND TRIM(COALESCE(j.outcome_evidence_url, '')) <> ''`;

  const sourceCtes = includeSources ? `, source_ranked AS (
    SELECT sr.product_id, sr.id AS source_record_id, sr.source_id, sr.source_url, sr.observed_at,
      ROW_NUMBER() OVER (
        PARTITION BY sr.product_id
        ORDER BY ${sourceAuthority} DESC, sr.observed_at DESC, sr.id
      ) AS source_rank
    FROM source_records sr JOIN sources s ON s.id = sr.source_id
    WHERE sr.product_id IS NOT NULL
  ), source_best AS (
    SELECT product_id, source_record_id, source_id, source_url, observed_at
    FROM source_ranked WHERE source_rank = 1
  )` : "";
  const sourceColumns = includeSources
    ? `sb.source_record_id AS best_source_record_id,
      sb.source_id AS best_source_id, sb.source_url AS best_source_url,
      sb.observed_at AS best_source_observed_at`
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
    : "";

  return `WITH review_ranked AS (
    SELECT r.product_id, r.id AS review_id,
      CASE WHEN ${candidate} THEN 1 ELSE 0 END AS is_candidate,
      ROW_NUMBER() OVER (
        PARTITION BY r.product_id ORDER BY r.priority DESC, r.created_at, r.id
      ) AS review_rank
    FROM review_items r
    LEFT JOIN source_records sr ON sr.id = r.source_record_id
    WHERE r.status = 'open' AND r.product_id IS NOT NULL AND ${reviewType}
  ), review_summary AS (
    SELECT product_id, COUNT(*) AS open_review_count,
      SUM(is_candidate) AS open_candidate_count,
      MAX(CASE WHEN review_rank = 1 THEN review_id END) AS primary_review_id
    FROM review_ranked GROUP BY product_id
  )${sourceCtes}, joined AS (
    SELECT p.id, p.gtin, p.brand, p.brand_normalized, p.name, p.name_normalized,
      p.category, p.image_url, ${labelUrl} AS label_url,
      ${fieldStatus} AS field_status, ${factAuthority} AS fact_authority,
      eo.outcome, eo.evidence_url AS outcome_evidence_url,
      eo.source_record_id AS outcome_source_record_id, eo.observed_at AS outcome_observed_at,
      ${evidenceSourceColumns},
      COALESCE(rs.open_review_count, 0) AS open_review_count,
      COALESCE(rs.open_candidate_count, 0) AS open_candidate_count,
      rs.primary_review_id, ${sourceColumns}
    FROM products p
    ${factJoin}
    LEFT JOIN evidence_outcomes eo
      ON eo.product_id = p.id AND eo.field_family = '${family}'
    ${evidenceSourceJoin}
    LEFT JOIN review_summary rs ON rs.product_id = p.id
    ${sourceJoin}
    WHERE p.is_active = 1
  ), classified AS (
    SELECT j.*,
      CASE WHEN ${contradiction} THEN 1 ELSE 0 END AS contradiction,
      CASE
        WHEN ${contradiction} THEN 'outstanding'
        WHEN ${verified} THEN 'verified'
        WHEN ${terminal} THEN 'terminal_unavailable'
        ELSE 'outstanding'
      END AS completion_state
    FROM joined j
  ), ledger AS (
    SELECT c.*,
      CASE WHEN c.completion_state <> 'outstanding' THEN NULL
        WHEN c.contradiction = 1 THEN 'evidence_inconsistent'
        WHEN c.field_status = 'conflict' THEN 'conflict_resolution'
        WHEN c.open_candidate_count > 0 THEN 'review_ready'
        WHEN c.field_status = 'unverified' THEN 'structured_evidence_review'
        WHEN TRIM(COALESCE(c.label_url, '')) <> '' THEN 'label_evidence_review'
        ELSE 'source_evidence_needed'
      END AS lane,
      CASE WHEN c.outcome IN ('not_applicable', 'not_declared')
        THEN c.outcome ELSE NULL END AS terminal_outcome,
      CASE
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' THEN c.outcome_evidence_url
        WHEN c.outcome_source_record_id IS NOT NULL THEN c.outcome_source_url
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_source_url
        ELSE c.best_source_url
      END AS source_url,
      CASE
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' OR c.outcome_source_record_id IS NOT NULL
          THEN c.outcome_source_id
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_source_id
        ELSE c.best_source_id
      END AS source_id,
      CASE
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' OR c.outcome_source_record_id IS NOT NULL
          THEN c.outcome_source_record_id
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_source_record_id
        ELSE c.best_source_record_id
      END AS source_record_id,
      CASE
        WHEN TRIM(COALESCE(c.outcome_evidence_url, '')) <> '' OR c.outcome_source_record_id IS NOT NULL
          THEN c.outcome_observed_at
        WHEN c.fact_source_record_id IS NOT NULL THEN c.fact_observed_at
        ELSE c.best_source_observed_at
      END AS evidence_observed_at,
      CASE
        WHEN c.completion_state = 'outstanding' AND c.contradiction = 1 THEN 1
        WHEN c.completion_state = 'outstanding' AND c.field_status = 'conflict' THEN 2
        WHEN c.completion_state = 'outstanding' AND c.open_candidate_count > 0 THEN 3
        WHEN c.completion_state = 'outstanding' AND c.field_status = 'unverified' THEN 4
        WHEN c.completion_state = 'outstanding' AND TRIM(COALESCE(c.label_url, '')) <> '' THEN 5
        WHEN c.completion_state = 'outstanding' THEN 6
        WHEN c.completion_state = 'verified' THEN 7
        ELSE 8
      END AS lane_priority
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
    open_review_count, primary_review_id
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
      primaryReviewId: row.primary_review_id,
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

export const completionSummaryQuery = summarySql;
