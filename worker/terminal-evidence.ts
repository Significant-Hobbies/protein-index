import {
  compareTerminalEvidenceReplay,
  validateTerminalEvidenceDecision,
  validateTerminalEvidenceSupersession,
  type RecordTerminalEvidenceInput,
  type RecordTerminalEvidenceResponse,
  type TerminalEvidenceBinding,
  type TerminalEvidenceDecisionInput,
  type TerminalEvidenceFieldFamily,
  type TerminalEvidenceHistoryEntry,
  type TerminalEvidenceOption,
  type TerminalEvidenceOptionsResponse,
} from "../shared/terminal-evidence";

interface OptionRow {
  evidence_id: string;
  evidence_kind: "source" | "label";
  source_id: string;
  source_name: string;
  source_record_id: string;
  source_record_key: string;
  source_content_hash: string;
  source_url: string;
  observed_at: string;
  authority: number;
  label_asset_id: string | null;
  label_content_sha256: string | null;
  label_url: string | null;
  label_fetched_at: string | null;
}

interface DecisionRow {
  id: string;
  idempotency_key: string;
  source_id: string;
  source_record_key: string;
  source_record_id: string;
  source_content_hash: string;
  product_id: string;
  field_family: TerminalEvidenceFieldFamily;
  outcome: "not_declared" | "not_applicable";
  evidence_kind: "source" | "label";
  label_asset_id: string | null;
  label_content_sha256: string | null;
  rationale: string;
  decided_by: string;
  decided_at: string;
  supersedes_decision_id: string | null;
}

interface CountRow { total: number }
interface HistoryRow extends DecisionRow {
  exact_binding: number;
  superseded: number;
}
interface OutcomeRow { outcome: "not_declared" | "not_applicable" }
interface FactStatusRow { status: "verified" | "conflict" }
interface LegacyProjectionRow { present: number }

const HISTORY_LIMIT = 100;

const OPTION_CTES = `WITH source_options AS (
  SELECT 'source:' || source_record.id AS evidence_id, 'source' AS evidence_kind,
    source_record.source_id, source.name AS source_name,
    source_record.id AS source_record_id,
    source_record.source_record_id AS source_record_key,
    source_record.content_hash AS source_content_hash,
    source_record.source_url,
    source_record.observed_at,
    CASE ? WHEN 'nutrition' THEN source.nutrition_authority
      ELSE source.ingredient_authority END AS authority,
    NULL AS label_asset_id, NULL AS label_content_sha256,
    NULL AS label_url, NULL AS label_fetched_at
  FROM source_records source_record
  JOIN sources source ON source.id = source_record.source_id
  JOIN products product ON product.id = source_record.product_id AND product.is_active = 1
  WHERE source_record.product_id = ?
    AND source_record.source_url LIKE 'https://%'
    AND length(source_record.content_hash) = 64
    AND source.kind IN ('official', 'brand')
    AND CASE ? WHEN 'nutrition' THEN source.nutrition_authority
      ELSE source.ingredient_authority END = 100
), label_options AS (
  SELECT 'label:' || label.id AS evidence_id, 'label' AS evidence_kind,
    source_record.source_id, source.name AS source_name,
    source_record.id AS source_record_id,
    source_record.source_record_id AS source_record_key,
    source_record.content_hash AS source_content_hash,
    COALESCE(source_record.source_url, label.effective_url) AS source_url,
    source_record.observed_at,
    CASE ? WHEN 'nutrition' THEN source.nutrition_authority
      ELSE source.ingredient_authority END AS authority,
    label.id AS label_asset_id, label.content_sha256 AS label_content_sha256,
    label.effective_url AS label_url, label.fetched_at AS label_fetched_at
  FROM current_label_evidence_assets label
  JOIN source_records source_record
    ON source_record.id = label.subject_source_record_id
   AND source_record.content_hash = label.subject_source_content_hash
   AND source_record.product_id = label.product_id
  JOIN sources source ON source.id = source_record.source_id
  JOIN products product ON product.id = label.product_id AND product.is_active = 1
  WHERE label.product_id = ? AND label.field_family = ?
), eligible AS (
  SELECT * FROM source_options
  UNION ALL
  SELECT * FROM label_options
)`;

function optionBindings(family: TerminalEvidenceFieldFamily, productId: string): string[] {
  return [family, productId, family, family, productId, family];
}

function optionFromRow(row: OptionRow): TerminalEvidenceOption {
  return {
    evidenceId: row.evidence_id,
    kind: row.evidence_kind,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceRecordId: row.source_record_id,
    sourceRecordKey: row.source_record_key,
    sourceContentHash: row.source_content_hash,
    sourceUrl: row.source_url,
    observedAt: row.observed_at,
    authority: row.authority,
    labelAssetId: row.label_asset_id,
    labelContentSha256: row.label_content_sha256,
    labelUrl: row.label_url,
    labelFetchedAt: row.label_fetched_at,
  };
}

function bindingFromOption(option: TerminalEvidenceOption, family: TerminalEvidenceFieldFamily): TerminalEvidenceBinding {
  const common = {
    sourceId: option.sourceId,
    sourceRecordKey: option.sourceRecordKey,
    sourceRecordId: option.sourceRecordId,
    sourceContentHash: option.sourceContentHash,
    productId: "",
    fieldFamily: family,
  };
  return option.kind === "label"
    ? {
      kind: "label",
      ...common,
      labelAssetId: option.labelAssetId ?? "",
      labelContentSha256: option.labelContentSha256 ?? "",
    }
    : { kind: "source", ...common };
}

function decisionFromRow(row: DecisionRow): TerminalEvidenceDecisionInput {
  const common = {
    sourceId: row.source_id,
    sourceRecordKey: row.source_record_key,
    sourceRecordId: row.source_record_id,
    sourceContentHash: row.source_content_hash,
    productId: row.product_id,
    fieldFamily: row.field_family,
  };
  const evidence: TerminalEvidenceBinding = row.evidence_kind === "label"
    ? {
      kind: "label",
      ...common,
      labelAssetId: row.label_asset_id ?? "",
      labelContentSha256: row.label_content_sha256 ?? "",
    }
    : { kind: "source", ...common };
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    outcome: row.outcome,
    evidence,
    rationale: row.rationale,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    supersedesDecisionId: row.supersedes_decision_id,
  };
}

const DECISION_COLUMNS = [
  "id", "idempotency_key", "source_id", "source_record_key", "source_record_id",
  "source_content_hash", "product_id", "field_family", "outcome", "evidence_kind",
  "label_asset_id", "label_content_sha256", "rationale", "decided_by", "decided_at",
  "supersedes_decision_id",
] as const;
const DECISION_SELECT = `SELECT ${DECISION_COLUMNS.join(", ")} FROM terminal_evidence_decisions`;

export function validateTerminalEvidenceList(input: URLSearchParams): {
  value?: { family: TerminalEvidenceFieldFamily; page: number; pageSize: number };
  error?: string;
} {
  const family = input.get("family");
  const page = Number(input.get("page") ?? 1);
  const pageSize = Number(input.get("pageSize") ?? 25);
  if (family !== "nutrition" && family !== "ingredients") return { error: "A valid evidence family is required" };
  if (!Number.isInteger(page) || page < 1) return { error: "Page must be a positive integer" };
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    return { error: "Page size must be between 1 and 100" };
  }
  return { value: { family, page, pageSize } };
}

export async function listTerminalEvidence(
  db: D1Database,
  productId: string,
  input: { family: TerminalEvidenceFieldFamily; page: number; pageSize: number },
): Promise<TerminalEvidenceOptionsResponse | null> {
  const product = await db.prepare("SELECT id FROM products WHERE id = ? AND is_active = 1")
    .bind(productId).first<{ id: string }>();
  if (!product) return null;
  const offset = (input.page - 1) * input.pageSize;
  const bindings = optionBindings(input.family, productId);
  const factTable = input.family === "nutrition" ? "nutrition_facts" : "ingredient_statements";
  const [count, page, historyResult, currentOutcomeResult, factResult, legacyResult] = await db.batch([
    db.prepare(`${OPTION_CTES} SELECT COUNT(*) AS total FROM eligible`).bind(...bindings),
    db.prepare(`${OPTION_CTES} SELECT * FROM eligible
      ORDER BY authority DESC, observed_at DESC, evidence_kind DESC, evidence_id
      LIMIT ? OFFSET ?`).bind(...bindings, input.pageSize, offset),
    db.prepare(`SELECT ${DECISION_COLUMNS.map((column) => `decision.${column}`).join(", ")},
      CASE WHEN exact_source.id IS NOT NULL AND (
        (decision.evidence_kind = 'source' AND exact_source.source_url LIKE 'https://%') OR
        (decision.evidence_kind = 'label' AND exact_label.id IS NOT NULL)
      ) THEN 1 ELSE 0 END AS exact_binding,
      CASE WHEN EXISTS (
        SELECT 1 FROM terminal_evidence_decisions child
        WHERE child.supersedes_decision_id = decision.id
      ) THEN 1 ELSE 0 END AS superseded
      FROM terminal_evidence_decisions decision
      LEFT JOIN source_records exact_source
        ON exact_source.id = decision.source_record_id
       AND exact_source.source_id = decision.source_id
       AND exact_source.source_record_id = decision.source_record_key
       AND exact_source.content_hash = decision.source_content_hash
       AND exact_source.product_id = decision.product_id
      LEFT JOIN current_label_evidence_assets exact_label
        ON decision.evidence_kind = 'label'
       AND exact_label.id = decision.label_asset_id
       AND exact_label.subject_source_record_id = decision.source_record_id
       AND exact_label.subject_source_content_hash = decision.source_content_hash
       AND exact_label.product_id = decision.product_id
       AND exact_label.field_family = decision.field_family
       AND exact_label.content_sha256 = decision.label_content_sha256
      WHERE decision.product_id = ? AND decision.field_family = ?
      ORDER BY decision.decided_at DESC, decision.id DESC LIMIT ?`)
      .bind(productId, input.family, HISTORY_LIMIT + 1),
    db.prepare(`SELECT DISTINCT outcome FROM current_terminal_evidence_decisions
      WHERE product_id = ? AND field_family = ? ORDER BY outcome`).bind(productId, input.family),
    db.prepare(`SELECT status FROM ${factTable}
      WHERE product_id = ? AND status IN ('verified', 'conflict') LIMIT 1`).bind(productId),
    db.prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM evidence_outcomes
      WHERE product_id = ? AND field_family = ?
        AND outcome IN ('not_declared', 'not_applicable')
        AND decided_by <> 'terminal_evidence_projection'
    ) THEN 1 ELSE 0 END AS present`).bind(productId, input.family),
  ]);
  const total = (count?.results[0] as CountRow | undefined)?.total ?? 0;
  const historyRows = (historyResult?.results ?? []) as unknown as HistoryRow[];
  const history: TerminalEvidenceHistoryEntry[] = historyRows.slice(0, HISTORY_LIMIT).map((row) => ({
    decision: decisionFromRow(row),
    current: row.exact_binding === 1 && row.superseded === 0,
    stale: row.exact_binding !== 1,
    superseded: row.superseded === 1,
  }));
  const outcomes = (currentOutcomeResult?.results ?? []).map(
    (row) => (row as unknown as OutcomeRow).outcome,
  );
  const factStatus = (factResult?.results[0] as FactStatusRow | undefined)?.status ?? null;
  const legacyProjection = (legacyResult?.results[0] as LegacyProjectionRow | undefined)?.present === 1;
  return {
    productId,
    family: input.family,
    items: (page?.results ?? []).map((row) => optionFromRow(row as unknown as OptionRow)),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      pages: Math.ceil(total / input.pageSize),
    },
    history,
    historyTruncated: historyRows.length > HISTORY_LIMIT,
    contradiction: {
      hasConflict: outcomes.length > 1 || (outcomes.length > 0 && factStatus !== null) || legacyProjection,
      outcomes,
      factStatus,
      legacyProjection,
    },
  };
}

function validateRecordInput(value: unknown): { value?: RecordTerminalEvidenceInput; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["Expected a JSON object"] };
  }
  const input = value as Record<string, unknown>;
  const allowed = [
    "family", "outcome", "evidenceId", "sourceContentHash", "labelContentSha256",
    "idempotencyKey", "rationale", "supersedesDecisionId",
  ];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) errors.push(`${key} is not supported`);
  }
  if (input.family !== "nutrition" && input.family !== "ingredients") errors.push("family is not supported");
  if (input.outcome !== "not_declared" && input.outcome !== "not_applicable") errors.push("outcome is not supported");
  if (typeof input.evidenceId !== "string" || !/^(source|label):[^\s:]{1,512}$/.test(input.evidenceId)) {
    errors.push("evidenceId is invalid");
  }
  if (typeof input.sourceContentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.sourceContentHash)) {
    errors.push("sourceContentHash must be a lowercase SHA-256 digest");
  }
  if (input.labelContentSha256 !== null && (
    typeof input.labelContentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.labelContentSha256)
  )) errors.push("labelContentSha256 must be null or a lowercase SHA-256 digest");
  if (typeof input.idempotencyKey !== "string") errors.push("idempotencyKey is required");
  if (typeof input.rationale !== "string") errors.push("rationale is required");
  if (input.supersedesDecisionId !== null && typeof input.supersedesDecisionId !== "string") {
    errors.push("supersedesDecisionId must be null or a string");
  }
  if (errors.length) return { errors };
  return { value: input as unknown as RecordTerminalEvidenceInput, errors };
}

async function stableDecisionId(idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`terminal-evidence:${idempotencyKey}`),
  );
  return `ted_${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`;
}

async function exactOption(
  db: D1Database,
  productId: string,
  family: TerminalEvidenceFieldFamily,
  evidenceId: string,
): Promise<TerminalEvidenceOption | null> {
  const row = await db.prepare(`${OPTION_CTES} SELECT * FROM eligible WHERE evidence_id = ? LIMIT 1`)
    .bind(...optionBindings(family, productId), evidenceId)
    .first<OptionRow>();
  return row ? optionFromRow(row) : null;
}

export type RecordTerminalEvidenceResult = RecordTerminalEvidenceResponse | {
  error: "validation_error" | "not_found" | "stale_evidence" | "conflict";
  message: string;
  details?: Record<string, unknown>;
};

export async function recordTerminalEvidence(
  db: D1Database,
  productId: string,
  rawInput: unknown,
): Promise<RecordTerminalEvidenceResult> {
  const parsed = validateRecordInput(rawInput);
  if (!parsed.value) return { error: "validation_error", message: parsed.errors.join("; ") };
  const input = parsed.value;
  const option = await exactOption(db, productId, input.family, input.evidenceId);
  if (!option) return { error: "not_found", message: "Evidence option is not current for this product and family" };
  if (
    option.sourceContentHash !== input.sourceContentHash ||
    option.labelContentSha256 !== input.labelContentSha256
  ) {
    return {
      error: "stale_evidence",
      message: "Evidence changed after it was selected",
      details: { evidenceId: input.evidenceId },
    };
  }

  const evidence = bindingFromOption(option, input.family);
  evidence.productId = productId;
  const candidate: TerminalEvidenceDecisionInput = {
    id: await stableDecisionId(input.idempotencyKey),
    idempotencyKey: input.idempotencyKey,
    outcome: input.outcome,
    evidence,
    rationale: input.rationale.trim(),
    decidedBy: "local_operator",
    decidedAt: new Date().toISOString(),
    supersedesDecisionId: input.supersedesDecisionId,
  };
  const validationErrors = validateTerminalEvidenceDecision(candidate);
  if (validationErrors.length) return { error: "validation_error", message: validationErrors.join("; ") };

  const existingRow = await db.prepare(`${DECISION_SELECT}
    WHERE id = ? OR idempotency_key = ? ORDER BY idempotency_key = ? DESC LIMIT 1`)
    .bind(candidate.id, candidate.idempotencyKey, candidate.idempotencyKey)
    .first<DecisionRow>();
  if (existingRow) {
    const existing = decisionFromRow(existingRow);
    return compareTerminalEvidenceReplay(candidate, existing) === "replay"
      ? { status: "existing", decision: existing }
      : { error: "conflict", message: "Idempotency identity conflicts with an existing decision" };
  }

  if (candidate.supersedesDecisionId) {
    const [previousRow, successorRow] = await Promise.all([
      db.prepare(`${DECISION_SELECT} WHERE id = ?`).bind(candidate.supersedesDecisionId).first<DecisionRow>(),
      db.prepare(`${DECISION_SELECT} WHERE supersedes_decision_id = ?`)
        .bind(candidate.supersedesDecisionId).first<DecisionRow>(),
    ]);
    if (!previousRow) return { error: "conflict", message: "Superseded decision does not exist" };
    const supersessionErrors = validateTerminalEvidenceSupersession(
      candidate,
      decisionFromRow(previousRow),
      successorRow ? decisionFromRow(successorRow) : null,
    );
    if (supersessionErrors.length) return { error: "conflict", message: supersessionErrors.join("; ") };
  }

  try {
    await db.prepare(`INSERT OR IGNORE INTO terminal_evidence_decisions
      (id, idempotency_key, source_id, source_record_key, source_record_id,
       source_content_hash, product_id, field_family, outcome, evidence_kind,
       label_asset_id, label_content_sha256, rationale, decided_by, decided_at,
       supersedes_decision_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        candidate.id,
        candidate.idempotencyKey,
        evidence.sourceId,
        evidence.sourceRecordKey,
        evidence.sourceRecordId,
        evidence.sourceContentHash,
        evidence.productId,
        evidence.fieldFamily,
        candidate.outcome,
        evidence.kind,
        evidence.kind === "label" ? evidence.labelAssetId : null,
        evidence.kind === "label" ? evidence.labelContentSha256 : null,
        candidate.rationale,
        candidate.decidedBy,
        candidate.decidedAt,
        candidate.supersedesDecisionId,
      ).run();
  } catch (error) {
    return {
      error: "conflict",
      message: error instanceof Error ? error.message : "Evidence decision could not be recorded",
    };
  }

  const insertedRow = await db.prepare(`${DECISION_SELECT} WHERE id = ? OR idempotency_key = ? LIMIT 1`)
    .bind(candidate.id, candidate.idempotencyKey).first<DecisionRow>();
  if (!insertedRow) return { error: "conflict", message: "A competing evidence decision won the write" };
  const inserted = decisionFromRow(insertedRow);
  if (compareTerminalEvidenceReplay(candidate, inserted) !== "replay") {
    return { error: "conflict", message: "A competing evidence decision won the write" };
  }
  return { status: inserted.decidedAt === candidate.decidedAt ? "created" : "existing", decision: inserted };
}
