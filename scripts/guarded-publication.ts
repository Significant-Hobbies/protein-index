import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../shared/evidence-decisions";
import type { ExtractionFieldFamily } from "../shared/extraction-outcomes";
import type { ReviewDecisionBundle, ReviewEvidenceDecision } from "./review-bundles";

export interface VerifiedProductState {
  fieldFamily: ExtractionFieldFamily;
  productIds: string[];
}

export interface GuardedSuccessorPublicationInput {
  fieldFamily: ExtractionFieldFamily;
  artifactSqlPath: string;
  successorSqlPath: string;
  outputPath: string;
  successor: ReviewDecisionBundle;
  before: {
    nutrition: VerifiedProductState;
    ingredients: VerifiedProductState;
  };
  expectedAfter: {
    nutrition: VerifiedProductState;
    ingredients: VerifiedProductState;
  };
  expectedDecisionCount: number;
  expectedVerifyCount: number;
}

function sql(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/g, "''")}'`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function d1Rows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Verified product state requires exactly one D1 result");
  const result = record(value[0]);
  if (!result || result.success !== true || !Array.isArray(result.results)) {
    throw new Error("Verified product state query failed or is malformed");
  }
  return result.results.map((row) => {
    const parsed = record(row);
    if (!parsed) throw new Error("Verified product state row is malformed");
    return parsed;
  });
}

function verifiedFactTable(fieldFamily: ExtractionFieldFamily): string {
  return fieldFamily === "nutrition" ? "nutrition_facts" : "ingredient_statements";
}

function verifiedProductQuery(fieldFamily: ExtractionFieldFamily): string {
  return `SELECT product_id FROM ${verifiedFactTable(fieldFamily)} WHERE status = 'verified' AND authority = 100 ORDER BY product_id;`;
}

export function verifiedProductStateQuery(fieldFamily: ExtractionFieldFamily): string {
  return verifiedProductQuery(fieldFamily);
}

export function parseVerifiedProductState(fieldFamily: ExtractionFieldFamily, value: unknown): VerifiedProductState {
  const productIds = d1Rows(value).map((row) => {
    const productId = row.product_id;
    if (typeof productId !== "string" || !/^prd_[a-f0-9]{24}$/.test(productId)) {
      throw new Error("Verified product state contains an invalid product identifier");
    }
    return productId;
  });
  if (new Set(productIds).size !== productIds.length || JSON.stringify(productIds) !== JSON.stringify([...productIds].sort())) {
    throw new Error("Verified product state must be sorted with one row per product");
  }
  return { fieldFamily, productIds };
}

export function expectedVerifiedProductState(bundle: ReviewDecisionBundle, fieldFamily: ExtractionFieldFamily): VerifiedProductState {
  if (bundle.decisions.length === 0 || bundle.decisions.some((decision) => decision.fieldFamily !== fieldFamily)) {
    throw new Error("Expected verified-product state requires a non-empty family-pure bundle");
  }
  const productIds = bundle.decisions
    .filter(({ decision }) => decision === "verify")
    .map(({ productId }) => productId)
    .sort();
  if (productIds.length !== bundle.manifest.verifyCount || productIds.length === 0 || new Set(productIds).size !== productIds.length) {
    throw new Error("Successor verify decisions do not form an exact non-empty product set");
  }
  return { fieldFamily, productIds };
}

export async function writeExpectedVerifiedProductState(
  bundle: ReviewDecisionBundle,
  fieldFamily: ExtractionFieldFamily,
  outputPath: string,
): Promise<VerifiedProductState> {
  const state = expectedVerifiedProductState(bundle, fieldFamily);
  await writeFile(outputPath, `${JSON.stringify([{ success: true, results: state.productIds.map((productId) => ({ product_id: productId })) }], null, 2)}\n`, "utf8");
  return state;
}

function assertState(state: VerifiedProductState, fieldFamily: ExtractionFieldFamily, name: string): void {
  if (state.fieldFamily !== fieldFamily || state.productIds.length === 0
    || new Set(state.productIds).size !== state.productIds.length
    || JSON.stringify(state.productIds) !== JSON.stringify([...state.productIds].sort())
    || !state.productIds.every((productId) => /^prd_[a-f0-9]{24}$/.test(productId))) {
    throw new Error(`${name} is not a canonical non-empty ${fieldFamily} verified product state`);
  }
}

function productSetQuery(productIds: readonly string[]): string {
  return productIds.map((productId, index) => (
    index === 0 ? `SELECT ${sql(productId)} AS product_id` : `UNION ALL SELECT ${sql(productId)}`
  )).join(" ");
}

function exactProductSetPredicate(state: VerifiedProductState): string {
  const actual = verifiedProductQuery(state.fieldFamily).replace(/;$/, "");
  const expected = productSetQuery(state.productIds);
  return `((SELECT COUNT(*) FROM (${actual})) = ${state.productIds.length} AND NOT EXISTS (SELECT product_id FROM (${actual}) EXCEPT SELECT product_id FROM (${expected})) AND NOT EXISTS (SELECT product_id FROM (${expected}) EXCEPT SELECT product_id FROM (${actual})))`;
}

function guard(label: string, predicate: string): string {
  return `INSERT INTO _guarded_successor_publication (ok, label) SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END, ${sql(label)};`;
}

function exactDecisionPredicate(decision: ReviewEvidenceDecision, alias: string): string {
  return [
    `${alias}.source_id = ${sql(decision.sourceId)}`,
    `${alias}.source_record_key = ${sql(decision.sourceRecordKey)}`,
    `${alias}.source_record_id = ${sql(decision.sourceRecordId)}`,
    `${alias}.source_content_hash = ${sql(decision.sourceContentHash)}`,
    `${alias}.product_id = ${sql(decision.productId)}`,
    `${alias}.candidate_hash = ${sql(decision.candidateHash)}`,
    `${alias}.field_family = ${sql(decision.fieldFamily)}`,
    `${alias}.decision = ${sql(decision.decision)}`,
    `${alias}.payload_json = ${sql(canonicalJson(decision.payload))}`,
    `${alias}.evidence_url = ${sql(decision.evidenceUrl)}`,
    `${alias}.rationale = ${sql(decision.rationale)}`,
    `${alias}.decided_by = ${sql(decision.decidedBy)}`,
    `${alias}.decided_at = ${sql(decision.decidedAt)}`,
    `${alias}.active = 1`,
    `${alias}.extraction_attempt_id IS ${sql(decision.extractionAttemptId ?? null)}`,
    `${alias}.label_asset_id IS ${sql(decision.labelAssetId ?? null)}`,
  ].join(" AND ");
}

function exactSourcePredicate(decision: ReviewEvidenceDecision): string {
  return `EXISTS (SELECT 1 FROM source_records source WHERE source.id = ${sql(decision.sourceRecordId)} AND source.source_id = ${sql(decision.sourceId)} AND source.source_record_id = ${sql(decision.sourceRecordKey)} AND source.content_hash = ${sql(decision.sourceContentHash)} AND source.product_id = ${sql(decision.productId)})`;
}

function activeDecisionSetPredicate(bundle: ReviewDecisionBundle): string {
  const ids = productSetQuery(bundle.decisions.map(({ id }) => id).sort()).replaceAll("product_id", "id");
  const sourceId = bundle.decisions[0]?.sourceId;
  const fieldFamily = bundle.decisions[0]?.fieldFamily;
  if (!sourceId || !fieldFamily) throw new Error("Successor bundle cannot be empty");
  return `((SELECT COUNT(*) FROM evidence_decisions active WHERE active.active = 1 AND active.source_id = ${sql(sourceId)} AND active.field_family = ${sql(fieldFamily)}) = ${bundle.decisions.length} AND NOT EXISTS (SELECT id FROM evidence_decisions active WHERE active.active = 1 AND active.source_id = ${sql(sourceId)} AND active.field_family = ${sql(fieldFamily)} EXCEPT SELECT id FROM (${ids})) AND NOT EXISTS (SELECT id FROM (${ids}) EXCEPT SELECT id FROM evidence_decisions active WHERE active.active = 1 AND active.source_id = ${sql(sourceId)} AND active.field_family = ${sql(fieldFamily)}))`;
}

function assertSqlFragment(fragment: string, name: string): void {
  if (!fragment.trim() || /\b(?:BEGIN(?:\s+IMMEDIATE)?|COMMIT|ROLLBACK|PRAGMA)\b/i.test(fragment)) {
    throw new Error(`${name} must be a non-empty transaction-free mutation fragment`);
  }
}

export async function emitGuardedSuccessorPublication(input: GuardedSuccessorPublicationInput): Promise<void> {
  const { successor } = input;
  if (successor.decisions.length !== input.expectedDecisionCount
    || successor.manifest.decisionCount !== input.expectedDecisionCount
    || successor.manifest.verifyCount !== input.expectedVerifyCount
    || successor.decisions.some((decision) => decision.fieldFamily !== input.fieldFamily)
    || new Set(successor.decisions.map(({ id }) => id)).size !== successor.decisions.length
    || new Set(successor.decisions.map(({ sourceId }) => sourceId)).size !== 1) {
    throw new Error("Successor bundle differs from the exact approved family/count accounting");
  }
  assertState(input.before.nutrition, "nutrition", "Nutrition pre-state");
  assertState(input.before.ingredients, "ingredients", "Ingredient pre-state");
  assertState(input.expectedAfter.nutrition, "nutrition", "Nutrition final state");
  assertState(input.expectedAfter.ingredients, "ingredients", "Ingredient final state");
  const verifiedProducts = expectedVerifiedProductState(successor, input.fieldFamily).productIds;
  const expectedFamilyState = input.fieldFamily === "nutrition"
    ? input.expectedAfter.nutrition.productIds
    : input.expectedAfter.ingredients.productIds;
  if (JSON.stringify(verifiedProducts) !== JSON.stringify(expectedFamilyState)) {
    throw new Error("Successor verify decisions do not exactly define the approved final verified product set");
  }
  const [artifactSql, successorSql] = await Promise.all([
    readFile(input.artifactSqlPath, "utf8"),
    readFile(input.successorSqlPath, "utf8"),
  ]);
  assertSqlFragment(artifactSql, "Artifact SQL");
  assertSqlFragment(successorSql, "Successor SQL");
  const sourceGuards = successor.decisions.map((decision) => guard(`source:${decision.id}`, exactSourcePredicate(decision)));
  const immutableGuards = successor.decisions.map((decision) => guard(
    `decision:${decision.id}`,
    `NOT EXISTS (SELECT 1 FROM evidence_decisions existing WHERE existing.id = ${sql(decision.id)} AND NOT (${exactDecisionPredicate(decision, "existing")}))`,
  ));
  const candidateGuards = successor.decisions.map((decision) => guard(
    `candidate:${decision.id}`,
    `NOT EXISTS (SELECT 1 FROM evidence_decisions active WHERE active.active = 1 AND active.source_id = ${sql(decision.sourceId)} AND active.source_record_key = ${sql(decision.sourceRecordKey)} AND active.candidate_hash = ${sql(decision.candidateHash)} AND active.field_family = ${sql(decision.fieldFamily)} AND active.id <> ${sql(decision.id)})`,
  ));
  const preOrRetry = `(${exactProductSetPredicate(input.before.nutrition)} AND ${exactProductSetPredicate(input.before.ingredients)}) OR (${exactProductSetPredicate(input.expectedAfter.nutrition)} AND ${exactProductSetPredicate(input.expectedAfter.ingredients)})`;
  const candidateHashes = successor.decisions.map(({ candidateHash }) => sql(candidateHash)).join(", ");
  const statements = [
    "PRAGMA foreign_keys = ON;",
    "DROP TABLE IF EXISTS temp._guarded_successor_publication;",
    "CREATE TEMP TABLE _guarded_successor_publication (ok INTEGER NOT NULL CHECK(ok = 1), label TEXT NOT NULL);",
    guard("pre_or_idempotent_state", preOrRetry),
    ...immutableGuards,
    artifactSql.trim(),
    ...sourceGuards,
    ...candidateGuards,
    successorSql.trim(),
    guard("active_successor_decisions", activeDecisionSetPredicate(successor)),
    guard("final_nutrition_set", exactProductSetPredicate(input.expectedAfter.nutrition)),
    guard("final_ingredient_set", exactProductSetPredicate(input.expectedAfter.ingredients)),
    guard("unresolved_successor_candidates", `NOT EXISTS (SELECT 1 FROM review_items WHERE status = 'open' AND json_extract(evidence_json, '$.details.candidateHash') IN (${candidateHashes}))`),
    "DROP TABLE _guarded_successor_publication;",
  ];
  await writeFile(input.outputPath, `${statements.join("\n")}\n`, "utf8");
}
