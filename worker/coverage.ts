import type { CoverageResponse } from "../shared/api";
import { getCompletionSummaries } from "./completion";

interface CatalogCountRow {
  products: number;
  valid_gtin: number;
  missing_nutrition: number;
  structured_nutrition: number;
  nutrition_label_images: number;
  verified_nutrition: number;
  unverified_nutrition: number;
  conflicting_nutrition: number;
  unverified_ingredients: number;
  verified_ingredients: number;
  marketed_protein: number;
  nutritionally_protein_dense: number;
}

interface ExtractionCandidateCountRow {
  extraction_candidates: number;
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
  const [batch, completionAccounting] = await Promise.all([db.batch([
    db.prepare(`SELECT
      COUNT(*) AS products,
      SUM(CASE WHEN p.gtin IS NOT NULL THEN 1 ELSE 0 END) AS valid_gtin,
      SUM(CASE WHEN n.status IS NULL OR n.status = 'missing' THEN 1 ELSE 0 END) AS missing_nutrition,
      SUM(CASE WHEN n.status IS NOT NULL AND n.status <> 'missing' THEN 1 ELSE 0 END) AS structured_nutrition,
      SUM(CASE WHEN p.nutrition_image_url IS NOT NULL THEN 1 ELSE 0 END) AS nutrition_label_images,
      SUM(CASE WHEN n.status = 'verified' AND verified_nutrition.product_id IS NOT NULL THEN 1 ELSE 0 END) AS verified_nutrition,
      SUM(CASE WHEN n.status = 'unverified' OR (
        n.status = 'verified' AND verified_nutrition.product_id IS NULL
      ) THEN 1 ELSE 0 END) AS unverified_nutrition,
      SUM(CASE WHEN n.status = 'conflict' THEN 1 ELSE 0 END) AS conflicting_nutrition,
      SUM(CASE WHEN i.status = 'unverified' OR (
        i.status = 'verified' AND verified_ingredients.product_id IS NULL
      ) THEN 1 ELSE 0 END) AS unverified_ingredients,
      SUM(CASE WHEN i.status = 'verified' AND verified_ingredients.product_id IS NOT NULL THEN 1 ELSE 0 END) AS verified_ingredients,
      SUM(CASE WHEN p.marketed_protein = 1 THEN 1 ELSE 0 END) AS marketed_protein,
      SUM(CASE WHEN p.nutritionally_protein_dense = 1 THEN 1 ELSE 0 END) AS nutritionally_protein_dense
      FROM products p
      LEFT JOIN nutrition_facts n ON n.product_id = p.id
      LEFT JOIN ingredient_statements i ON i.product_id = p.id
      LEFT JOIN current_verified_nutrition_facts verified_nutrition
        ON verified_nutrition.product_id = p.id
      LEFT JOIN current_verified_ingredient_statements verified_ingredients
        ON verified_ingredients.product_id = p.id
      WHERE p.is_active = 1`),
    db.prepare(`SELECT s.id, s.name, s.kind, r.status, r.completed_at, r.records_read,
      r.india_records, r.source_complete, r.manifest_json
      FROM sources s LEFT JOIN ingestion_runs r ON r.id = (
        SELECT latest.id FROM ingestion_runs latest WHERE latest.source_id = s.id
        ORDER BY latest.started_at DESC LIMIT 1
      ) ORDER BY s.name`),
    db.prepare(`SELECT COUNT(DISTINCT r.product_id) AS extraction_candidates
      FROM review_items r JOIN source_records s ON s.id = r.source_record_id
      WHERE r.type = 'nutrition_validation' AND r.product_id IS NOT NULL
        AND s.source_id = 'open_food_facts_robotoff'`),
  ]), getCompletionSummaries(db)]);
  const counts = batch[0]?.results[0] as CatalogCountRow | undefined;
  const sourceRows = (batch[1]?.results ?? []) as SourceCoverageRow[];
  const extractionCounts = batch[2]?.results[0] as ExtractionCandidateCountRow | undefined;
  const disconnectedSources = [...new Set(sourceRows.flatMap((row) => disconnected(row.manifest_json)))];
  const sourceCoverageComplete = sourceRows.length > 0 && sourceRows.every((row) => row.status === "completed" && row.source_complete === 1);
  const outstandingIdentity = completionAccounting.families.identity.outstanding;
  const outstandingNutrition = completionAccounting.families.nutrition.outstanding;
  const outstandingIngredients = completionAccounting.families.ingredients.outstanding;
  const contradictions = Object.values(completionAccounting.families)
    .reduce((total, family) => total + family.contradictions, 0);
  const invariantHolds = Object.values(completionAccounting.families)
    .every((family) => family.invariantHolds);
  return {
    catalog: {
      products: counts?.products ?? 0,
      validGtin: counts?.valid_gtin ?? 0,
      missingNutrition: counts?.missing_nutrition ?? 0,
      structuredNutrition: counts?.structured_nutrition ?? 0,
      nutritionLabelImages: counts?.nutrition_label_images ?? 0,
      extractionCandidates: extractionCounts?.extraction_candidates ?? 0,
      verifiedNutrition: counts?.verified_nutrition ?? 0,
      unverifiedNutrition: counts?.unverified_nutrition ?? 0,
      conflictingNutrition: counts?.conflicting_nutrition ?? 0,
      unverifiedIngredients: counts?.unverified_ingredients ?? 0,
      verifiedIngredients: counts?.verified_ingredients ?? 0,
      marketedProtein: counts?.marketed_protein ?? 0,
      nutritionallyProteinDense: counts?.nutritionally_protein_dense ?? 0,
      terminalUnavailableNutrition: completionAccounting.families.nutrition.terminalUnavailable,
      terminalUnavailableIngredients: completionAccounting.families.ingredients.terminalUnavailable,
    },
    completion: {
      status: sourceCoverageComplete && invariantHolds && contradictions === 0
        && outstandingIdentity === 0 && outstandingNutrition === 0 && outstandingIngredients === 0
        ? "complete" : "incomplete",
      sourceCoverageComplete,
      outstandingIdentity,
      outstandingNutrition,
      outstandingIngredients,
      contradictions,
      snapshotAt: completionAccounting.snapshotAt,
      families: completionAccounting.families,
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
