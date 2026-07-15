import type { CatalogProduct, CatalogResponse, ProductDetailResponse } from "../shared/api";
import { calculateMetrics } from "../shared/metrics";
import { PRODUCT_CATEGORIES, type EvidenceStatus, type NormalizedIngredient, type ProductCategory } from "../shared/types";

interface ProductRow {
  id: string;
  gtin: string | null;
  image_url: string | null;
  nutrition_image_url: string | null;
  brand: string;
  name: string;
  flavour: string | null;
  category: ProductCategory;
  net_quantity_grams: number | null;
  serving_size_grams: number | null;
  marketed_protein: number | null;
  marketed_reasons_json: string;
  nutritionally_protein_dense: number | null;
  nutrition_reasons_json: string;
  completeness: number;
  completeness_missing_json: string;
  nutrition_status: EvidenceStatus | null;
  ingredient_status: EvidenceStatus | null;
  calories: number | null;
  protein_grams: number | null;
  carbohydrate_grams: number | null;
  sugar_grams: number | null;
  fat_grams: number | null;
  saturated_fat_grams: number | null;
  fibre_grams: number | null;
  sodium_mg: number | null;
  nutrition_observed_at: string | null;
  label_verified_at: string | null;
  offer_retailer: string | null;
  selling_price: number | null;
  mrp: number | null;
  offer_pincode: string | null;
  offer_observed_at: string | null;
}

interface CountRow { total: number }

function booleanValue(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapProduct(row: ProductRow): CatalogProduct {
  const nutrition = {
    calories: row.calories,
    proteinGrams: row.protein_grams,
    carbohydrateGrams: row.carbohydrate_grams,
    sugarGrams: row.sugar_grams,
    fatGrams: row.fat_grams,
    saturatedFatGrams: row.saturated_fat_grams,
    fibreGrams: row.fibre_grams,
    sodiumMg: row.sodium_mg,
    observedAt: row.nutrition_observed_at,
    labelVerifiedAt: row.label_verified_at,
  };
  const calculatedMetrics = calculateMetrics({
    nutrition,
    netQuantityGrams: row.net_quantity_grams,
    servingSizeGrams: row.serving_size_grams,
    sellingPrice: row.selling_price,
  });
  const metrics = row.nutrition_status === "verified"
    ? calculatedMetrics
    : {
        proteinPer100Calories: { value: null, reason: "nutrition_not_verified" },
        proteinCaloriePercentage: { value: null, reason: "nutrition_not_verified" },
        costPer25gProtein: { value: null, reason: "nutrition_not_verified" },
        proteinPerInr100: { value: null, reason: "nutrition_not_verified" },
        caloriesFor25gProtein: { value: null, reason: "nutrition_not_verified" },
        sugarPer25gProtein: { value: null, reason: "nutrition_not_verified" },
        saturatedFatPer25gProtein: { value: null, reason: "nutrition_not_verified" },
        fibrePer100Calories: { value: null, reason: "nutrition_not_verified" },
        pricePerServing: { value: null, reason: "nutrition_not_verified" },
        totalProteinInPack: { value: null, reason: "nutrition_not_verified" },
      };
  return {
    id: row.id,
    gtin: row.gtin,
    imageUrl: row.image_url,
    nutritionImageUrl: row.nutrition_image_url,
    brand: row.brand,
    name: row.name,
    flavour: row.flavour,
    category: row.category,
    netQuantityGrams: row.net_quantity_grams,
    servingSizeGrams: row.serving_size_grams,
    marketedProtein: booleanValue(row.marketed_protein),
    marketedReasons: parseJson(row.marketed_reasons_json, []),
    nutritionallyProteinDense: booleanValue(row.nutritionally_protein_dense),
    nutritionReasons: parseJson(row.nutrition_reasons_json, []),
    nutritionStatus: row.nutrition_status ?? "missing",
    ingredientStatus: row.ingredient_status ?? "missing",
    completeness: row.completeness,
    nutrition,
    currentOffer: row.offer_retailer && row.selling_price !== null && row.offer_observed_at
      ? {
          retailer: row.offer_retailer,
          sellingPrice: row.selling_price,
          mrp: row.mrp,
          pincode: row.offer_pincode,
          observedAt: row.offer_observed_at,
        }
      : null,
    metrics,
  };
}

export interface SearchInput {
  q: string;
  category: string;
  marketed: string;
  dense: string;
  verification: string;
  scope: string;
  minCompleteness: number;
  sort: string;
  page: number;
  pageSize: number;
}

export function validateSearch(input: URLSearchParams): { value?: SearchInput; error?: string } {
  const number = (name: string, fallback: number): number => {
    const value = Number(input.get(name) ?? fallback);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const value: SearchInput = {
    q: input.get("q")?.trim() ?? "",
    category: input.get("category") ?? "all",
    marketed: input.get("marketed") ?? "all",
    dense: input.get("dense") ?? "all",
    verification: input.get("verification") ?? "verified",
    scope: input.get("scope") ?? "protein",
    minCompleteness: number("minCompleteness", 0),
    sort: input.get("sort") ?? "protein_density",
    page: number("page", 1),
    pageSize: number("pageSize", 25),
  };
  if (value.category !== "all" && !PRODUCT_CATEGORIES.includes(value.category as ProductCategory)) return { error: "Invalid category" };
  if (!["all", "true", "false"].includes(value.marketed)) return { error: "Invalid marketed filter" };
  if (!["all", "true", "false", "unknown"].includes(value.dense)) return { error: "Invalid dense filter" };
  if (!["all", "missing", "unverified", "verified", "conflict"].includes(value.verification)) return { error: "Invalid verification filter" };
  if (!["all", "protein"].includes(value.scope)) return { error: "Invalid scope" };
  if (!["protein_density", "cost", "completeness", "name"].includes(value.sort)) return { error: "Invalid sort" };
  if (!Number.isInteger(value.page) || value.page < 1) return { error: "Page must be a positive integer" };
  if (!Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100) return { error: "Page size must be between 1 and 100" };
  if (!Number.isInteger(value.minCompleteness) || value.minCompleteness < 0 || value.minCompleteness > 100) return { error: "Minimum completeness must be between 0 and 100" };
  return { value };
}

const SELECT_PRODUCT = `
  SELECT p.id, p.gtin, p.image_url, p.nutrition_image_url, p.brand, p.name, p.flavour, p.category,
    p.net_quantity_grams, p.serving_size_grams, p.marketed_protein,
    p.marketed_reasons_json, p.nutritionally_protein_dense,
    p.nutrition_reasons_json, p.completeness, p.completeness_missing_json,
    n.status AS nutrition_status, i.status AS ingredient_status,
    n.calories, n.protein_grams, n.carbohydrate_grams, n.sugar_grams,
    n.fat_grams, n.saturated_fat_grams, n.fibre_grams, n.sodium_mg,
    n.observed_at AS nutrition_observed_at, n.label_verified_at,
    o.retailer AS offer_retailer, o.selling_price, o.mrp,
    o.pincode AS offer_pincode, o.observed_at AS offer_observed_at
  FROM products p
  LEFT JOIN nutrition_facts n ON n.product_id = p.id
  LEFT JOIN ingredient_statements i ON i.product_id = p.id
  LEFT JOIN offers o ON o.id = (
    SELECT latest.id FROM offers latest
    WHERE latest.product_id = p.id AND latest.available = 1
    ORDER BY latest.observed_at DESC, latest.selling_price ASC LIMIT 1
  )`;

function filtersFor(input: SearchInput): { sql: string; bindings: Array<string | number> } {
  const clauses: string[] = ["p.is_active = 1"];
  const bindings: Array<string | number> = [];
  if (input.q) {
    clauses.push("(p.name_normalized LIKE ? OR p.brand_normalized LIKE ? OR p.gtin LIKE ?)");
    const like = `%${input.q.toLowerCase()}%`;
    bindings.push(like, like, like);
  }
  if (input.category !== "all") { clauses.push("p.category = ?"); bindings.push(input.category); }
  if (input.marketed !== "all") { clauses.push("p.marketed_protein = ?"); bindings.push(input.marketed === "true" ? 1 : 0); }
  if (input.dense !== "all") {
    clauses.push(input.dense === "unknown" ? "p.nutritionally_protein_dense IS NULL" : "p.nutritionally_protein_dense = ?");
    if (input.dense !== "unknown") bindings.push(input.dense === "true" ? 1 : 0);
  }
  if (input.verification !== "all") { clauses.push("COALESCE(n.status, 'missing') = ?"); bindings.push(input.verification); }
  if (input.scope === "protein") clauses.push("(p.marketed_protein = 1 OR p.nutritionally_protein_dense = 1)");
  clauses.push("p.completeness >= ?");
  bindings.push(input.minCompleteness);
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", bindings };
}

export async function searchProducts(db: D1Database, input: SearchInput): Promise<CatalogResponse> {
  const filters = filtersFor(input);
  const order = {
    protein_density: "CASE WHEN n.calories > 0 THEN n.protein_grams * 100.0 / n.calories END DESC, p.name_normalized",
    cost: "CASE WHEN n.protein_grams > 0 AND p.net_quantity_grams > 0 THEN o.selling_price * 2500.0 / (p.net_quantity_grams * n.protein_grams) END ASC, p.name_normalized",
    completeness: "p.completeness DESC, p.name_normalized",
    name: "p.name_normalized, p.brand_normalized",
  }[input.sort] ?? "p.name_normalized";
  const offset = (input.page - 1) * input.pageSize;
  const list = db.prepare(`${SELECT_PRODUCT}${filters.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...filters.bindings, input.pageSize, offset);
  const count = db.prepare(`SELECT COUNT(*) AS total FROM products p LEFT JOIN nutrition_facts n ON n.product_id = p.id${filters.sql}`).bind(...filters.bindings);
  const batch = await db.batch<ProductRow | CountRow>([list, count]);
  const listResult = batch[0];
  const countResult = batch[1];
  if (!listResult || !countResult) throw new Error("Catalog query batch returned an incomplete result");
  const rows = listResult.results as ProductRow[];
  const total = (countResult.results[0] as CountRow | undefined)?.total ?? 0;
  return {
    products: rows.map(mapProduct),
    pagination: { page: input.page, pageSize: input.pageSize, total, pages: Math.ceil(total / input.pageSize) },
    trustedDefault: input.verification === "verified" && input.scope === "protein",
    filters: { ...input },
  };
}

interface SourceRow { id: string; source_id: string; source_record_id: string; source_url: string | null; observed_at: string; resolution_rule: string | null }
interface IngredientRow { id: string; parent_id: string | null; position: number; raw_text: string; normalized_name: string | null; percentage: number | null }
interface AllergenRow { name: string; declaration: "contains" | "may_contain" | "source_tag" }
interface AdditiveRow { identifier: string }
interface NutrientRow { nutrient_code: string; quantity: number; unit: string; basis: string; status: string; observed_at: string }
interface OfferRow { retailer: string; retailer_listing_id: string; pincode: string | null; seller: string | null; selling_price: number; mrp: number | null; available: number; url: string; observed_at: string }
interface RatingRow { retailer: string; retailer_listing_id: string; stars: number; rating_count: number; review_count: number | null; observed_at: string }
interface ProvenanceRow { field_path: string; raw_value_json: string; normalized_value_json: string; source_id: string; confidence: string; authority: number; observed_at: string; evidence_url: string | null; selected: number }
interface IngredientStatementRow { raw_text: string | null }
interface OpenReviewRow { count: number }

function ingredientTree(rows: IngredientRow[], parentId: string | null = null): NormalizedIngredient[] {
  return rows
    .filter((row) => row.parent_id === parentId)
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      raw: row.raw_text,
      normalizedName: row.normalized_name,
      percentage: row.percentage,
      position: row.position,
      children: ingredientTree(rows, row.id),
    }));
}

export async function getProductDetail(db: D1Database, id: string): Promise<ProductDetailResponse | null> {
  const productStatement = db.prepare(`${SELECT_PRODUCT} WHERE p.id = ?`).bind(id);
  const statements = [
    productStatement,
    db.prepare("SELECT id, source_id, source_record_id, source_url, observed_at, resolution_rule FROM source_records WHERE product_id = ? ORDER BY observed_at DESC").bind(id),
    db.prepare("SELECT pi.id, pi.parent_id, pi.position, pi.raw_text, pi.normalized_name, pi.percentage FROM product_ingredients pi JOIN ingredient_statements s ON s.product_id = pi.product_id AND s.source_record_id = pi.source_record_id WHERE pi.product_id = ? ORDER BY pi.position").bind(id),
    db.prepare("SELECT name, declaration FROM product_allergens WHERE product_id = ? ORDER BY declaration, name").bind(id),
    db.prepare("SELECT identifier FROM product_additives WHERE product_id = ? ORDER BY identifier").bind(id),
    db.prepare("SELECT nutrient_code, quantity, unit, basis, status, observed_at FROM nutrient_values WHERE product_id = ? ORDER BY nutrient_code LIMIT 300").bind(id),
    db.prepare("SELECT retailer, retailer_listing_id, pincode, seller, selling_price, mrp, available, url, observed_at FROM offers WHERE product_id = ? ORDER BY observed_at DESC LIMIT 100").bind(id),
    db.prepare("SELECT retailer, retailer_listing_id, stars, rating_count, review_count, observed_at FROM ratings WHERE product_id = ? ORDER BY observed_at DESC LIMIT 100").bind(id),
    db.prepare("SELECT f.field_path, f.raw_value_json, f.normalized_value_json, s.source_id, f.confidence, f.authority, f.observed_at, f.evidence_url, f.selected FROM field_observations f JOIN source_records s ON s.id = f.source_record_id WHERE f.product_id = ? ORDER BY f.field_path, f.authority DESC").bind(id),
    db.prepare("SELECT raw_text FROM ingredient_statements WHERE product_id = ?").bind(id),
    db.prepare("SELECT COUNT(*) AS count FROM review_items WHERE product_id = ? AND status = 'open'").bind(id),
  ];
  const results = await db.batch(statements);
  const productRow = results[0]?.results[0] as ProductRow | undefined;
  if (!productRow) return null;
  const product = mapProduct(productRow);
  const ingredientRows = (results[2]?.results ?? []) as IngredientRow[];
  const statement = results[9]?.results[0] as IngredientStatementRow | undefined;
  const openReview = results[10]?.results[0] as OpenReviewRow | undefined;
  return {
    ...product,
    sourceRecords: ((results[1]?.results ?? []) as SourceRow[]).map((row) => ({ id: row.id, source: row.source_id, sourceRecordId: row.source_record_id, sourceUrl: row.source_url, observedAt: row.observed_at, resolutionRule: row.resolution_rule })),
    ingredientStatement: statement?.raw_text ?? null,
    ingredients: ingredientTree(ingredientRows),
    allergens: ((results[3]?.results ?? []) as AllergenRow[]).map((row) => ({ name: row.name, declaration: row.declaration })),
    additives: ((results[4]?.results ?? []) as AdditiveRow[]).map(({ identifier }) => identifier),
    nutrients: ((results[5]?.results ?? []) as NutrientRow[]).map((row) => ({ code: row.nutrient_code, quantity: row.quantity, unit: row.unit, basis: row.basis, status: row.status, observedAt: row.observed_at })),
    offers: ((results[6]?.results ?? []) as OfferRow[]).map((row) => ({ retailer: row.retailer, listingId: row.retailer_listing_id, pincode: row.pincode, seller: row.seller, sellingPrice: row.selling_price, mrp: row.mrp, available: row.available === 1, url: row.url, observedAt: row.observed_at })),
    ratings: ((results[7]?.results ?? []) as RatingRow[]).map((row) => ({ retailer: row.retailer, listingId: row.retailer_listing_id, stars: row.stars, ratingCount: row.rating_count, reviewCount: row.review_count, observedAt: row.observed_at })),
    provenance: ((results[8]?.results ?? []) as ProvenanceRow[]).map((row) => ({ field: row.field_path, raw: parseJson(row.raw_value_json, null), normalized: parseJson(row.normalized_value_json, null), source: row.source_id, confidence: row.confidence, authority: row.authority, observedAt: row.observed_at, evidenceUrl: row.evidence_url, selected: row.selected === 1 })),
    completenessMissing: parseJson(productRow.completeness_missing_json, []),
    openReviewCount: openReview?.count ?? 0,
  };
}
