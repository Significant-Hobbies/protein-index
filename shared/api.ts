import type {
  AllergenDeclaration,
  EvidenceStatus,
  MetricResult,
  NormalizedIngredient,
  ProductCategory,
  ProductMetrics,
} from "./types";
import type { SelectedNutritionProjection } from "./evidence-decisions";

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
  imageUrl: string | null;
  nutritionImageUrl: string | null;
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
    basis: "per_100g" | "per_100ml" | "per_serving" | "unknown";
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
  candidates: Array<{
    id: string;
    gtin: string | null;
    brand: string;
    name: string;
    flavour: string | null;
    netQuantityGrams: number | null;
    category: ProductCategory;
  }>;
  evidence: unknown;
  selectedProjection: SelectedNutritionProjection | null;
  redundantProjectionMatches: boolean;
  redundantEligible: boolean;
  createdAt: string;
  decision: ReviewDecision | null;
  rationale: string | null;
  decisionEvidenceUrl: string | null;
  decidedBy: string | null;
}

export type ReviewDecision =
  | "verify_nutrition"
  | "reject_nutrition"
  | "redundant_nutrition"
  | "verify_ingredients"
  | "reject_ingredients"
  | "dismiss"
  | "match"
  | "create_new"
  | "no_match";

export type ReviewStatus = "open" | "resolved" | "dismissed";

export type ReviewType =
  | "identity"
  | "invalid_gtin"
  | "nutrition_validation"
  | "nutrition_conflict"
  | "ingredient_conflict"
  | "coverage_gap";

export interface ReviewResponse {
  items: ReviewItem[];
  counts: { open: number; resolved: number; dismissed: number };
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export interface CoverageResponse {
  catalog: {
    products: number;
    validGtin: number;
    missingNutrition: number;
    structuredNutrition: number;
    nutritionLabelImages: number;
    extractionCandidates: number;
    verifiedNutrition: number;
    unverifiedNutrition: number;
    conflictingNutrition: number;
    unverifiedIngredients: number;
    verifiedIngredients: number;
    marketedProtein: number;
    nutritionallyProteinDense: number;
    terminalUnavailableNutrition: number;
    terminalUnavailableIngredients: number;
  };
  completion: {
    status: "complete" | "incomplete";
    sourceCoverageComplete: boolean;
    outstandingIdentity: number;
    outstandingNutrition: number;
    outstandingIngredients: number;
    contradictions: number;
    snapshotAt: string | null;
    families: Record<CompletionFamily, CompletionSummary>;
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

export type CompletionFamily = "identity" | "nutrition" | "ingredients";
export type CompletionState = "verified" | "terminal_unavailable" | "outstanding";
export type CompletionStateFilter = CompletionState | "all";
export type CompletionLane =
  | "evidence_inconsistent"
  | "conflict_resolution"
  | "review_ready"
  | "structured_evidence_review"
  | "label_evidence_review"
  | "source_evidence_needed";
export type CompletionLaneFilter = CompletionLane | "all";
export type TerminalUnavailableOutcome = "not_applicable" | "not_declared";

export interface CompletionSummary {
  family: CompletionFamily;
  activeProducts: number;
  verified: number;
  terminalUnavailable: number;
  outstanding: number;
  contradictions: number;
  accounted: number;
  invariantHolds: boolean;
  lanes: Record<CompletionLane, number>;
}

export interface CompletionLedgerItem {
  product: {
    id: string;
    gtin: string | null;
    brand: string;
    name: string;
    category: ProductCategory;
    imageUrl: string | null;
  };
  family: CompletionFamily;
  state: CompletionState;
  lane: CompletionLane | null;
  fieldStatus: EvidenceStatus | null;
  terminalOutcome: TerminalUnavailableOutcome | null;
  labelUrl: string | null;
  sourceUrl: string | null;
  sourceId: string | null;
  sourceRecordId: string | null;
  evidenceObservedAt: string | null;
  openCandidateCount: number;
  openReviewCount: number;
  primaryReviewId: string | null;
}

export interface CompletionLedgerFilters {
  family: CompletionFamily;
  state: CompletionStateFilter;
  lane: CompletionLaneFilter;
  q: string;
  page: number;
  pageSize: number;
}

export interface CompletionLedgerResponse {
  items: CompletionLedgerItem[];
  summary: CompletionSummary;
  pagination: { page: number; pageSize: number; total: number; pages: number };
  filters: CompletionLedgerFilters;
  snapshotAt: string | null;
}

export interface HealthResponse {
  status: "ok";
  products: number;
  runtime: "local" | "production";
  latestPublishedAt: string | null;
  sourceComplete: boolean | null;
  mutations: "local_only";
}

export const unavailableMetric: MetricResult = { value: null, reason: "missing_inputs" };
