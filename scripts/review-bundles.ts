import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  canonicalJson,
  nutritionCandidateFromEvidence,
  validateEvidenceDecision,
  type EvidenceDecisionInput,
} from "../shared/evidence-decisions";
import { normalizeGtin } from "../shared/gtin";

export interface ReviewDecisionManifest {
  schemaVersion: 1;
  bundleId: string;
  createdAt: string;
  decisionCount: number;
  verifyCount: number;
  rejectCount: number;
  sourceRecordCount: number;
  ledgerSha256: string;
}

export interface ReviewDecisionBundle {
  directory: string;
  manifest: ReviewDecisionManifest;
  decisions: EvidenceDecisionInput[];
  ledger: string;
}

export interface DecisionSourceRecord {
  sourceId: string;
  sourceRecordKey: string;
  sourceRecordId: string;
  contentHash: string;
  productId: string;
  productGtin: string | null;
}

export interface ReviewDecisionSqlPlan {
  outputPath: string;
  decisionCount: number;
  verifyCount: number;
  rejectCount: number;
  expectedResolvedCandidates: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sql(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot serialize a non-finite SQL number");
    return String(value);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${sha256Text(value).slice(0, 24)}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Decision ${field} is required`);
  return value;
}

function parseDecision(value: unknown): EvidenceDecisionInput {
  const input = record(value);
  if (!input) throw new Error("Decision record must be an object");
  const payloadRecord = record(input.payload);
  const payloadBarcode = typeof payloadRecord?.barcode === "string" ? payloadRecord.barcode : null;
  const payload = nutritionCandidateFromEvidence(
    { code: "robotoff_nutrition_candidate", details: { candidate: input.payload } },
    payloadBarcode,
  );
  if (!payload) throw new Error("Decision payload is not a valid nutrition candidate");
  const decision = input.decision === "verify" || input.decision === "reject" ? input.decision : null;
  if (!decision) throw new Error("Decision value is not supported");
  if (input.fieldFamily !== "nutrition") throw new Error("Decision fieldFamily is not supported");
  return {
    id: requiredString(input.id, "id"),
    sourceId: requiredString(input.sourceId, "sourceId"),
    sourceRecordKey: requiredString(input.sourceRecordKey, "sourceRecordKey"),
    sourceRecordId: requiredString(input.sourceRecordId, "sourceRecordId"),
    sourceContentHash: requiredString(input.sourceContentHash, "sourceContentHash"),
    productId: requiredString(input.productId, "productId"),
    candidateHash: requiredString(input.candidateHash, "candidateHash"),
    fieldFamily: "nutrition",
    decision,
    payload,
    evidenceUrl: requiredString(input.evidenceUrl, "evidenceUrl"),
    rationale: requiredString(input.rationale, "rationale"),
    decidedBy: requiredString(input.decidedBy, "decidedBy"),
    decidedAt: requiredString(input.decidedAt, "decidedAt"),
  };
}

export function evidenceDecisionFromDatabaseRow(row: Record<string, unknown>): EvidenceDecisionInput {
  if (typeof row.payload_json !== "string") throw new Error("Database decision payload_json is missing");
  return parseDecision({
    id: row.id,
    sourceId: row.source_id,
    sourceRecordKey: row.source_record_key,
    sourceRecordId: row.source_record_id,
    sourceContentHash: row.source_content_hash,
    productId: row.product_id,
    candidateHash: row.candidate_hash,
    fieldFamily: row.field_family,
    decision: row.decision,
    payload: JSON.parse(row.payload_json) as unknown,
    evidenceUrl: row.evidence_url,
    rationale: row.rationale,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  });
}

function parseManifest(value: unknown): ReviewDecisionManifest {
  const manifest = record(value);
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("Review bundle schemaVersion must be 1");
  const integer = (field: string): number => {
    const value = manifest[field];
    if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Review bundle ${field} must be a non-negative integer`);
    return value as number;
  };
  const createdAt = requiredString(manifest.createdAt, "manifest createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Review bundle createdAt is invalid");
  const ledgerSha256 = requiredString(manifest.ledgerSha256, "manifest ledgerSha256");
  if (!/^[a-f0-9]{64}$/.test(ledgerSha256)) throw new Error("Review bundle ledgerSha256 is invalid");
  return {
    schemaVersion: 1,
    bundleId: requiredString(manifest.bundleId, "manifest bundleId"),
    createdAt,
    decisionCount: integer("decisionCount"),
    verifyCount: integer("verifyCount"),
    rejectCount: integer("rejectCount"),
    sourceRecordCount: integer("sourceRecordCount"),
    ledgerSha256,
  };
}

function checksumEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) throw new Error(`Review checksum line is malformed: ${line}`);
    const path = match[2].replace(/^\.\//, "");
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`Review checksum path is not a safe portable relative path: ${match[2]}`);
    }
    if (entries.has(path)) throw new Error(`Review checksum path is duplicated: ${path}`);
    entries.set(path, match[1]);
  }
  return entries;
}

export async function writeReviewDecisionBundle(input: {
  decisions: EvidenceDecisionInput[];
  outputRoot: string;
  createdAt?: string;
}): Promise<ReviewDecisionBundle> {
  if (input.decisions.length === 0) throw new Error("Refusing to create an empty review decision bundle");
  const decisions = [...input.decisions].sort((left, right) => left.id.localeCompare(right.id));
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.id)) throw new Error(`Duplicate decision id: ${decision.id}`);
    seen.add(decision.id);
    const errors = await validateEvidenceDecision(decision);
    if (errors.length > 0) throw new Error(`Decision ${decision.id} is invalid: ${errors.join("; ")}`);
  }
  const ledger = `${decisions.map((decision) => canonicalJson(decision)).join("\n")}\n`;
  const ledgerSha256 = sha256Text(ledger);
  const bundleId = `review-${ledgerSha256.slice(0, 20)}`;
  const directory = join(input.outputRoot, bundleId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Bundle creation timestamp is invalid");
  const manifest: ReviewDecisionManifest = {
    schemaVersion: 1,
    bundleId,
    createdAt: new Date(createdAt).toISOString(),
    decisionCount: decisions.length,
    verifyCount: decisions.filter(({ decision }) => decision === "verify").length,
    rejectCount: decisions.filter(({ decision }) => decision === "reject").length,
    sourceRecordCount: new Set(decisions.map(({ sourceRecordId }) => sourceRecordId)).size,
    ledgerSha256,
  };
  await mkdir(directory, { recursive: true });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await Promise.all([
    writeFile(join(directory, "manifest.json"), manifestText, "utf8"),
    writeFile(join(directory, "decisions.jsonl"), ledger, "utf8"),
  ]);
  const checksums = `${sha256Text(ledger)}  decisions.jsonl\n${sha256Text(manifestText)}  manifest.json\n`;
  await writeFile(join(directory, "checksums.sha256"), checksums, "utf8");
  return { directory, manifest, decisions, ledger };
}

export async function readReviewDecisionBundle(directory: string): Promise<ReviewDecisionBundle> {
  const [manifestText, ledger, checksumsText] = await Promise.all([
    readFile(join(directory, "manifest.json"), "utf8"),
    readFile(join(directory, "decisions.jsonl"), "utf8"),
    readFile(join(directory, "checksums.sha256"), "utf8"),
  ]);
  const checksums = checksumEntries(checksumsText);
  for (const required of ["decisions.jsonl", "manifest.json"]) {
    if (!checksums.has(required)) throw new Error(`Review checksum is missing ${required}`);
  }
  if (checksums.size !== 2) throw new Error("Review checksum contains unexpected files");
  for (const [path, expected] of checksums) {
    if (await sha256File(join(directory, path)) !== expected) throw new Error(`Review checksum mismatch for ${path}`);
  }
  const manifest = parseManifest(JSON.parse(manifestText) as unknown);
  if (!ledger.endsWith("\n")) throw new Error("Review decision ledger must end with a newline");
  const lines = ledger.split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("Review decision ledger is empty");
  const decisions: EvidenceDecisionInput[] = [];
  const ids = new Set<string>();
  const candidateKeys = new Set<string>();
  for (const line of lines) {
    const parsed = parseDecision(JSON.parse(line) as unknown);
    const errors = await validateEvidenceDecision(parsed);
    if (errors.length > 0) throw new Error(`Decision ${parsed.id} is invalid: ${errors.join("; ")}`);
    if (canonicalJson(parsed) !== line) throw new Error(`Decision ${parsed.id} is not canonical JSON`);
    if (ids.has(parsed.id)) throw new Error(`Duplicate decision id: ${parsed.id}`);
    ids.add(parsed.id);
    const candidateKey = `${parsed.sourceId}\u0000${parsed.sourceRecordKey}\u0000${parsed.candidateHash}\u0000${parsed.fieldFamily}`;
    if (candidateKeys.has(candidateKey)) throw new Error(`Duplicate active candidate decision: ${parsed.id}`);
    candidateKeys.add(candidateKey);
    decisions.push(parsed);
  }
  const sortedIds = [...ids].sort();
  if (decisions.some((decision, index) => decision.id !== sortedIds[index])) throw new Error("Review decisions are not sorted by id");
  const ledgerSha256 = sha256Text(ledger);
  if (manifest.ledgerSha256 !== ledgerSha256) throw new Error("Review manifest ledger hash does not match decisions.jsonl");
  if (manifest.bundleId !== `review-${ledgerSha256.slice(0, 20)}`) throw new Error("Review bundle id does not match its ledger");
  const verifyCount = decisions.filter(({ decision }) => decision === "verify").length;
  if (
    manifest.decisionCount !== decisions.length || manifest.verifyCount !== verifyCount ||
    manifest.rejectCount !== decisions.length - verifyCount ||
    manifest.sourceRecordCount !== new Set(decisions.map(({ sourceRecordId }) => sourceRecordId)).size
  ) throw new Error("Review manifest counts do not reconcile with decisions.jsonl");
  return { directory, manifest, decisions, ledger };
}

export function validateReviewDecisionSources(bundle: ReviewDecisionBundle, sources: DecisionSourceRecord[]): void {
  const byId = new Map(sources.map((source) => [source.sourceRecordId, source]));
  for (const decision of bundle.decisions) {
    const source = byId.get(decision.sourceRecordId);
    if (!source) throw new Error(`Decision ${decision.id} source record is missing`);
    if (
      source.sourceId !== decision.sourceId || source.sourceRecordKey !== decision.sourceRecordKey ||
      source.contentHash !== decision.sourceContentHash || source.productId !== decision.productId
    ) throw new Error(`Decision ${decision.id} source evidence has drifted`);
    const sourceGtin = normalizeGtin(source.productGtin);
    if (!sourceGtin || sourceGtin !== normalizeGtin(decision.payload.barcode)) {
      throw new Error(`Decision ${decision.id} product GTIN does not match candidate evidence`);
    }
  }
}

export function validateExistingEvidenceDecisions(bundle: ReviewDecisionBundle, existing: EvidenceDecisionInput[]): void {
  const byId = new Map(existing.map((decision) => [decision.id, decision]));
  const byCandidate = new Map(existing.map((decision) => [
    `${decision.sourceId}\u0000${decision.sourceRecordKey}\u0000${decision.candidateHash}\u0000${decision.fieldFamily}`,
    decision,
  ]));
  for (const decision of bundle.decisions) {
    const sameId = byId.get(decision.id);
    if (sameId && canonicalJson(sameId) !== canonicalJson(decision)) {
      throw new Error(`Decision ${decision.id} conflicts with an existing decision id`);
    }
    const candidateKey = `${decision.sourceId}\u0000${decision.sourceRecordKey}\u0000${decision.candidateHash}\u0000${decision.fieldFamily}`;
    const sameCandidate = byCandidate.get(candidateKey);
    if (sameCandidate && canonicalJson(sameCandidate) !== canonicalJson(decision)) {
      throw new Error(`Decision ${decision.id} conflicts with an existing active candidate decision`);
    }
  }
}

export async function emitReviewDecisionSql(
  bundle: ReviewDecisionBundle,
  outputPath: string,
  includeTransaction = true,
): Promise<ReviewDecisionSqlPlan> {
  const statements: string[] = ["PRAGMA foreign_keys = ON;"];
  if (includeTransaction) statements.push("BEGIN IMMEDIATE;");
  const nutritionFields = [
    ["calories", "kcal"],
    ["proteinGrams", "g"],
    ["carbohydrateGrams", "g"],
    ["sugarGrams", "g"],
    ["fatGrams", "g"],
    ["saturatedFatGrams", "g"],
    ["fibreGrams", "g"],
    ["sodiumMg", "mg"],
  ] as const;
  for (const decision of bundle.decisions) {
    statements.push(`INSERT INTO evidence_decisions
      (id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
        candidate_hash, field_family, decision, payload_json, evidence_url, rationale,
        decided_by, decided_at, active)
      SELECT ${sql(decision.id)}, ${sql(decision.sourceId)}, ${sql(decision.sourceRecordKey)},
        ${sql(decision.sourceRecordId)}, ${sql(decision.sourceContentHash)}, ${sql(decision.productId)},
        ${sql(decision.candidateHash)}, 'nutrition', ${sql(decision.decision)},
        ${sql(canonicalJson(decision.payload))}, ${sql(decision.evidenceUrl)}, ${sql(decision.rationale)},
        ${sql(decision.decidedBy)}, ${sql(decision.decidedAt)}, 1
      WHERE NOT EXISTS (SELECT 1 FROM evidence_decisions WHERE id = ${sql(decision.id)});`);
    statements.push(`UPDATE review_items SET status = 'resolved',
      decision = ${sql(decision.decision === "verify" ? "verify_nutrition" : "reject_nutrition")},
      decision_rationale = ${sql(decision.rationale)}, decision_evidence_url = ${sql(decision.evidenceUrl)},
      decided_by = ${sql(decision.decidedBy)}, resolved_at = ${sql(decision.decidedAt)}
      WHERE source_record_id = ${sql(decision.sourceRecordId)} AND status = 'open'
        AND json_extract(evidence_json, '$.details.candidateHash') = ${sql(decision.candidateHash)};`);
    if (decision.decision !== "verify") continue;
    const nutrition = decision.payload.nutritionPer100g;
    statements.push(`INSERT INTO nutrition_facts
      (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
        calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
        fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
      VALUES (${sql(decision.productId)}, ${sql(decision.sourceRecordId)}, 'verified', 'high', 100,
        'per_100g', 'as_sold', ${sql(nutrition.calories)}, ${sql(nutrition.proteinGrams)},
        ${sql(nutrition.carbohydrateGrams)}, ${sql(nutrition.sugarGrams)}, ${sql(nutrition.fatGrams)},
        ${sql(nutrition.saturatedFatGrams)}, ${sql(nutrition.fibreGrams)}, ${sql(nutrition.sodiumMg)},
        ${sql(decision.decidedAt)}, ${sql(decision.payload.observedAt)}, ${sql(decision.decidedAt)})
      ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id,
        status = excluded.status, confidence = excluded.confidence, authority = excluded.authority,
        basis = excluded.basis, preparation_state = excluded.preparation_state,
        calories = excluded.calories, protein_grams = excluded.protein_grams,
        carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams,
        fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams,
        fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg,
        label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at,
        updated_at = excluded.updated_at;`);
    statements.push(`UPDATE field_observations SET selected = 0
      WHERE product_id = ${sql(decision.productId)} AND field_path LIKE 'nutrition.%';`);
    for (const [field, unit] of nutritionFields) {
      const value = nutrition[field];
      if (value === null) continue;
      const valueJson = JSON.stringify(value);
      const valueHash = `reviewed:${decision.candidateHash}:${field}`;
      statements.push(`INSERT INTO field_observations
        (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json,
          confidence, authority, observed_at, evidence_url, selected, value_hash)
        VALUES (${sql(stableId("obs", `${decision.id}:${field}`))}, ${sql(decision.productId)},
          ${sql(decision.sourceRecordId)}, ${sql(`nutrition.${field}`)}, ${sql(valueJson)}, ${sql(valueJson)},
          'high', 100, ${sql(decision.payload.observedAt)}, ${sql(decision.evidenceUrl)}, 1, ${sql(valueHash)})
        ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET
          product_id = excluded.product_id, confidence = excluded.confidence, authority = excluded.authority,
          observed_at = excluded.observed_at, evidence_url = excluded.evidence_url, selected = 1;`);
      statements.push(`INSERT INTO nutrient_values
        (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at)
        VALUES (${sql(stableId("nut", `${decision.id}:${field}`))}, ${sql(decision.productId)},
          ${sql(decision.sourceRecordId)}, ${sql(field)}, ${sql(value)}, ${sql(unit)}, 'per_100g',
          'as_sold', 'verified', ${sql(decision.payload.observedAt)})
        ON CONFLICT(source_record_id, nutrient_code, basis, preparation_state) DO UPDATE SET
          product_id = excluded.product_id, quantity = excluded.quantity, unit = excluded.unit,
          status = excluded.status, observed_at = excluded.observed_at;`);
    }
    statements.push(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url, observed_at,
        verified_at, decided_by, notes)
      VALUES (${sql(decision.productId)}, 'nutrition', 'verified', ${sql(decision.sourceRecordId)},
        ${sql(decision.evidenceUrl)}, ${sql(decision.payload.observedAt)}, ${sql(decision.decidedAt)},
        ${sql(decision.decidedBy)}, ${sql(decision.rationale)})
      ON CONFLICT(product_id, field_family) DO UPDATE SET outcome = excluded.outcome,
        source_record_id = excluded.source_record_id, evidence_url = excluded.evidence_url,
        observed_at = excluded.observed_at, verified_at = excluded.verified_at,
        decided_by = excluded.decided_by, notes = excluded.notes;`);
  }
  if (includeTransaction) statements.push("COMMIT;");
  const decisionIds = bundle.decisions.map(({ id }) => sql(id)).join(", ");
  const candidateHashes = bundle.decisions.map(({ candidateHash }) => sql(candidateHash)).join(", ");
  statements.push(`SELECT COUNT(*) AS applied_decisions FROM evidence_decisions WHERE id IN (${decisionIds}) AND active = 1;`);
  statements.push(`SELECT COUNT(*) AS unresolved_candidates FROM review_items WHERE status = 'open' AND json_extract(evidence_json, '$.details.candidateHash') IN (${candidateHashes});`);
  const portableStatements = statements.map((statement) => statement.replace(/\s+/g, " ").trim());
  await writeFile(outputPath, `${portableStatements.join("\n")}\n`, "utf8");
  return {
    outputPath,
    decisionCount: bundle.manifest.decisionCount,
    verifyCount: bundle.manifest.verifyCount,
    rejectCount: bundle.manifest.rejectCount,
    expectedResolvedCandidates: bundle.manifest.decisionCount,
  };
}
