import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  CatalogProduct,
  CatalogResponse,
  CoverageResponse,
  ProductDetailResponse,
  ReviewItem,
  ReviewResponse,
} from "../shared/api";
import type { EvidenceStatus, MetricResult, NormalizedIngredient } from "../shared/types";
import { api } from "./api";

type Tab = "catalog" | "reviews" | "coverage";

const initialFilters = {
  q: "",
  category: "all",
  verification: "verified",
  scope: "protein",
  sort: "protein_density",
};

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? "—" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value);
}

function metric(result: MetricResult, suffix = ""): string {
  return result.value === null ? "—" : `${formatNumber(result.value, 2)}${suffix}`;
}

function MetricValue({ result, prefix = "", suffix = "" }: { result: MetricResult; prefix?: string; suffix?: string }) {
  if (result.value === null) {
    return <span className="metric-unavailable">Unavailable<small>{(result.reason ?? "missing inputs").replaceAll("_", " ")}</small></span>;
  }
  return <>{prefix}{formatNumber(result.value, 2)}{suffix}</>;
}

function StatusBadge({ status }: { status: EvidenceStatus }) {
  return <span className={`status status-${status}`}>{status}</span>;
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

function CatalogTable({ data, onOpen }: { data: CatalogResponse; onOpen: (id: string) => void }) {
  if (data.products.length === 0) {
    return <div className="empty"><strong>No products match.</strong><span>Broaden the evidence or category filters.</span></div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col">Evidence</th>
            <th scope="col">Protein</th>
            <th scope="col">Protein / 100 kcal</th>
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
                <button className="product-link" onClick={() => onOpen(product.id)}>
                  <strong>{product.name}</strong>
                  <span>{product.brand}{product.flavour ? ` · ${product.flavour}` : ""}</span>
                </button>
                <ClassificationBadges product={product} />
              </td>
              <td><StatusBadge status={product.nutritionStatus} /><small>ingredients: {product.ingredientStatus}</small></td>
              <td><strong>{formatNumber(product.nutrition.proteinGrams)} g</strong><small>per 100 g</small></td>
              <td>{metric(product.metrics.proteinPer100Calories, " g")}</td>
              <td>{metric(product.metrics.proteinCaloriePercentage, "%")}</td>
              <td>{product.metrics.costPer25gProtein.value === null ? "—" : `₹${formatNumber(product.metrics.costPer25gProtein.value, 2)}`}</td>
              <td>{product.currentOffer ? <><strong>₹{formatNumber(product.currentOffer.sellingPrice, 0)}</strong><small>{product.currentOffer.retailer} · {product.currentOffer.pincode ?? "all India"}</small></> : "—"}</td>
              <td><span className="completeness"><i style={{ width: `${product.completeness}%` }} />{product.completeness}%</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Product evidence detail">
        <button ref={closeRef} className="close" onClick={onClose} aria-label="Close product detail">×</button>
        {loading && <div className="loading">Loading product evidence…</div>}
        {error && <div className="error-state">{error}</div>}
        {detail && (
          <>
            <header className="detail-head">
              <p className="eyebrow">{detail.brand} · {detail.category.replaceAll("_", " ")}</p>
              <h2>{detail.name}</h2>
              <p>{detail.flavour ?? "No flavour declared"} · GTIN {detail.gtin ?? "unverified"}</p>
              <ClassificationBadges product={detail} />
            </header>

            <section className="trust-panel">
              <div><span>Nutrition</span><StatusBadge status={detail.nutritionStatus} /></div>
              <div><span>Ingredients</span><StatusBadge status={detail.ingredientStatus} /></div>
              <div><span>Completeness</span><strong>{detail.completeness}%</strong></div>
              <div><span>Open reviews</span><strong>{detail.openReviewCount}</strong></div>
            </section>

            <section>
              <div className="section-title"><h3>Nutrition per 100 g</h3><small>{detail.nutrition.labelVerifiedAt ? `label verified ${new Date(detail.nutrition.labelVerifiedAt).toLocaleDateString("en-IN")}` : "not label verified"}</small></div>
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

function Reviews({ data, loading, error, onResolve, onOpenProduct }: {
  data: ReviewResponse | null;
  loading: boolean;
  error: string | null;
  onResolve: (item: ReviewItem, decision: string, rationale: string, evidenceUrl: string | null, candidateProductId: string | null) => Promise<void>;
  onOpenProduct: (id: string) => void;
}) {
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);
  if (loading) return <div className="loading">Loading review queue…</div>;
  if (error) return <div className="error-state">{error}</div>;
  if (!data?.items.length) return <div className="empty"><strong>Review queue is clear.</strong><span>New conflicts and evidence gaps will appear here.</span></div>;
  return (
    <div className="review-layout">
      <div className="queue-summary"><strong>{data.counts.open}</strong><span>open</span><strong>{data.counts.resolved}</strong><span>resolved</span></div>
      {data.items.map((item) => (
        <article className="review-card" key={item.id}>
          <header><span className="priority">P{item.priority}</span><div><h3>{item.productName ?? "Unmatched source record"}</h3><p>{item.brand ?? item.sourceRecordId} · {item.type.replaceAll("_", " ")}</p></div></header>
          <pre>{JSON.stringify(item.evidence, null, 2)}</pre>
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
                  <button disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "match", rationales[item.id] ?? "", null, candidate.id).finally(() => setWorking(null)); }}>Match</button>
                </div>
              ))}
            </div>
          )}
          <label>Decision rationale<textarea value={rationales[item.id] ?? ""} onChange={(event) => setRationales((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="What evidence supports this decision?" /></label>
          {item.type !== "identity" && <label>Label or authoritative evidence URL<input type="url" value={evidenceUrls[item.id] ?? ""} onChange={(event) => setEvidenceUrls((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="https://… current label or official record" /></label>}
          <div className="review-actions">
            {item.type.includes("nutrition") || item.type === "coverage_gap" ? <><button disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "verify_nutrition", rationales[item.id] ?? "", evidenceUrls[item.id] || null, null).finally(() => setWorking(null)); }}>Verify nutrition</button><button className="secondary" disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "reject_nutrition", rationales[item.id] ?? "", evidenceUrls[item.id] || null, null).finally(() => setWorking(null)); }}>Reject candidate</button></> : null}
            {item.type === "identity" && <><button disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "create_new", rationales[item.id] ?? "", null, null).finally(() => setWorking(null)); }}>Create distinct product</button><button className="secondary" disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "no_match", rationales[item.id] ?? "", null, null).finally(() => setWorking(null)); }}>Keep unmatched</button></>}
            <button className="ghost" disabled={working === item.id} onClick={async () => { setWorking(item.id); await onResolve(item, "dismiss", rationales[item.id] ?? "", evidenceUrls[item.id] || null, null).finally(() => setWorking(null)); }}>Dismiss</button>
          </div>
        </article>
      ))}
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
    ["Verified nutrition", data.catalog.verifiedNutrition],
    ["Verified ingredients", data.catalog.verifiedIngredients],
    ["Nutrition conflicts", data.catalog.conflictingNutrition],
    ["Protein-dense", data.catalog.nutritionallyProteinDense],
  ];
  return (
    <div className="coverage-page">
      <div className="coverage-warning"><strong>Coverage claim: configured sources only.</strong><span>A source-complete run is not the same as complete coverage of the Indian market.</span></div>
      <div className="coverage-grid">{cards.map(([label, value]) => <div key={String(label)}><span>{label}</span><strong>{Number(value).toLocaleString("en-IN")}</strong></div>)}</div>
      <section className="panel"><h2>Source ledger</h2>{data.sources.map((source) => <div className="source-row" key={source.id}><div><strong>{source.name}</strong><span>{source.kind}</span></div><span className="tag">{source.sourceComplete ? "source complete" : "source incomplete"}</span><div><strong>{source.indiaRecords?.toLocaleString("en-IN") ?? "—"}</strong><span>India records</span></div><div><strong>{source.latestRunStatus ?? "never"}</strong><span>{source.latestRunAt ? new Date(source.latestRunAt).toLocaleString("en-IN") : "no completed run"}</span></div></div>)}</section>
      <section className="panel"><h2>Disconnected discovery sources</h2><div className="badge-row">{data.disconnectedSources.map((source) => <span className="tag" key={source}>{source.replaceAll("_", " ")}</span>)}</div></section>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("catalog");
  const [filters, setFilters] = useState(initialFilters);
  const deferredQuery = useDeferredValue(filters.q);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogState, setCatalogState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetailResponse | null>(null);
  const [detailState, setDetailState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [reviews, setReviews] = useState<ReviewResponse | null>(null);
  const [reviewState, setReviewState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [coverage, setCoverage] = useState<CoverageResponse | null>(null);
  const [coverageState, setCoverageState] = useState<{ loading: boolean; error: string | null }>({ loading: true, error: null });

  const params = useMemo(() => {
    const value = new URLSearchParams({ ...filters, q: deferredQuery, pageSize: "50" });
    return value;
  }, [filters, deferredQuery]);

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

  useEffect(loadCoverage, []);

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

  const resolve = async (item: ReviewItem, decision: string, rationale: string, evidenceUrl: string | null, candidateProductId: string | null) => {
    if (rationale.trim().length < 3) { setReviewState((state) => ({ ...state, error: "Add a rationale of at least 3 characters." })); return; }
    if (decision === "verify_nutrition" && !evidenceUrl) { setReviewState((state) => ({ ...state, error: "Verification requires a current label or authoritative-source URL." })); return; }
    await api.resolveReview(item.id, decision, rationale, evidenceUrl, candidateProductId);
    loadReviews();
    loadCatalog();
    loadCoverage();
    if (selectedId === item.productId && selectedId) api.product(selectedId).then(setDetail);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to catalog content</a>
      <header className="topbar">
        <div className="brand-mark">PI</div>
        <div><p className="eyebrow">Indian food evidence graph</p><h1>Protein Index</h1></div>
        <nav aria-label="Primary navigation">
          {(["catalog", "reviews", "coverage"] as const).map((item) => <button key={item} aria-pressed={tab === item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item}{item === "reviews" && reviews?.counts.open ? <b>{reviews.counts.open}</b> : null}</button>)}
        </nav>
        <div className="source-pill"><i />local evidence mode</div>
      </header>

      <main id="main-content">
        {tab === "catalog" && (
          <>
            <section className="hero-row">
              <div><p className="eyebrow">Trust the label, retain the source</p><h2>Compare protein, not marketing.</h2><p>Canonical products with verified nutrition, ingredient evidence, source-specific prices, and explainable metrics.</p></div>
              <div className="hero-stat"><strong>{catalog?.pagination.total ?? "—"}</strong><span>products in this view</span><small>{catalog?.trustedDefault ? "verified nutrition only" : "expanded evidence view"}</small></div>
            </section>
            <section className="filters" aria-label="Catalog filters">
              <label className="search-field">Search<input value={filters.q} onChange={(event) => setFilters((current) => ({ ...current, q: event.target.value }))} placeholder="Product, brand, or GTIN" /></label>
              <label>Category<select value={filters.category} onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}><option value="all">All categories</option><option value="protein_powder">Protein powder</option><option value="protein_bar">Protein bars</option><option value="protein_snack">Protein snacks</option><option value="soy_product">Soy products</option><option value="dairy">Dairy</option><option value="ready_to_drink">Ready to drink</option><option value="breakfast">Breakfast</option><option value="spread">Spreads</option><option value="other">Other food</option></select></label>
              <label>Evidence<select value={filters.verification} onChange={(event) => setFilters((current) => ({ ...current, verification: event.target.value }))}><option value="verified">Verified nutrition</option><option value="unverified">Unverified</option><option value="conflict">Conflicts</option><option value="missing">Missing</option><option value="all">All evidence</option></select></label>
              <label>Scope<select value={filters.scope} onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value }))}><option value="protein">Protein cohorts</option><option value="all">All ingested foods</option></select></label>
              <label>Sort<select value={filters.sort} onChange={(event) => setFilters((current) => ({ ...current, sort: event.target.value }))}><option value="protein_density">Protein density</option><option value="cost">Cost / 25 g</option><option value="completeness">Completeness</option><option value="name">Name</option></select></label>
            </section>
            {catalogState.loading && <div className="loading">Querying canonical catalog…</div>}
            {catalogState.error && <div className="error-state">{catalogState.error}</div>}
            {catalog && !catalogState.loading && <CatalogTable data={catalog} onOpen={setSelectedId} />}
          </>
        )}
        {tab === "reviews" && <><section className="page-head"><p className="eyebrow">Human verification gate</p><h2>Evidence review queue</h2><p>Resolve conflicts without discarding the original source record.</p></section><Reviews data={reviews} loading={reviewState.loading} error={reviewState.error} onResolve={resolve} onOpenProduct={setSelectedId} /></>}
        {tab === "coverage" && <><section className="page-head"><p className="eyebrow">No fake completeness claims</p><h2>Coverage ledger</h2><p>Exhaustion is proved per configured source, with disconnected sources left visible.</p></section><Coverage data={coverage} loading={coverageState.loading} error={coverageState.error} /></>}
      </main>
      {selectedId && <ProductDrawer detail={detail} loading={detailState.loading} error={detailState.error} onClose={() => setSelectedId(null)} />}
    </div>
  );
}
