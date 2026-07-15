import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogProduct,
  CatalogResponse,
  CoverageResponse,
  HealthResponse,
  ProductDetailResponse,
  ReviewItem,
  ReviewResponse,
} from "../shared/api";
import type { EvidenceStatus, MetricResult, NormalizedIngredient } from "../shared/types";
import { api } from "./api";

type Tab = "catalog" | "reviews" | "coverage";

export const initialFilters = {
  q: "",
  category: "all",
  verification: "all",
  scope: "all",
  sort: "protein_density",
};

export function metricEvidenceLabel(status: EvidenceStatus): string {
  return status === "verified" ? "verified nutrition" : status === "unverified" ? "unverified nutrition" : `${status} nutrition`;
}

export interface ReviewNutritionCandidate {
  predictionId: string;
  imageId: string;
  imageUrl: string;
  modelName: string;
  modelVersion: string;
  observedAt: string;
  basis: "per_100g" | "per_serving";
  minimumConfidence: number;
  nutritionPer100g: {
    calories: number | null;
    proteinGrams: number | null;
    carbohydrateGrams: number | null;
    sugarGrams: number | null;
    fatGrams: number | null;
    saturatedFatGrams: number | null;
    fibreGrams: number | null;
    sodiumMg: number | null;
  };
}

export interface ReviewIngredientCandidate {
  predictionId: string;
  entityIndex: number;
  imageId: string;
  imageUrl: string;
  modelName: string;
  modelVersion: string;
  predictedAt: string;
  observedAt: string;
  entityText: string;
  entityConfidence: number;
  language: { code: string; confidence: number };
  boundingBox: [number, number, number, number];
  parsedIngredients: unknown[];
  ingredientCount: number;
  knownIngredientCount: number;
  unknownIngredientCount: number;
  candidateHash: string;
  hasConflict: boolean;
  warnings: Array<{ code: string; message: string }>;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function reviewNutritionCandidate(evidence: unknown): ReviewNutritionCandidate | null {
  const root = object(evidence);
  if (root?.code !== "robotoff_nutrition_candidate") return null;
  const candidate = object(object(root.details)?.candidate);
  const nutrition = object(candidate?.nutritionPer100g);
  if (!candidate || !nutrition) return null;
  const calories = nullableNumber(nutrition.calories);
  const proteinGrams = nullableNumber(nutrition.proteinGrams);
  const carbohydrateGrams = nullableNumber(nutrition.carbohydrateGrams);
  const sugarGrams = nullableNumber(nutrition.sugarGrams);
  const fatGrams = nullableNumber(nutrition.fatGrams);
  const saturatedFatGrams = nullableNumber(nutrition.saturatedFatGrams);
  const fibreGrams = nullableNumber(nutrition.fibreGrams);
  const sodiumMg = nullableNumber(nutrition.sodiumMg);
  if (
    calories === undefined || proteinGrams === undefined || carbohydrateGrams === undefined ||
    sugarGrams === undefined || fatGrams === undefined || saturatedFatGrams === undefined ||
    fibreGrams === undefined || sodiumMg === undefined
  ) return null;
  const basis = candidate.basis === "per_100g" || candidate.basis === "per_serving" ? candidate.basis : null;
  if (
    typeof candidate.predictionId !== "string" || !candidate.predictionId ||
    typeof candidate.imageId !== "string" || !candidate.imageId ||
    typeof candidate.imageUrl !== "string" ||
    typeof candidate.modelName !== "string" || !candidate.modelName ||
    typeof candidate.modelVersion !== "string" || !candidate.modelVersion ||
    typeof candidate.observedAt !== "string" || !Number.isFinite(Date.parse(candidate.observedAt)) ||
    !basis || typeof candidate.minimumConfidence !== "number" ||
    !Number.isFinite(candidate.minimumConfidence) || candidate.minimumConfidence < 0 || candidate.minimumConfidence > 1
  ) return null;
  try {
    if (new URL(candidate.imageUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  return {
    predictionId: candidate.predictionId,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    observedAt: candidate.observedAt,
    basis,
    minimumConfidence: candidate.minimumConfidence,
    nutritionPer100g: { calories, proteinGrams, carbohydrateGrams, sugarGrams, fatGrams, saturatedFatGrams, fibreGrams, sodiumMg },
  };
}

export function reviewIngredientCandidate(evidence: unknown): ReviewIngredientCandidate | null {
  const root = object(evidence);
  if (root?.code !== "robotoff_ingredient_candidate") return null;
  const details = object(root.details);
  const candidate = object(details?.candidate);
  const language = object(candidate?.language);
  const boundingBox = candidate?.boundingBox;
  const parsedIngredients = candidate?.parsedIngredients;
  if (
    !candidate || !language || !Array.isArray(boundingBox) || boundingBox.length !== 4 ||
    !boundingBox.every((value) => typeof value === "number" && Number.isFinite(value)) ||
    !Array.isArray(parsedIngredients) || typeof details?.candidateHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(details.candidateHash) ||
    typeof candidate.predictionId !== "string" || !candidate.predictionId ||
    typeof candidate.entityIndex !== "number" || !Number.isInteger(candidate.entityIndex) || candidate.entityIndex < 0 ||
    typeof candidate.imageId !== "string" || !candidate.imageId ||
    typeof candidate.imageUrl !== "string" ||
    typeof candidate.modelName !== "string" || !candidate.modelName ||
    typeof candidate.modelVersion !== "string" || !candidate.modelVersion ||
    typeof candidate.predictedAt !== "string" || !Number.isFinite(Date.parse(candidate.predictedAt)) ||
    typeof candidate.observedAt !== "string" || !Number.isFinite(Date.parse(candidate.observedAt)) ||
    typeof candidate.entityText !== "string" || !candidate.entityText.trim() ||
    typeof candidate.entityConfidence !== "number" || candidate.entityConfidence < 0 || candidate.entityConfidence > 1 ||
    typeof language.code !== "string" || !language.code ||
    typeof language.confidence !== "number" || language.confidence < 0 || language.confidence > 1 ||
    typeof candidate.ingredientCount !== "number" || !Number.isInteger(candidate.ingredientCount) || candidate.ingredientCount < 0 ||
    typeof candidate.knownIngredientCount !== "number" || !Number.isInteger(candidate.knownIngredientCount) || candidate.knownIngredientCount < 0 ||
    typeof candidate.unknownIngredientCount !== "number" || !Number.isInteger(candidate.unknownIngredientCount) || candidate.unknownIngredientCount < 0
  ) return null;
  try {
    if (new URL(candidate.imageUrl).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const warnings = Array.isArray(details.warnings)
    ? details.warnings.flatMap((warning) => {
      const item = object(warning);
      return typeof item?.code === "string" && typeof item.message === "string"
        ? [{ code: item.code, message: item.message }]
        : [];
    })
    : [];
  return {
    predictionId: candidate.predictionId,
    entityIndex: candidate.entityIndex,
    imageId: candidate.imageId,
    imageUrl: candidate.imageUrl,
    modelName: candidate.modelName,
    modelVersion: candidate.modelVersion,
    predictedAt: candidate.predictedAt,
    observedAt: candidate.observedAt,
    entityText: candidate.entityText,
    entityConfidence: candidate.entityConfidence,
    language: { code: language.code, confidence: language.confidence },
    boundingBox: boundingBox as [number, number, number, number],
    parsedIngredients,
    ingredientCount: candidate.ingredientCount,
    knownIngredientCount: candidate.knownIngredientCount,
    unknownIngredientCount: candidate.unknownIngredientCount,
    candidateHash: details.candidateHash,
    hasConflict: details.hasConflict === true,
    warnings,
  };
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value);
}

function metric(result: MetricResult, suffix = ""): string {
  return result.value === null ? "—" : `${formatNumber(result.value, 2)}${suffix}`;
}

function nutritionBasisLabel(basis: CatalogProduct["nutrition"]["basis"]): string {
  return basis === "per_100ml" ? "per 100 ml" : basis === "per_serving" ? "per serving" : basis === "per_100g" ? "per 100 g" : "normalized basis";
}

function MetricValue({ result, prefix = "", suffix = "" }: { result: MetricResult; prefix?: string; suffix?: string }) {
  if (result.value === null) {
    return <span className="metric-unavailable">Unavailable<small>{(result.reason ?? "missing inputs").replaceAll("_", " ")}</small></span>;
  }
  return <>{prefix}{formatNumber(result.value, 2)}{suffix}</>;
}

function StatusBadge({ status }: { status: EvidenceStatus }) {
  return <span className={`status status-${status}`}><i aria-hidden="true" />{status}</span>;
}

function ProductVisual({ product, size = "small" }: { product: Pick<CatalogProduct, "imageUrl" | "brand" | "name">; size?: "small" | "large" }) {
  const [failed, setFailed] = useState(false);
  const initials = `${product.brand} ${product.name}`.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("");
  return (
    <div className={`product-visual product-visual-${size}`} aria-hidden="true">
      {product.imageUrl && !failed
        ? <img src={product.imageUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <span>{initials || "PI"}</span>}
    </div>
  );
}

function ClassificationBadges({ product }: { product: CatalogProduct }) {
  return (
    <div className="badge-row">
      {product.marketedProtein && <span className="tag tag-market">marketed protein</span>}
      {product.nutritionallyProteinDense === true && <span className="tag tag-dense">protein-dense</span>}
      {product.nutritionallyProteinDense === null && <span className="tag">density unknown</span>}
    </div>
  );
}

function CatalogTable({ data, onOpen, onExplore, page, onPage }: {
  data: CatalogResponse;
  onOpen: (id: string) => void;
  onExplore: () => void;
  page: number;
  onPage: (page: number) => void;
}) {
  if (data.products.length === 0) {
    return (
      <div className="empty empty-catalog">
        <span className="empty-mark" aria-hidden="true">0</span>
        <strong>{data.trustedDefault ? "No label-verified products yet." : "No products match this view."}</strong>
        <span>{data.trustedDefault ? "The catalog is live, but community nutrition is never promoted into trusted comparisons." : "Try a broader category, scope, or evidence filter."}</span>
        {data.trustedDefault && <button onClick={onExplore}>Explore the discovery catalog</button>}
      </div>
    );
  }
  return (
    <>
      <div className="table-wrap catalog-desktop">
        <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Protein / 100 kcal</th>
            <th scope="col">Evidence</th>
            <th scope="col">Protein</th>
            <th scope="col">Protein calories</th>
            <th scope="col">Cost / 25 g</th>
            <th scope="col">Current offer</th>
            <th scope="col">Complete</th>
          </tr>
        </thead>
        <tbody>
          {data.products.map((product) => (
            <tr key={product.id}>
              <td className="product-cell">
                <div className="product-identity"><ProductVisual product={product} /><div><button className="product-link" onClick={() => onOpen(product.id)}><strong>{product.name}</strong><span>{product.brand}{product.flavour ? ` · ${product.flavour}` : ""}</span></button><ClassificationBadges product={product} /></div></div>
              </td>
              <td className="metric-primary"><strong>{metric(product.metrics.proteinPer100Calories, " g")}</strong><small>{metricEvidenceLabel(product.nutritionStatus)}</small></td>
              <td><StatusBadge status={product.nutritionStatus} /><small>ingredients: {product.ingredientStatus}</small></td>
              <td><strong>{formatNumber(product.nutrition.proteinGrams)} g</strong><small>{nutritionBasisLabel(product.nutrition.basis)}</small></td>
              <td>{metric(product.metrics.proteinCaloriePercentage, "%")}</td>
              <td>{product.metrics.costPer25gProtein.value === null ? "—" : `₹${formatNumber(product.metrics.costPer25gProtein.value, 2)}`}</td>
              <td>{product.currentOffer ? <><strong>₹{formatNumber(product.currentOffer.sellingPrice, 0)}</strong><small>{product.currentOffer.retailer} · {product.currentOffer.pincode ?? "all India"}</small></> : "—"}</td>
              <td><span className="completeness"><i style={{ width: `${product.completeness}%` }} />{product.completeness}%</span></td>
            </tr>
          ))}
        </tbody>
        </table>
      </div>
      <div className="catalog-mobile" aria-label="Catalog products">
        {data.products.map((product) => (
          <article className="product-card" key={product.id}>
            <button className="product-card-main" onClick={() => onOpen(product.id)}>
              <ProductVisual product={product} />
              <span className="product-card-copy"><small>{product.brand}</small><strong>{product.name}</strong><em>{product.flavour ?? product.category.replaceAll("_", " ")}</em></span>
              <span className="card-arrow" aria-hidden="true">↗</span>
            </button>
            <div className="product-card-metric"><strong>{metric(product.metrics.proteinPer100Calories, " g")}</strong><span>protein / 100 kcal</span><small>{metricEvidenceLabel(product.nutritionStatus)}</small></div>
            <div className="product-card-meta"><StatusBadge status={product.nutritionStatus} /><span>{product.nutrition.proteinGrams === null ? "Protein missing" : `${formatNumber(product.nutrition.proteinGrams)} g protein · ${nutritionBasisLabel(product.nutrition.basis)}`}</span><span>{product.completeness}% complete</span></div>
            <ClassificationBadges product={product} />
          </article>
        ))}
      </div>
      {data.pagination.pages > 1 && <nav className="pagination" aria-label="Catalog pages"><button disabled={page <= 1} onClick={() => onPage(page - 1)}>← Previous</button><span>Page <strong>{page}</strong> of {data.pagination.pages.toLocaleString("en-IN")}</span><button disabled={page >= data.pagination.pages} onClick={() => onPage(page + 1)}>Next →</button></nav>}
    </>
  );
}

function IngredientTree({ items }: { items: NormalizedIngredient[] }) {
  if (items.length === 0) return <p className="muted">No normalized ingredients available.</p>;
  return (
    <ol className="ingredients-list">
      {items.map((item) => (
        <li key={`${item.position}-${item.raw}`}>
          <span>{item.normalizedName ?? item.raw}</span>
          {item.percentage !== null && <b>{item.percentage}%</b>}
          {item.children.length > 0 && <IngredientTree items={item.children} />}
        </li>
      ))}
    </ol>
  );
}

function ProductDrawer({ detail, loading, error, onClose }: {
  detail: ProductDetailResponse | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-label="Product evidence detail">
        <button ref={closeRef} className="close" onClick={onClose} aria-label="Close product detail">×</button>
        {loading && <div className="loading">Loading product evidence…</div>}
        {error && <div className="error-state">{error}</div>}
        {detail && (
          <>
            <header className="detail-head">
              <ProductVisual product={detail} size="large" />
              <div><p className="eyebrow">{detail.brand} · {detail.category.replaceAll("_", " ")}</p><h2>{detail.name}</h2><p>{detail.flavour ?? "No flavour declared"} · GTIN {detail.gtin ?? "not recorded"}</p><ClassificationBadges product={detail} /></div>
            </header>

            {detail.nutritionStatus !== "verified" && <div className={`evidence-notice evidence-notice-${detail.nutritionStatus}`}><strong>{detail.nutritionStatus === "missing" ? "Nutrition is missing" : detail.nutritionStatus === "conflict" ? "Nutrition sources conflict" : "Community evidence—not label verified"}</strong><span>{detail.nutritionStatus === "unverified" ? "Validation-passing metrics are shown for discovery, but this product remains excluded from Trusted comparisons until a current label or authoritative source is verified." : "This product is excluded from trusted comparisons until the evidence gap is resolved."}</span></div>}

            <section className="trust-panel">
              <div><span>Nutrition</span><StatusBadge status={detail.nutritionStatus} /></div>
              <div><span>Ingredients</span><StatusBadge status={detail.ingredientStatus} /></div>
              <div><span>Completeness</span><strong>{detail.completeness}%</strong></div>
              <div><span>Open reviews</span><strong>{detail.openReviewCount}</strong></div>
            </section>

            <section>
              <div className="section-title"><h3>Nutrition · {nutritionBasisLabel(detail.nutrition.basis)}</h3><small>{detail.nutrition.labelVerifiedAt ? `label verified ${new Date(detail.nutrition.labelVerifiedAt).toLocaleDateString("en-IN")}` : "not label verified"}</small></div>
              <div className="nutrition-grid">
                {[
                  ["Energy", detail.nutrition.calories, "kcal"],
                  ["Protein", detail.nutrition.proteinGrams, "g"],
                  ["Carbohydrate", detail.nutrition.carbohydrateGrams, "g"],
                  ["Sugar", detail.nutrition.sugarGrams, "g"],
                  ["Fat", detail.nutrition.fatGrams, "g"],
                  ["Saturated fat", detail.nutrition.saturatedFatGrams, "g"],
                  ["Fibre", detail.nutrition.fibreGrams, "g"],
                  ["Sodium", detail.nutrition.sodiumMg, "mg"],
                ].map(([label, value, unit]) => <div key={String(label)}><span>{label}</span><strong>{formatNumber(value as number | null)} {unit}</strong></div>)}
              </div>
            </section>

            <section>
              <h3>Comparison metrics</h3>
              <div className="metric-grid">
                <div><span>Protein / 100 kcal</span><strong><MetricValue result={detail.metrics.proteinPer100Calories} suffix=" g" /></strong></div>
                <div><span>Calories from protein</span><strong><MetricValue result={detail.metrics.proteinCaloriePercentage} suffix="%" /></strong></div>
                <div><span>Cost / 25 g protein</span><strong><MetricValue result={detail.metrics.costPer25gProtein} prefix="₹" /></strong></div>
                <div><span>Calories for 25 g protein</span><strong><MetricValue result={detail.metrics.caloriesFor25gProtein} suffix=" kcal" /></strong></div>
                <div><span>Sugar / 25 g protein</span><strong><MetricValue result={detail.metrics.sugarPer25gProtein} suffix=" g" /></strong></div>
                <div><span>Protein / ₹100</span><strong><MetricValue result={detail.metrics.proteinPerInr100} suffix=" g" /></strong></div>
              </div>
            </section>

            <section>
              <div className="section-title"><h3>Ingredients</h3><StatusBadge status={detail.ingredientStatus} /></div>
              <p className="ingredient-raw">{detail.ingredientStatement ?? "No ingredient statement available."}</p>
              <IngredientTree items={detail.ingredients} />
              <div className="evidence-groups">
                <div><h4>Allergens</h4>{detail.allergens.length ? detail.allergens.map((item) => <span className={`tag allergen-${item.declaration}`} key={`${item.name}-${item.declaration}`}>{item.declaration.replace("_", " ")}: {item.name}</span>) : <span className="muted">None declared</span>}</div>
                <div><h4>Additives</h4>{detail.additives.length ? detail.additives.map((item) => <span className="tag" key={item}>{item}</span>) : <span className="muted">None mapped</span>}</div>
              </div>
            </section>

            <section>
              <h3>Offers and retailer ratings</h3>
              <div className="mini-table">
                {detail.offers.map((offer) => <div key={`${offer.retailer}-${offer.listingId}-${offer.observedAt}`}><span>{offer.retailer}<small>{offer.pincode ?? "all India"} · {new Date(offer.observedAt).toLocaleDateString("en-IN")}</small></span><strong>₹{formatNumber(offer.sellingPrice, 0)}</strong></div>)}
              </div>
              <div className="ratings">{detail.ratings.map((rating) => <span key={`${rating.retailer}-${rating.observedAt}`}><strong>{rating.stars.toFixed(1)}★</strong> {rating.ratingCount.toLocaleString("en-IN")} ratings · {rating.retailer}</span>)}</div>
            </section>

            <section>
              <h3>Selected-field provenance</h3>
              {detail.completenessMissing.length > 0 && <div className="missing-fields"><strong>Still missing</strong>{detail.completenessMissing.map((item) => <span className="tag" key={item}>{item.replaceAll("_", " ")}</span>)}</div>}
              <div className="provenance">
                {detail.provenance.map((item, index) => (
                  <details key={`${item.field}-${item.source}-${index}`} open={item.selected}>
                    <summary><span>{item.field}</span><span className="tag">{item.selected ? "selected value" : "source alternative"}</span></summary>
                    <dl><dt>Source</dt><dd>{item.source}</dd><dt>Authority</dt><dd>{item.authority}/100</dd><dt>Observed</dt><dd>{new Date(item.observedAt).toLocaleString("en-IN")}</dd><dt>Value</dt><dd><code>{JSON.stringify(item.normalized)}</code></dd></dl>
                  </details>
                ))}
              </div>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function NutritionCandidateEvidence({ candidate, productName }: { candidate: ReviewNutritionCandidate; productName: string | null }) {
  const rows: Array<[string, number | null, string]> = [
    ["Energy", candidate.nutritionPer100g.calories, "kcal"],
    ["Protein", candidate.nutritionPer100g.proteinGrams, "g"],
    ["Carbohydrate", candidate.nutritionPer100g.carbohydrateGrams, "g"],
    ["Sugar", candidate.nutritionPer100g.sugarGrams, "g"],
    ["Fat", candidate.nutritionPer100g.fatGrams, "g"],
    ["Saturated fat", candidate.nutritionPer100g.saturatedFatGrams, "g"],
    ["Fibre", candidate.nutritionPer100g.fibreGrams, "g"],
    ["Sodium", candidate.nutritionPer100g.sodiumMg, "mg"],
  ];
  return (
    <section className="nutrition-candidate" aria-label="Extracted nutrition candidate">
      <a className="candidate-label" href={candidate.imageUrl} target="_blank" rel="noreferrer">
        <img src={candidate.imageUrl} alt={`Nutrition label evidence for ${productName ?? "product"}`} loading="lazy" referrerPolicy="no-referrer" />
        <span>Open full label ↗</span>
      </a>
      <div className="candidate-evidence">
        <div className="candidate-evidence-head">
          <div><span className="eyebrow">Review candidate</span><h4>Extracted per 100 g</h4></div>
          <span className="confidence">{formatNumber(candidate.minimumConfidence * 100, 1)}% min confidence</span>
        </div>
        <div className="candidate-nutrition-grid">
          {rows.map(([label, value, unit]) => <div key={label}><span>{label}</span><strong>{formatNumber(value)} {unit}</strong></div>)}
        </div>
        <dl className="candidate-meta">
          <div><dt>Label observed</dt><dd>{new Date(candidate.observedAt).toLocaleString("en-IN")}</dd></div>
          <div><dt>Normalization</dt><dd>{candidate.basis === "per_serving" ? "Converted from explicit serving values" : "Explicit per-100-g values"}</dd></div>
          <div><dt>Model evidence</dt><dd>{candidate.modelVersion} · prediction {candidate.predictionId} · image {candidate.imageId}</dd></div>
        </dl>
        <p className="candidate-warning"><strong>Human check required.</strong> Confirm this is the current package and every displayed value matches the label before verification.</p>
      </div>
    </section>
  );
}

function IngredientCandidateEvidence({
  candidate,
  productName,
  reviewedText,
  onReviewedText,
  readOnly,
}: {
  candidate: ReviewIngredientCandidate;
  productName: string | null;
  reviewedText: string;
  onReviewedText: (value: string) => void;
  readOnly: boolean;
}) {
  const recognized = candidate.ingredientCount > 0
    ? candidate.knownIngredientCount / candidate.ingredientCount * 100
    : 0;
  return (
    <section className="ingredient-candidate" aria-label="Extracted ingredient candidate">
      <a className="candidate-label ingredient-label" href={candidate.imageUrl} target="_blank" rel="noreferrer">
        <img src={candidate.imageUrl} alt={`Ingredient label evidence for ${productName ?? "product"}`} loading="lazy" referrerPolicy="no-referrer" />
        <span>Open full label ↗</span>
      </a>
      <div className="candidate-evidence ingredient-evidence">
        <div className="candidate-evidence-head">
          <div><span className="eyebrow">Human transcription gate</span><h4>Image beside extracted text</h4></div>
          <span className={`confidence${candidate.hasConflict ? " confidence-conflict" : ""}`}>
            {candidate.hasConflict ? "conflicting images" : `${formatNumber(candidate.entityConfidence * 100, 2)}% OCR confidence`}
          </span>
        </div>
        <div className="ingredient-text-compare">
          <div>
            <span>Immutable model extraction</span>
            <p>{candidate.entityText}</p>
          </div>
          <label>
            Reviewer-confirmed visible label text
            <textarea
              value={reviewedText}
              onChange={(event) => onReviewedText(event.target.value)}
              readOnly={readOnly}
              maxLength={25_000}
              rows={6}
              aria-describedby={`ingredient-help-${candidate.candidateHash}`}
            />
          </label>
        </div>
        <p className="candidate-warning" id={`ingredient-help-${candidate.candidateHash}`}>
          <strong>Do not trust confidence alone.</strong> Correct every visible OCR error; reject the candidate if this image is cropped, unreadable, or a different variant.
        </p>
        <div className="ingredient-counts" aria-label="Ingredient extraction counts">
          <div><span>Detected</span><strong>{candidate.ingredientCount}</strong></div>
          <div><span>Known</span><strong>{candidate.knownIngredientCount}</strong></div>
          <div><span>Unknown</span><strong>{candidate.unknownIngredientCount}</strong></div>
          <div><span>Taxonomy match</span><strong>{formatNumber(recognized, 1)}%</strong></div>
        </div>
        {candidate.warnings.length > 0 && <ul className="candidate-warnings">
          {candidate.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{warning.code.replaceAll("_", " ")}</strong><span>{warning.message}</span></li>)}
        </ul>}
        <details className="parsed-ingredient-tree">
          <summary>Inspect source-parsed ingredient tree</summary>
          <pre>{JSON.stringify(candidate.parsedIngredients, null, 2)}</pre>
        </details>
        <dl className="candidate-meta">
          <div><dt>Label observed</dt><dd>{new Date(candidate.observedAt).toLocaleString("en-IN")}</dd></div>
          <div><dt>Language</dt><dd>{candidate.language.code} · {formatNumber(candidate.language.confidence * 100, 1)}% confidence</dd></div>
          <div><dt>Model evidence</dt><dd>{candidate.modelVersion} · prediction {candidate.predictionId} · entity {candidate.entityIndex} · image {candidate.imageId}</dd></div>
          <div><dt>Candidate hash</dt><dd><code>{candidate.candidateHash}</code></dd></div>
        </dl>
      </div>
    </section>
  );
}

function Reviews({ data, loading, error, onResolve, onOpenProduct, readOnly = false }: {
  data: ReviewResponse | null;
  loading: boolean;
  error: string | null;
  onResolve: (item: ReviewItem, decision: string, rationale: string, evidenceUrl: string | null, candidateProductId: string | null, reviewedText: string | null) => Promise<void>;
  onOpenProduct: (id: string) => void;
  readOnly?: boolean;
}) {
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [reviewedTexts, setReviewedTexts] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  if (loading) return <div className="loading">Loading review queue…</div>;
  if (error) return <div className="error-state">{error}</div>;
  if (!data?.items.length) return <div className="empty"><strong>Review queue is clear.</strong><span>New conflicts and evidence gaps will appear here.</span></div>;
  return (
    <div className="review-layout">
      {readOnly && <div className="read-only-notice"><strong>Public read-only view</strong><span>Evidence can be inspected here. Decisions stay disabled until operator authentication is configured.</span></div>}
      <div className="queue-summary"><strong>{data.counts.open}</strong><span>open</span><strong>{data.counts.resolved}</strong><span>resolved</span></div>
      {data.items.map((item) => {
        const candidate = reviewNutritionCandidate(item.evidence);
        const ingredientCandidate = reviewIngredientCandidate(item.evidence);
        const evidenceUrl = evidenceUrls[item.id] ?? candidate?.imageUrl ?? ingredientCandidate?.imageUrl ?? "";
        const reviewedText = reviewedTexts[item.id] ?? ingredientCandidate?.entityText ?? "";
        return (
        <article className={`review-card${candidate || ingredientCandidate ? " review-card-candidate" : ""}`} key={item.id}>
          <header><span className="priority">P{item.priority}</span><div><h3>{item.productName ?? "Unmatched source record"}</h3><p>{item.brand ?? item.sourceRecordId} · {item.type.replaceAll("_", " ")}</p></div></header>
          {candidate && <NutritionCandidateEvidence candidate={candidate} productName={item.productName} />}
          {ingredientCandidate && <IngredientCandidateEvidence
            candidate={ingredientCandidate}
            productName={item.productName}
            reviewedText={reviewedText}
            onReviewedText={(value) => setReviewedTexts((current) => ({ ...current, [item.id]: value }))}
            readOnly={readOnly}
          />}
          <details className="raw-evidence"><summary>Inspect raw evidence</summary><pre>{JSON.stringify(item.evidence, null, 2)}</pre></details>
          {item.type === "identity" && (
            <div className="identity-review">
              <div className="section-title"><h4>Candidate products</h4>{item.productId && <button className="text-button" onClick={() => onOpenProduct(item.productId!)}>Inspect incoming record</button>}</div>
              {item.candidates.map((candidate) => (
                <div className="candidate-row" key={candidate.id}>
                  <button className="candidate-detail" onClick={() => onOpenProduct(candidate.id)}>
                    <strong>{candidate.name}</strong>
                    <span>{candidate.brand}{candidate.flavour ? ` · ${candidate.flavour}` : ""}</span>
                    <small>GTIN {candidate.gtin ?? "missing"} · {candidate.netQuantityGrams ? `${formatNumber(candidate.netQuantityGrams, 0)} g` : "pack missing"}</small>
                  </button>
                  {!readOnly && <button disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "match", rationales[item.id] ?? "", null, candidate.id, null).finally(() => setWorking(null)); }}>Match</button>}
                </div>
              ))}
            </div>
          )}
          {!readOnly && <><label>Decision rationale<textarea value={rationales[item.id] ?? ""} onChange={(event) => setRationales((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="What evidence supports this decision?" /></label>
          {item.type !== "identity" && <label>Label or authoritative evidence URL<input type="url" value={evidenceUrl} onChange={(event) => setEvidenceUrls((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="https://… current label or official record" /></label>}
          <div className="review-actions">
            {item.type.includes("nutrition") || item.type === "coverage_gap" ? <><button disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "verify_nutrition", rationales[item.id] ?? "", evidenceUrl || null, null, null).finally(() => setWorking(null)); }}>{candidate ? "Verify exact label values" : "Verify nutrition"}</button><button className="secondary" disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "reject_nutrition", rationales[item.id] ?? "", evidenceUrl || null, null, null).finally(() => setWorking(null)); }}>Reject candidate</button></> : null}
            {ingredientCandidate && <><button disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "verify_ingredients", rationales[item.id] ?? "", evidenceUrl || null, null, reviewedText).finally(() => setWorking(null)); }}>Verify reviewed label text</button><button className="secondary" disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "reject_ingredients", rationales[item.id] ?? "", evidenceUrl || null, null, null).finally(() => setWorking(null)); }}>Reject this candidate</button></>}
            {item.type === "identity" && <><button disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "create_new", rationales[item.id] ?? "", null, null, null).finally(() => setWorking(null)); }}>Create distinct product</button><button className="secondary" disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "no_match", rationales[item.id] ?? "", null, null, null).finally(() => setWorking(null)); }}>Keep unmatched</button></>}
            <button className="ghost" disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "dismiss", rationales[item.id] ?? "", evidenceUrl || null, null, null).finally(() => setWorking(null)); }}>Dismiss</button>
          </div></>}
        </article>
      )})}
    </div>
  );
}

function Coverage({ data, loading, error }: { data: CoverageResponse | null; loading: boolean; error: string | null }) {
  if (loading) return <div className="loading">Reconciling coverage…</div>;
  if (error) return <div className="error-state">{error}</div>;
  if (!data) return null;
  const cards = [
    ["Catalog products", data.catalog.products],
    ["Valid GTIN", data.catalog.validGtin],
    ["Structured nutrition", data.catalog.structuredNutrition],
    ["Nutrition label images", data.catalog.nutritionLabelImages],
    ["Extraction candidates", data.catalog.extractionCandidates],
    ["Verified nutrition", data.catalog.verifiedNutrition],
    ["Verified ingredients", data.catalog.verifiedIngredients],
    ["Outstanding nutrition", data.completion.outstandingNutrition],
    ["Outstanding ingredients", data.completion.outstandingIngredients],
  ];
  return (
    <div className="coverage-page">
      <div className={`coverage-gate coverage-gate-${data.completion.status}`}><div><span>Data completion gate</span><strong>{data.completion.status}</strong></div><p>{data.completion.status === "complete" ? "Every active product has terminal verified evidence." : `${data.completion.outstandingNutrition.toLocaleString("en-IN")} nutrition, ${data.completion.outstandingIngredients.toLocaleString("en-IN")} ingredient, and ${data.completion.outstandingIdentity.toLocaleString("en-IN")} identity records still need terminal evidence.`}</p></div>
      <div className="coverage-warning"><strong>Coverage claim: configured sources only.</strong><span>Source exhaustion and verified product completeness are separate gates.</span></div>
      <div className="coverage-grid">{cards.map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{Number(value).toLocaleString("en-IN")}</strong></div>)}</div>
      <section className="panel"><h2>Source ledger</h2>{data.sources.map((source) => <div className="source-row" key={source.id}><div><strong>{source.name}</strong><span>{source.kind}</span></div><span className="tag">{source.sourceComplete ? "source complete" : "source incomplete"}</span><div><strong>{source.indiaRecords?.toLocaleString("en-IN") ?? "—"}</strong><span>India records</span></div><div><strong>{source.latestRunStatus ?? "never"}</strong><span>{source.latestRunAt ? new Date(source.latestRunAt).toLocaleString("en-IN") : "no completed run"}</span></div></div>)}</section>
      <section className="panel"><h2>Disconnected discovery sources</h2><div className="badge-row">{data.disconnectedSources.map((source) => <span className="tag" key={source}>{source.replaceAll("_", " ")}</span>)}</div></section>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("catalog");
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(filters.q);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogState, setCatalogState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [reviews, setReviews] = useState<ReviewResponse | null>(null);
  const [reviewState, setReviewState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [coverageState, setCoverageState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const isPublic = typeof window !== "undefined" && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

  const params = useMemo(() => {
    const value = new URLSearchParams({ ...filters, q: deferredQuery, page: String(page), pageSize: "50" });
    return value;
  }, [filters, deferredQuery, page]);

  const updateFilters = (next: Partial<typeof initialFilters>) => {
    setPage(1);
    setFilters((current) => ({ ...current, ...next }));
  };

  const showTrusted = () => updateFilters({ verification: "verified", scope: "protein", sort: "protein_density" });
  const showDiscovery = () => updateFilters({ verification: "all", scope: "all", sort: "protein_density" });

  const loadCatalog = () => {
    const controller = new AbortController();
    setCatalogState({ loading: true, error: null });
    api.catalog(params, controller.signal)
      .then((result) => { setCatalog(result); setCatalogState({ loading: false, error: null }); })
      .catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setCatalogState({ loading: false, error: error instanceof Error ? error.message : String(error) }); });
    return controller;
  };

  useEffect(() => {
    const controller = loadCatalog();
    return () => controller.abort();
  }, [params]);

  const loadCoverage = () => {
    setCoverageState({ loading: true, error: null });
    api.coverage().then((result) => { setCoverage(result); setCoverageState({ loading: false, error: null }); }).catch((error: unknown) => setCoverageState({ loading: false, error: error instanceof Error ? error.message : String(error) }));
  };

  useEffect(() => {
    loadCoverage();
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    const controller = new AbortController();
    setDetailState({ loading: true, error: null });
    api.product(selectedId, controller.signal).then((result) => { setDetail(result); setDetailState({ loading: false, error: null }); }).catch((error: unknown) => { if (error instanceof DOMException && error.name === "AbortError") return; setDetailState({ loading: false, error: error instanceof Error ? error.message : String(error) }); });
    return () => controller.abort();
  }, [selectedId]);

  const loadReviews = () => {
    setReviewState({ loading: true, error: null });
    api.reviews().then((result) => { setReviews(result); setReviewState({ loading: false, error: null }); }).catch((error: unknown) => setReviewState({ loading: false, error: error instanceof Error ? error.message : String(error) }));
  };

  useEffect(() => { if (tab === "reviews") loadReviews(); }, [tab]);

  const resolve = async (item: ReviewItem, decision: string, rationale: string, evidenceUrl: string | null, candidateProductId: string | null, reviewedText: string | null) => {
    if (rationale.trim().length < 3) { setReviewState((state) => ({ ...state, error: "Add a rationale of at least 3 characters." })); return; }
    if (["verify_nutrition", "verify_ingredients"].includes(decision) && !evidenceUrl) { setReviewState((state) => ({ ...state, error: "Verification requires a current label or authoritative-source URL." })); return; }
    if (decision === "verify_ingredients" && !reviewedText?.trim()) { setReviewState((state) => ({ ...state, error: "Ingredient verification requires the reviewer-confirmed visible label text." })); return; }
    await api.resolveReview(item.id, decision, rationale, evidenceUrl, candidateProductId, reviewedText);
    loadReviews();
    loadCatalog();
    loadCoverage();
    if (selectedId === item.productId && selectedId) api.product(selectedId).then(setDetail);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to catalog content</a>
      <header className="topbar">
        <button className="brand-home" onClick={() => setTab("catalog")} aria-label="Open Protein Index catalog"><span className="brand-mark">PI</span><span><small>Indian food evidence</small><strong>Protein Index</strong></span></button>
        <nav aria-label="Primary navigation">
          {(["catalog", "coverage", "reviews"] as const).map((item) => <button key={item} aria-pressed={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "reviews" ? "Evidence queue" : item}{item === "reviews" && reviews?.counts.open ? <b>{reviews.counts.open}</b> : null}</button>)}
        </nav>
        <div className="source-pill"><i />{health?.latestPublishedAt ? `Evidence updated ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(health.latestPublishedAt))}` : "Evidence catalog"}</div>
      </header>

      <main id="main-content">
        {tab === "catalog" && (
          <>
            <section className="hero-row">
              <div><p className="eyebrow">A living index of Indian food labels</p><h2>What’s in the pack<br /><em>before</em> the promise.</h2><p>Search canonical products, inspect where each value came from, and compare protein with the evidence state attached.</p></div>
              <div className="hero-orbit" aria-hidden="true"><span>{coverage?.catalog.products.toLocaleString("en-IN") ?? "—"}</span><small>foods indexed</small><i /></div>
            </section>
            <section className="catalog-overview" aria-label="Catalog overview">
              <div><span>Catalog</span><strong>{coverage?.catalog.products.toLocaleString("en-IN") ?? "—"}</strong><small>canonical food records</small></div>
              <div><span>Protein discovery</span><strong>{coverage?.catalog.marketedProtein.toLocaleString("en-IN") ?? "—"}</strong><small>marketed protein products</small></div>
              <div><span>Nutrition evidence</span><strong>{coverage ? (coverage.catalog.verifiedNutrition + coverage.catalog.unverifiedNutrition).toLocaleString("en-IN") : "—"}</strong><small>{coverage?.catalog.verifiedNutrition.toLocaleString("en-IN") ?? "—"} label verified</small></div>
              <div><span>Ingredients</span><strong>{coverage ? (coverage.catalog.verifiedIngredients + coverage.catalog.unverifiedIngredients).toLocaleString("en-IN") : "—"}</strong><small>statements captured</small></div>
              <button onClick={() => setTab("coverage")}><span>Source state</span><strong>{coverage?.completion.sourceCoverageComplete ? "Exhausted" : "Checking"}</strong><small>configured sources only →</small></button>
            </section>
            <section className="trust-switch" aria-label="Comparison trust mode">
              <div><p className="eyebrow">Choose your evidence boundary</p><strong>{catalog?.trustedDefault ? "Trusted comparisons" : "Discovery catalog"}</strong><span>{catalog?.trustedDefault ? "Only current, verified nutrition can produce rankings." : "Validation-passing community values can rank here with an unverified label; use Scope to explore every retained food."}</span></div>
              <div role="group" aria-label="Evidence boundary"><button className={catalog?.trustedDefault ? "active" : ""} aria-pressed={catalog?.trustedDefault ?? false} onClick={showTrusted}>Trusted</button><button className={catalog && !catalog.trustedDefault ? "active" : ""} aria-pressed={catalog ? !catalog.trustedDefault : false} onClick={showDiscovery}>Discovery</button></div>
            </section>
            <section className="filters" aria-label="Catalog filters">
              <label className="search-field"><span>Search the index</span><input type="search" value={filters.q} onChange={(event) => updateFilters({ q: event.target.value })} placeholder="Try Amul, whey, paneer, or a GTIN" /></label>
              <label>Category<select value={filters.category} onChange={(event) => updateFilters({ category: event.target.value })}><option value="all">All categories</option><option value="protein_powder">Protein powder</option><option value="protein_bar">Protein bars</option><option value="protein_snack">Protein snacks</option><option value="soy_product">Soy products</option><option value="dairy">Dairy</option><option value="ready_to_drink">Ready to drink</option><option value="breakfast">Breakfast</option><option value="spread">Spreads</option><option value="other">Other food</option></select></label>
              <label>Evidence<select value={filters.verification} onChange={(event) => updateFilters({ verification: event.target.value })}><option value="verified">Verified nutrition</option><option value="unverified">Unverified</option><option value="conflict">Conflicts</option><option value="missing">Missing</option><option value="all">All evidence</option></select></label>
              <label>Scope<select value={filters.scope} onChange={(event) => updateFilters({ scope: event.target.value })}><option value="protein">Protein cohorts</option><option value="all">All ingested foods</option></select></label>
              <label>Sort<select value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value })}><option value="protein_density">Protein density</option><option value="cost">Cost / 25 g</option><option value="completeness">Completeness</option><option value="name">Name</option></select></label>
            </section>
            <div className="result-meta"><span>{catalog?.pagination.total.toLocaleString("en-IN") ?? "—"} results</span><small>Missing values stay missing. Unverified values never enter trusted metrics.</small></div>
            {catalogState.loading && <div className="loading"><span className="loader" />Querying canonical catalog…</div>}
            {catalogState.error && <div className="error-state"><strong>Catalog unavailable</strong><span>{catalogState.error}</span><button onClick={loadCatalog}>Try again</button></div>}
            {catalog && !catalogState.loading && !catalogState.error && <CatalogTable data={catalog} onOpen={setSelectedId} onExplore={showDiscovery} page={page} onPage={setPage} />}
          </>
        )}
        {tab === "reviews" && <><section className="page-head"><p className="eyebrow">Human verification gate</p><h2>Evidence review queue</h2><p>{isPublic ? "Inspect unresolved evidence. Production decisions remain read-only until operator authentication is in place." : "Resolve conflicts without discarding the original source record."}</p></section><Reviews data={reviews} loading={reviewState.loading} error={reviewState.error} onResolve={resolve} onOpenProduct={setSelectedId} readOnly={isPublic} /></>}
        {tab === "coverage" && <><section className="page-head"><p className="eyebrow">No fake completeness claims</p><h2>Coverage ledger</h2><p>Exhaustion is proved per configured source, with disconnected sources left visible.</p></section><Coverage data={coverage} loading={coverageState.loading} error={coverageState.error} /></>}
      </main>
      <footer><span>Protein Index</span><p>Evidence before rankings. Configured-source coverage, never a claim of the whole Indian market.</p><button onClick={() => setTab("coverage")}>Read the coverage ledger</button></footer>
      {selectedId && <ProductDrawer detail={detail} loading={detailState.loading} error={detailState.error} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
