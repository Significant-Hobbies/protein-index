import type { ReviewItem, ReviewResponse } from "../shared/api";

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

export async function listReviews(db: D1Database, status: string, limit: number): Promise<ReviewResponse> {
  const batch = await db.batch([
    db.prepare(`SELECT r.id, r.type, r.priority, r.status, r.product_id, p.name AS product_name, p.brand,
      r.source_record_id, r.candidate_product_ids_json, r.evidence_json, r.created_at, r.decision, r.decision_rationale,
      r.decision_evidence_url, r.decided_by
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

export type ReviewDecision = "verify_nutrition" | "reject_nutrition" | "dismiss";

export async function resolveReview(
  db: D1Database,
  id: string,
  decision: ReviewDecision,
  rationale: string,
  evidenceUrl: string | null,
): Promise<"resolved" | "not_found" | "conflict" | "invalid_decision"> {
  const review = await db.prepare("SELECT id, status, product_id, type FROM review_items WHERE id = ?").bind(id).first<{
    id: string;
    status: string;
    product_id: string | null;
    type: string;
  }>();
  if (!review) return "not_found";
  if (review.status !== "open") return "conflict";
  const nutritionReview = ["nutrition_validation", "nutrition_conflict", "coverage_gap"].includes(review.type);
  if (["verify_nutrition", "reject_nutrition"].includes(decision) && !nutritionReview) return "invalid_decision";
  const status = decision === "dismiss" ? "dismissed" : "resolved";
  const statements = [
    db.prepare("UPDATE review_items SET status = ?, decision = ?, decision_rationale = ?, decision_evidence_url = ?, decided_by = 'local_operator', resolved_at = ? WHERE id = ? AND status = 'open'")
      .bind(status, decision, rationale, evidenceUrl, new Date().toISOString(), id),
  ];
  if (review.product_id && decision === "verify_nutrition") {
    statements.push(db.prepare("UPDATE nutrition_facts SET status = 'verified', confidence = 'high', label_verified_at = ?, updated_at = ? WHERE product_id = ?")
      .bind(new Date().toISOString(), new Date().toISOString(), review.product_id));
  }
  if (review.product_id && decision === "reject_nutrition") {
    statements.push(db.prepare(`UPDATE nutrition_facts SET status = 'missing', confidence = 'low',
      calories = NULL, protein_grams = NULL, carbohydrate_grams = NULL, sugar_grams = NULL,
      fat_grams = NULL, saturated_fat_grams = NULL, fibre_grams = NULL, sodium_mg = NULL,
      label_verified_at = NULL, updated_at = ? WHERE product_id = ?`)
      .bind(new Date().toISOString(), review.product_id));
    statements.push(db.prepare("UPDATE field_observations SET selected = 0 WHERE product_id = ? AND field_path LIKE 'nutrition.%'")
      .bind(review.product_id));
  }
  await db.batch(statements);
  return "resolved";
}
