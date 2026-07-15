import type { ReviewItem, ReviewResponse } from "../shared/api";
import { normalizeGtin } from "../shared/gtin";
import { hasNutritionErrors, validateNutrition } from "../shared/nutrition";
import type { NutritionPer100g } from "../shared/types";

interface ReviewRow {
  id: string;
  type: string;
  priority: number;
  status: string;
  product_id: string | null;
  product_name: string | null;
  brand: string | null;
  source_record_id: string | null;
  candidate_product_ids_json: string;
  candidates_json: string;
  evidence_json: string;
  created_at: string;
  decision: string | null;
  decision_rationale: string | null;
  decision_evidence_url: string | null;
  decided_by: string | null;
}

interface ReviewCountRow { status: "open" | "resolved" | "dismissed"; count: number }

function parsed(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

interface RobotoffCandidate {
  predictionId: string;
  barcode: string;
  imageId: string;
  imageUrl: string;
  modelName: string;
  modelVersion: string;
  observedAt: string;
  minimumConfidence: number;
  nutritionPer100g: NutritionPer100g;
}

const NUTRITION_FIELDS = [
  ["calories", "calories", "kcal"],
  ["proteinGrams", "protein_grams", "g"],
  ["carbohydrateGrams", "carbohydrate_grams", "g"],
  ["sugarGrams", "sugar_grams", "g"],
  ["fatGrams", "fat_grams", "g"],
  ["saturatedFatGrams", "saturated_fat_grams", "g"],
  ["fibreGrams", "fibre_grams", "g"],
  ["sodiumMg", "sodium_mg", "mg"],
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function robotoffCandidate(evidenceJson: string, productGtin: string | null): RobotoffCandidate | null {
  const evidence = record(parsed(evidenceJson));
  if (evidence?.code !== "robotoff_nutrition_candidate") return null;
  const candidate = record(record(evidence.details)?.candidate);
  const nutrition = record(candidate?.nutritionPer100g);
  if (!candidate || !nutrition) return null;
  const normalized = Object.fromEntries(NUTRITION_FIELDS.map(([field]) => {
    const value = nutrition[field];
    return [field, value === null || (typeof value === "number" && Number.isFinite(value)) ? value : Number.NaN];
  })) as unknown as NutritionPer100g;
  const observedAt = typeof candidate.observedAt === "string" ? new Date(candidate.observedAt) : new Date(Number.NaN);
  const barcode = typeof candidate.barcode === "string" ? normalizeGtin(candidate.barcode) : null;
  if (
    typeof candidate.predictionId !== "string" || !candidate.predictionId ||
    typeof candidate.imageId !== "string" || !candidate.imageId ||
    !validHttpsUrl(candidate.imageUrl) ||
    typeof candidate.modelName !== "string" || !candidate.modelName.startsWith("nutrition_extractor") ||
    typeof candidate.modelVersion !== "string" || !candidate.modelVersion ||
    !Number.isFinite(observedAt.valueOf()) ||
    typeof candidate.minimumConfidence !== "number" || candidate.minimumConfidence < 0.85 || candidate.minimumConfidence > 1 ||
    !barcode || barcode !== productGtin ||
    normalized.calories === null || normalized.proteinGrams === null ||
    hasNutritionErrors(validateNutrition(normalized))
  ) return null;
  return {
    predictionId: candidate.predictionId,
    barcode,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    observedAt: observedAt.toISOString(),
    minimumConfidence: candidate.minimumConfidence,
    nutritionPer100g: normalized,
  };
}

export async function listReviews(db: D1Database, status: string, limit: number): Promise<ReviewResponse> {
  const batch = await db.batch([
    db.prepare(`SELECT r.id, r.type, r.priority, r.status, r.product_id, p.name AS product_name, p.brand,
      r.source_record_id, r.candidate_product_ids_json, r.evidence_json, r.created_at, r.decision, r.decision_rationale,
      r.decision_evidence_url, r.decided_by,
      COALESCE((SELECT json_group_array(json_object(
        'id', candidate.id,
        'gtin', candidate.gtin,
        'brand', candidate.brand,
        'name', candidate.name,
        'flavour', candidate.flavour,
        'netQuantityGrams', candidate.net_quantity_grams,
        'category', candidate.category
      )) FROM json_each(r.candidate_product_ids_json) listed
      JOIN products candidate ON candidate.id = listed.value), '[]') AS candidates_json
      FROM review_items r LEFT JOIN products p ON p.id = r.product_id
      WHERE r.status = ? ORDER BY r.priority DESC, r.created_at LIMIT ?`).bind(status, limit),
    db.prepare("SELECT status, COUNT(*) AS count FROM review_items GROUP BY status"),
  ]);
  const itemsResult = batch[0];
  const countsResult = batch[1];
  if (!itemsResult || !countsResult) throw new Error("Review query batch returned an incomplete result");
  const items = (itemsResult.results as ReviewRow[]).map<ReviewItem>((row) => ({
    id: row.id,
    type: row.type,
    priority: row.priority,
    status: row.status,
    productId: row.product_id,
    productName: row.product_name,
    brand: row.brand,
    sourceRecordId: row.source_record_id,
    candidateProductIds: parsed(row.candidate_product_ids_json) as string[] ?? [],
    candidates: parsed(row.candidates_json) as ReviewItem["candidates"] ?? [],
    evidence: parsed(row.evidence_json),
    createdAt: row.created_at,
    decision: row.decision,
    rationale: row.decision_rationale,
    decisionEvidenceUrl: row.decision_evidence_url,
    decidedBy: row.decided_by,
  }));
  const counts = { open: 0, resolved: 0, dismissed: 0 };
  for (const row of countsResult.results as ReviewCountRow[]) counts[row.status] = row.count;
  return { items, counts };
}

export type ReviewDecision = "verify_nutrition" | "reject_nutrition" | "dismiss" | "match" | "create_new" | "no_match";

export async function resolveReview(
  db: D1Database,
  id: string,
  decision: ReviewDecision,
  rationale: string,
  evidenceUrl: string | null,
  candidateProductId: string | null,
): Promise<"resolved" | "not_found" | "conflict" | "invalid_decision" | "invalid_candidate"> {
  const review = await db.prepare(`SELECT r.id, r.status, r.product_id, r.type, r.candidate_product_ids_json,
    r.source_record_id, r.evidence_json, s.source_id, s.source_record_id AS source_record_key, s.identity_hash,
    p.gtin AS product_gtin, nf.product_id AS nutrition_product_id
    FROM review_items r
    LEFT JOIN source_records s ON s.id = r.source_record_id
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN nutrition_facts nf ON nf.product_id = r.product_id
    WHERE r.id = ?`).bind(id).first<{
    id: string;
    status: string;
    product_id: string | null;
    type: string;
    candidate_product_ids_json: string;
    source_record_id: string | null;
    evidence_json: string;
    source_id: string | null;
    source_record_key: string | null;
    identity_hash: string | null;
    product_gtin: string | null;
    nutrition_product_id: string | null;
  }>();
  if (!review) return "not_found";
  if (review.status !== "open") return "conflict";
  const nutritionReview = ["nutrition_validation", "nutrition_conflict", "coverage_gap"].includes(review.type);
  if (["verify_nutrition", "reject_nutrition"].includes(decision) && !nutritionReview) return "invalid_decision";
  const identityReview = review.type === "identity";
  if (["match", "create_new", "no_match"].includes(decision) && !identityReview) return "invalid_decision";
  if (identityReview && !["match", "create_new", "no_match", "dismiss"].includes(decision)) return "invalid_decision";
  const candidateIds = parsed(review.candidate_product_ids_json);
  if (decision === "match" && (
    !candidateProductId ||
    !Array.isArray(candidateIds) ||
    !candidateIds.includes(candidateProductId)
  )) return "invalid_candidate";
  if (decision !== "match" && candidateProductId !== null) return "invalid_candidate";
  if (identityReview && decision !== "dismiss" && (
    !review.product_id ||
    !review.source_record_id ||
    !review.source_id ||
    !review.source_record_key ||
    !review.identity_hash
  )) return "invalid_decision";
  const candidate = review.source_id === "open_food_facts_robotoff"
    ? robotoffCandidate(review.evidence_json, review.product_gtin)
    : null;
  if (decision === "verify_nutrition" && review.source_id === "open_food_facts_robotoff" && !candidate) return "invalid_candidate";
  if (decision === "verify_nutrition" && !candidate && !review.nutrition_product_id) return "invalid_decision";
  const status = decision === "dismiss" ? "dismissed" : "resolved";
  const decidedAt = new Date().toISOString();
  const statements = [
    db.prepare("UPDATE review_items SET status = ?, decision = ?, decision_rationale = ?, decision_evidence_url = ?, decided_by = 'local_operator', resolved_at = ? WHERE id = ? AND status = 'open'")
      .bind(status, decision, rationale, evidenceUrl, decidedAt, id),
  ];
  if (review.product_id && review.source_record_id && decision === "verify_nutrition" && candidate) {
    const nutrition = candidate.nutritionPer100g;
    statements.push(db.prepare(`INSERT INTO nutrition_facts
      (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
        calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
        fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
      VALUES (?, ?, 'verified', 'high', 100, 'per_100g', 'as_sold', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_id) DO UPDATE SET
        source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence,
        authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state,
        calories = excluded.calories, protein_grams = excluded.protein_grams,
        carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams,
        fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams,
        fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg,
        label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at,
        updated_at = excluded.updated_at`)
      .bind(review.product_id, review.source_record_id, nutrition.calories, nutrition.proteinGrams,
        nutrition.carbohydrateGrams, nutrition.sugarGrams, nutrition.fatGrams,
        nutrition.saturatedFatGrams, nutrition.fibreGrams, nutrition.sodiumMg,
        decidedAt, candidate.observedAt, decidedAt));
    statements.push(db.prepare("UPDATE field_observations SET selected = 0 WHERE product_id = ? AND field_path LIKE 'nutrition.%'")
      .bind(review.product_id));
    for (const [field, column, unit] of NUTRITION_FIELDS) {
      const value = nutrition[field];
      if (value === null) continue;
      const observationId = `obs_review_${id}_${column}`;
      const valueJson = JSON.stringify(value);
      statements.push(db.prepare(`INSERT INTO field_observations
        (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json,
          confidence, authority, observed_at, evidence_url, selected, value_hash)
        VALUES (?, ?, ?, ?, ?, ?, 'high', 100, ?, ?, 1, ?)
        ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET
          product_id = excluded.product_id, confidence = excluded.confidence, authority = excluded.authority,
          observed_at = excluded.observed_at, evidence_url = excluded.evidence_url, selected = 1`)
        .bind(observationId, review.product_id, review.source_record_id, `nutrition.${field}`,
          valueJson, valueJson, candidate.observedAt, candidate.imageUrl, `review:${id}:${column}:${valueJson}`));
      statements.push(db.prepare(`INSERT INTO nutrient_values
        (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'per_100g', 'as_sold', 'verified', ?)
        ON CONFLICT(source_record_id, nutrient_code, basis, preparation_state) DO UPDATE SET
          product_id = excluded.product_id, quantity = excluded.quantity, unit = excluded.unit,
          status = excluded.status, observed_at = excluded.observed_at`)
        .bind(`ntr_review_${id}_${column}`, review.product_id, review.source_record_id, field, value, unit, candidate.observedAt));
    }
    statements.push(db.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes)
      VALUES (?, 'nutrition', 'verified', ?, ?, ?, ?, 'local_operator', ?)
      ON CONFLICT(product_id, field_family) DO UPDATE SET
        outcome = excluded.outcome, source_record_id = excluded.source_record_id,
        evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
        verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes`)
      .bind(review.product_id, review.source_record_id, evidenceUrl ?? candidate.imageUrl,
        candidate.observedAt, decidedAt,
        `${rationale} [Robotoff ${candidate.modelName} ${candidate.modelVersion}; prediction ${candidate.predictionId}; image ${candidate.imageId}]`));
  } else if (review.product_id && decision === "verify_nutrition") {
    statements.push(db.prepare("UPDATE nutrition_facts SET status = 'verified', confidence = 'high', label_verified_at = ?, updated_at = ? WHERE product_id = ?")
      .bind(decidedAt, decidedAt, review.product_id));
    statements.push(db.prepare(`INSERT INTO evidence_outcomes
      (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes)
      SELECT ?, 'nutrition', 'verified', ?, ?, observed_at, ?, 'local_operator', ?
      FROM nutrition_facts WHERE product_id = ?
      ON CONFLICT(product_id, field_family) DO UPDATE SET
        outcome = excluded.outcome, source_record_id = excluded.source_record_id,
        evidence_url = excluded.evidence_url, observed_at = excluded.observed_at,
        verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes`)
      .bind(review.product_id, review.source_record_id, evidenceUrl, decidedAt, rationale, review.product_id));
  }
  if (review.product_id && decision === "reject_nutrition" && review.source_id !== "open_food_facts_robotoff") {
    statements.push(db.prepare(`UPDATE nutrition_facts SET status = 'missing', confidence = 'low',
      calories = NULL, protein_grams = NULL, carbohydrate_grams = NULL, sugar_grams = NULL,
      fat_grams = NULL, saturated_fat_grams = NULL, fibre_grams = NULL, sodium_mg = NULL,
      label_verified_at = NULL, updated_at = ? WHERE product_id = ?`)
      .bind(decidedAt, review.product_id));
    statements.push(db.prepare("UPDATE field_observations SET selected = 0 WHERE product_id = ? AND field_path LIKE 'nutrition.%'")
      .bind(review.product_id));
  }
  if (identityReview && decision !== "dismiss" && review.product_id && review.source_record_id && review.source_id && review.source_record_key && review.identity_hash) {
    const targetProductId = decision === "match" ? candidateProductId : decision === "create_new" ? review.product_id : null;
    statements.push(db.prepare(`INSERT INTO identity_decisions
      (id, source_id, source_record_key, source_record_id, identity_hash, decision, target_product_id, rationale, decided_by, decided_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'local_operator', ?, 1)
      ON CONFLICT(source_id, source_record_key, identity_hash) DO UPDATE SET
        source_record_id = excluded.source_record_id, decision = excluded.decision,
        target_product_id = excluded.target_product_id, rationale = excluded.rationale,
        decided_by = excluded.decided_by, decided_at = excluded.decided_at, active = 1`)
      .bind(`idn_${id}`, review.source_id, review.source_record_key, review.source_record_id, review.identity_hash, decision, targetProductId, rationale, decidedAt));
    statements.push(db.prepare("UPDATE source_records SET product_id = ?, resolution_rule = ? WHERE id = ?")
      .bind(targetProductId, `manual_${decision}`, review.source_record_id));
    if (decision === "match" && targetProductId) {
      statements.push(db.prepare(`INSERT INTO nutrition_facts
        (product_id, source_record_id, status, confidence, authority, basis, preparation_state,
          calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
          fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at)
        SELECT ?, source_record_id, status, confidence, authority, basis, preparation_state,
          calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams,
          fibre_grams, sodium_mg, label_verified_at, observed_at, ?
        FROM nutrition_facts WHERE product_id = ?
        ON CONFLICT(product_id) DO UPDATE SET
          source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence,
          authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state,
          calories = excluded.calories, protein_grams = excluded.protein_grams,
          carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams,
          fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams,
          fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg,
          label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at,
          updated_at = excluded.updated_at
        WHERE excluded.authority > nutrition_facts.authority OR
          (excluded.authority = nutrition_facts.authority AND excluded.observed_at > nutrition_facts.observed_at)`)
        .bind(targetProductId, decidedAt, review.product_id));
      statements.push(db.prepare(`INSERT INTO ingredient_statements
        (product_id, source_record_id, raw_text, language, status, confidence, authority, observed_at, updated_at)
        SELECT ?, source_record_id, raw_text, language, status, confidence, authority, observed_at, ?
        FROM ingredient_statements WHERE product_id = ?
        ON CONFLICT(product_id) DO UPDATE SET
          source_record_id = excluded.source_record_id, raw_text = excluded.raw_text, language = excluded.language,
          status = excluded.status, confidence = excluded.confidence, authority = excluded.authority,
          observed_at = excluded.observed_at, updated_at = excluded.updated_at
        WHERE excluded.authority > ingredient_statements.authority OR
          (excluded.authority = ingredient_statements.authority AND excluded.observed_at > ingredient_statements.observed_at)`)
        .bind(targetProductId, decidedAt, review.product_id));
      for (const table of ["nutrient_values", "product_ingredients", "product_allergens", "product_additives", "field_observations", "offers", "ratings"] as const) {
        statements.push(db.prepare(`UPDATE ${table} SET product_id = ? WHERE source_record_id = ?`).bind(targetProductId, review.source_record_id));
      }
      statements.push(db.prepare("DELETE FROM nutrition_facts WHERE product_id = ?").bind(review.product_id));
      statements.push(db.prepare("DELETE FROM ingredient_statements WHERE product_id = ?").bind(review.product_id));
      statements.push(db.prepare("UPDATE review_items SET product_id = ? WHERE product_id = ? AND id <> ? AND status = 'open'")
        .bind(targetProductId, review.product_id, id));
      statements.push(db.prepare(`UPDATE field_observations SET selected = CASE WHEN id = (
        SELECT chosen.id FROM field_observations chosen
        WHERE chosen.product_id = ? AND chosen.field_path = field_observations.field_path
        ORDER BY chosen.authority DESC, chosen.observed_at DESC, chosen.id LIMIT 1
      ) THEN 1 ELSE 0 END WHERE product_id = ?`).bind(targetProductId, targetProductId));
      statements.push(db.prepare("UPDATE products SET is_active = 1 WHERE id = ?").bind(targetProductId));
      statements.push(db.prepare("UPDATE products SET is_active = 0 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM source_records WHERE product_id = ?)")
        .bind(review.product_id, review.product_id));
    } else if (decision === "create_new") {
      statements.push(db.prepare("UPDATE products SET is_active = 1 WHERE id = ?").bind(review.product_id));
    } else {
      statements.push(db.prepare("UPDATE products SET is_active = 0 WHERE id = ?").bind(review.product_id));
    }
  }
  await db.batch(statements);
  return "resolved";
}
