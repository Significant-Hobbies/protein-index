import type {
  AllergenDeclaration,
  EvidenceStatus,
  MetricResult,
  NormalizedIngredient,
  ProductCategory,
  ProductMetrics,
} from "./types";

export interface ApiErrorBody {
  error: {
    code: "validation_error" | "not_found" | "conflict" | "mutations_disabled" | "internal_error";
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface CatalogProduct {
  id: string;
  gtin: string | null;
  brand: string;
  name: string;
  flavour: string | null;
  category: ProductCategory;
  netQuantityGrams: number | null;
  servingSizeGrams: number | null;
  marketedProtein: boolean | null;
  marketedReasons: string[];
  nutritionallyProteinDense: boolean | null;
  nutritionReasons: string[];
  nutritionStatus: EvidenceStatus;
  ingredientStatus: EvidenceStatus;
  completeness: number;
  nutrition: {
    calories: number | null;
    proteinGrams: number | null;
    carbohydrateGrams: number | null;
    sugarGrams: number | null;
    fatGrams: number | null;
    saturatedFatGrams: number | null;
    fibreGrams: number | null;
    sodiumMg: number | null;
    observedAt: string | null;
    labelVerifiedAt: string | null;
  };
  currentOffer: {
    retailer: string;
    sellingPrice: number;
    mrp: number | null;
    pincode: string | null;
    observedAt: string;
  } | null;
  metrics: ProductMetrics;
}

export interface CatalogResponse {
  products: CatalogProduct[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
  trustedDefault: boolean;
  filters: Record<string, string | number | null>;
}

export interface ProductDetailResponse extends CatalogProduct {
  sourceRecords: Array<{
    id: string;
    source: string;
    sourceRecordId: string;
    sourceUrl: string | null;
    observedAt: string;
    resolutionRule: string | null;
  }>;
  ingredientStatement: string | null;
  ingredients: NormalizedIngredient[];
  allergens: AllergenDeclaration[];
  additives: string[];
  nutrients: Array<{ code: string; quantity: number; unit: string; basis: string; status: string; observedAt: string }>;
  offers: Array<{ retailer: string; listingId: string; pincode: string | null; seller: string | null; sellingPrice: number; mrp: number | null; available: boolean; url: string; observedAt: string }>;
  ratings: Array<{ retailer: string; listingId: string; stars: number; ratingCount: number; reviewCount: number | null; observedAt: string }>;
  provenance: Array<{ field: string; raw: unknown; normalized: unknown; source: string; confidence: string; authority: number; observedAt: string; evidenceUrl: string | null; selected: boolean }>;
  completenessMissing: string[];
  openReviewCount: number;
}

export interface ReviewItem {
  id: string;
  type: string;
  priority: number;
  status: string;
  productId: string | null;
  productName: string | null;
  brand: string | null;
  sourceRecordId: string | null;
  candidateProductIds: string[];
  evidence: unknown;
  createdAt: string;
  decision: string | null;
  rationale: string | null;
  decisionEvidenceUrl: string | null;
  decidedBy: string | null;
}

export interface ReviewResponse {
  items: ReviewItem[];
  counts: { open: number; resolved: number; dismissed: number };
}

export interface CoverageResponse {
  catalog: {
    products: number;
    validGtin: number;
    verifiedNutrition: number;
    unverifiedNutrition: number;
    conflictingNutrition: number;
    verifiedIngredients: number;
    marketedProtein: number;
    nutritionallyProteinDense: number;
  };
  sources: Array<{
    id: string;
    name: string;
    kind: string;
    latestRunStatus: string | null;
    latestRunAt: string | null;
    recordsRead: number | null;
    indiaRecords: number | null;
    sourceComplete: boolean | null;
    marketComplete: false;
  }>;
  disconnectedSources: string[];
  claim: "configured_sources_only";
}

export const unavailableMetric: MetricResult = { value: null, reason: "missing_inputs" };
