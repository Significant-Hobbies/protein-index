import type { CoverageResponse } from "../shared/api";

interface CatalogCountRow {
  products: number;
  valid_gtin: number;
  missing_nutrition: number;
  structured_nutrition: number;
  nutrition_label_images: number;
  extraction_candidates: number;
  verified_nutrition: number;
  unverified_nutrition: number;
  conflicting_nutrition: number;
  unverified_ingredients: number;
  verified_ingredients: number;
  marketed_protein: number;
  nutritionally_protein_dense: number;
  terminal_unavailable_nutrition: number;
  terminal_unavailable_ingredients: number;
  outstanding_identity: number;
  outstanding_nutrition: number;
  outstanding_ingredients: number;
}

interface SourceCoverageRow {
  id: string;
  name: string;
  kind: string;
  status: string | null;
  completed_at: string | null;
  records_read: number | null;
  india_records: number | null;
  source_complete: number | null;
  manifest_json: string | null;
}

function disconnected(manifestJson: string | null): string[] {
  if (!manifestJson) return [];
  try {
    const parsed: unknown = JSON.parse(manifestJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const value = (parsed as Record<string, unknown>).disconnectedSources;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function getCoverage(db: D1Database): Promise<CoverageResponse> {
  const batch = await db.batch([
    db.prepare(`SELECT
      COUNT(*) AS products,
      SUM(CASE WHEN p.gtin IS NOT NULL THEN 1 ELSE 0 END) AS valid_gtin,
      SUM(CASE WHEN n.status IS NULL OR n.status = 'missing' THEN 1 ELSE 0 END) AS missing_nutrition,
      SUM(CASE WHEN n.status IS NOT NULL AND n.status <> 'missing' THEN 1 ELSE 0 END) AS structured_nutrition,
      SUM(CASE WHEN p.nutrition_image_url IS NOT NULL THEN 1 ELSE 0 END) AS nutrition_label_images,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM review_items candidate
        JOIN source_records candidate_source ON candidate_source.id = candidate.source_record_id
        WHERE candidate.product_id = p.id AND candidate_source.source_id = 'open_food_facts_robotoff'
          AND candidate.type = 'nutrition_validation'
      ) THEN 1 ELSE 0 END) AS extraction_candidates,
      SUM(CASE WHEN n.status = 'verified' THEN 1 ELSE 0 END) AS verified_nutrition,
      SUM(CASE WHEN n.status = 'unverified' THEN 1 ELSE 0 END) AS unverified_nutrition,
      SUM(CASE WHEN n.status = 'conflict' THEN 1 ELSE 0 END) AS conflicting_nutrition,
      SUM(CASE WHEN i.status = 'unverified' THEN 1 ELSE 0 END) AS unverified_ingredients,
      SUM(CASE WHEN i.status = 'verified' THEN 1 ELSE 0 END) AS verified_ingredients,
      SUM(CASE WHEN p.marketed_protein = 1 THEN 1 ELSE 0 END) AS marketed_protein,
      SUM(CASE WHEN p.nutritionally_protein_dense = 1 THEN 1 ELSE 0 END) AS nutritionally_protein_dense
      ,SUM(CASE WHEN nutrition_outcome.outcome IN ('not_applicable', 'not_declared') THEN 1 ELSE 0 END) AS terminal_unavailable_nutrition
      ,SUM(CASE WHEN ingredient_outcome.outcome IN ('not_applicable', 'not_declared') THEN 1 ELSE 0 END) AS terminal_unavailable_ingredients
      ,SUM(CASE WHEN identity_outcome.product_id IS NULL THEN 1 ELSE 0 END) AS outstanding_identity
      ,SUM(CASE WHEN COALESCE(n.status, 'missing') <> 'verified' AND nutrition_outcome.product_id IS NULL THEN 1 ELSE 0 END) AS outstanding_nutrition
      ,SUM(CASE WHEN COALESCE(i.status, 'missing') <> 'verified' AND ingredient_outcome.product_id IS NULL THEN 1 ELSE 0 END) AS outstanding_ingredients
      FROM products p
      LEFT JOIN nutrition_facts n ON n.product_id = p.id
      LEFT JOIN ingredient_statements i ON i.product_id = p.id
      LEFT JOIN evidence_outcomes identity_outcome ON identity_outcome.product_id = p.id AND identity_outcome.field_family = 'identity'
      LEFT JOIN evidence_outcomes nutrition_outcome ON nutrition_outcome.product_id = p.id AND nutrition_outcome.field_family = 'nutrition'
      LEFT JOIN evidence_outcomes ingredient_outcome ON ingredient_outcome.product_id = p.id AND ingredient_outcome.field_family = 'ingredients'
      WHERE p.is_active = 1`),
    db.prepare(`SELECT s.id, s.name, s.kind, r.status, r.completed_at, r.records_read,
      r.india_records, r.source_complete, r.manifest_json
      FROM sources s LEFT JOIN ingestion_runs r ON r.id = (
        SELECT latest.id FROM ingestion_runs latest WHERE latest.source_id = s.id
        ORDER BY latest.started_at DESC LIMIT 1
      ) ORDER BY s.name`),
  ]);
  const counts = batch[0]?.results[0] as CatalogCountRow | undefined;
  const sourceRows = (batch[1]?.results ?? []) as SourceCoverageRow[];
  const disconnectedSources = [...new Set(sourceRows.flatMap((row) => disconnected(row.manifest_json)))];
  const sourceCoverageComplete = sourceRows.length > 0 && sourceRows.every((row) => row.status === "completed" && row.source_complete === 1);
  const outstandingIdentity = counts?.outstanding_identity ?? 0;
  const outstandingNutrition = counts?.outstanding_nutrition ?? 0;
  const outstandingIngredients = counts?.outstanding_ingredients ?? 0;
  return {
    catalog: {
      products: counts?.products ?? 0,
      validGtin: counts?.valid_gtin ?? 0,
      missingNutrition: counts?.missing_nutrition ?? 0,
      structuredNutrition: counts?.structured_nutrition ?? 0,
      nutritionLabelImages: counts?.nutrition_label_images ?? 0,
      extractionCandidates: counts?.extraction_candidates ?? 0,
      verifiedNutrition: counts?.verified_nutrition ?? 0,
      unverifiedNutrition: counts?.unverified_nutrition ?? 0,
      conflictingNutrition: counts?.conflicting_nutrition ?? 0,
      unverifiedIngredients: counts?.unverified_ingredients ?? 0,
      verifiedIngredients: counts?.verified_ingredients ?? 0,
      marketedProtein: counts?.marketed_protein ?? 0,
      nutritionallyProteinDense: counts?.nutritionally_protein_dense ?? 0,
      terminalUnavailableNutrition: counts?.terminal_unavailable_nutrition ?? 0,
      terminalUnavailableIngredients: counts?.terminal_unavailable_ingredients ?? 0,
    },
    completion: {
      status: sourceCoverageComplete && outstandingIdentity === 0 && outstandingNutrition === 0 && outstandingIngredients === 0 ? "complete" : "incomplete",
      sourceCoverageComplete,
      outstandingIdentity,
      outstandingNutrition,
      outstandingIngredients,
    },
    sources: sourceRows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      latestRunStatus: row.status,
      latestRunAt: row.completed_at,
      recordsRead: row.records_read,
      indiaRecords: row.india_records,
      sourceComplete: row.source_complete === null ? null : row.source_complete === 1,
      marketComplete: false,
    })),
    disconnectedSources,
    claim: "configured_sources_only",
  };
}
