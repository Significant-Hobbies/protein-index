import type { CoverageResponse } from "../shared/api";

interface CatalogCountRow {
  products: number;
  valid_gtin: number;
  verified_nutrition: number;
  unverified_nutrition: number;
  conflicting_nutrition: number;
  verified_ingredients: number;
  marketed_protein: number;
  nutritionally_protein_dense: number;
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
      SUM(CASE WHEN n.status = 'verified' THEN 1 ELSE 0 END) AS verified_nutrition,
      SUM(CASE WHEN n.status = 'unverified' THEN 1 ELSE 0 END) AS unverified_nutrition,
      SUM(CASE WHEN n.status = 'conflict' THEN 1 ELSE 0 END) AS conflicting_nutrition,
      SUM(CASE WHEN i.status = 'verified' THEN 1 ELSE 0 END) AS verified_ingredients,
      SUM(CASE WHEN p.marketed_protein = 1 THEN 1 ELSE 0 END) AS marketed_protein,
      SUM(CASE WHEN p.nutritionally_protein_dense = 1 THEN 1 ELSE 0 END) AS nutritionally_protein_dense
      FROM products p
      LEFT JOIN nutrition_facts n ON n.product_id = p.id
      LEFT JOIN ingredient_statements i ON i.product_id = p.id`),
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
  return {
    catalog: {
      products: counts?.products ?? 0,
      validGtin: counts?.valid_gtin ?? 0,
      verifiedNutrition: counts?.verified_nutrition ?? 0,
      unverifiedNutrition: counts?.unverified_nutrition ?? 0,
      conflictingNutrition: counts?.conflicting_nutrition ?? 0,
      verifiedIngredients: counts?.verified_ingredients ?? 0,
      marketedProtein: counts?.marketed_protein ?? 0,
      nutritionallyProteinDense: counts?.nutritionally_protein_dense ?? 0,
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
