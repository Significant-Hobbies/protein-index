# Protein Index — PROJECT STATUS

Last updated: 2026-07-15

## Why / What

Protein Index is a normalized Indian protein-product intelligence database. It
turns fragmented catalog, label, retailer, and brand data into comparable
canonical products with source-aware nutrition, offers, ratings, confidence,
and protein-value metrics.

**Users:** Indian shoppers comparing protein foods, and operators reviewing or
correcting product data.

**IN scope:** broad ingestion of Indian food records; canonical GTIN-based
products; separate marketed and nutrition-derived protein classification;
verified nutrition; raw and normalized ingredients, allergens, and additives;
configured-source coverage accounting; source-specific offers and ratings;
provenance and confidence; deterministic protein and value metrics;
entity-resolution and nutrition-conflict review.

**OUT of scope for the first release:** claiming complete Indian-market
coverage; collapsing retailer ratings into one score; unlicensed permanent
copies of retailer content; autonomous acceptance of ambiguous product matches;
ONDC integration; purchasing or checkout.

**Completion gate:** deployment is not completion. The product remains
incomplete until every active product has terminal verified identity, nutrition,
and ingredient evidence, or a current label/authoritative source explicitly
establishes that a field is not applicable or not declared. Every configured
source must also reconcile without unexplained gaps, and the rendered dashboard
must pass desktop/mobile verification.

## Dependencies

### External

- Open Food Facts exports for bootstrap catalog and label data
- GS1 India DataKart commercial access and API terms for authoritative,
  near-real-time brand-owner catalog data (planned official source)
- Retailer-authorized APIs or evaluated data providers for current offers and ratings (planned)
- Cloudflare Workers, D1, and private R2 for the hosted application (deployment
  authorized; minimal resources are provisioned during the guarded release)

### Internal

- Fleet standards and release controls in `../AGENTS.md`

## Timeline

- 2026-07-15 — private repository created; core MVP specification and implementation started
- 2026-07-15 — local catalog, D1 ingestion, Worker API, operator UI, source-complete Open Food Facts adapter, and scheduled sync workflow implemented
- 2026-07-15 — durable match/create-new/keep-unmatched identity decisions implemented and proven across import replay
- 2026-07-15 — 20 domain/ingestion tests and 7 Worker+D1 integration tests passing; live three-record India sample staged without inventing missing nutrition
- 2026-07-15 — first exhaustive Open Food Facts workflow completed: 4,535,553 rows traversed, 21,188 India-tagged rows found, and 17,732 valid product records staged
- 2026-07-15 — continuity and exclusion proof completed in GitHub Actions run `29420495106`: 17,732 unchanged staged records plus 3,456 auditable exclusions reconcile all 21,188 India-tagged rows
- 2026-07-15 — responsive evidence-first dashboard, strict trusted/discovery modes, guarded release preflight, and reviewed-snapshot D1 publication path implemented
- 2026-07-15 — APAC D1 and private R2 provisioned; 17,732 reviewed source records published into a 169 MB evidence database with 17,628 active products
- 2026-07-15 — Cloudflare Worker deployed at `https://protein-index.sarthakagrawal927.workers.dev`; live API, SPA fallback, security headers, and mutation denial verified
- 2026-07-15 — exhaustive richer Open Food Facts enrichment completed for all 17,284 valid source barcodes: 17,239 returned records, 45 explicit not-found outcomes, and zero failed or rejected outcomes
- 2026-07-15 — reviewed enrichment published with 34,971 retained source records; calories-plus-protein coverage increased from 1,688 to 7,247 products and marketed-protein coverage from 190 to 708 of 778 products
- 2026-07-16 — evidence-aware dashboard release `2e8d315d-eca7-4dcb-a009-aab051d9b233` deployed; live health, exact default query, descending protein-density order, completion gate, mutation denial, security headers, and provider-neutral consumer copy verified
- 2026-07-16 — live ranking audit caught contradictory community energy values; protein-energy and severe full-macro conflicts are now withheld from metrics and future ingestion marks them as conflicts

## Products

- `protein-index` web application and Worker API — deployed on Cloudflare at `https://protein-index.sarthakagrawal927.workers.dev`
- Offline Open Food Facts ingestion and reconciliation CLI — implemented
- Weekly/manual Open Food Facts source-sync workflow — implemented; first full continuity baseline completed in GitHub Actions run `29419259301`

## Features (shipped)

- Canonical GTIN-first product schema with source-specific offers and ratings
- Explicit missing, unverified, verified, and conflict states for nutrition and ingredients
- Generic macro/micronutrient observations and extensible product kinds
- Ingredient trees, percentages, allergens, additives, and raw evidence retention
- Protein cohorts, explainable classification, protein/value metrics, and completeness gaps
- Streaming all-India Open Food Facts TSV/JSONL staging without protein prefiltering
- Run manifests, exact snapshot deltas, continuity guardrails, and configured-source coverage ledger
- Per-record exclusion ledger that reconciles every India-tagged source row to a staged product or explicit reason
- Local fixture seed with idempotent reconciliation and authority precedence
- Durable identity decisions keyed to normalized identity evidence, with automatic invalidation when that evidence changes
- Bounded Worker catalog/detail/coverage/review API with structured errors
- Dense responsive catalog, evidence detail, coverage ledger, and separate nutrition/identity review controls
- Verification decisions require a current label or authoritative-source evidence URL
- Polished responsive catalog with global coverage summary, product imagery,
  mobile cards, explicit trusted/discovery modes, and read-only production review
- Checksummed, source-complete reviewed snapshot publication with explicit remote
  confirmation and post-import D1 verification
- Guarded Cloudflare release command with type, test, build, startup, dry-run,
  clean-main, sync, and CI gates
- Evidence-aware discovery defaults to protein grams per 100 kcal while Trusted
  mode remains verified-only
- Resumable, rate-bounded richer Open Food Facts API enrichment with exhaustive
  barcode outcome accounting
- Review-gated Robotoff label extraction with basis, unit, confidence, image,
  and anomaly validation
- Explicit completion gate separating source exhaustion, structured data,
  label-image coverage, extraction candidates, and verified product coverage
- Checksummed richer-source backfill with exact barcode accounting, zero-failure
  publication guard, and resumable per-batch response evidence

## Todo / Planned / Deferred / Blocked

1. Verify every active product's nutrition and ingredients against current
   package labels or authoritative brand-owner evidence; terminal evidence-backed
   unavailable states are allowed, inferred values are not.
2. Complete desktop/mobile browser verification; the in-app browser was unavailable during the implementation run.
3. Apply for GS1 India DataKart access and map its commercial/licensing constraints.
4. Validate Amazon and Flipkart affiliate integrations against current India terms.
5. Evaluate one quick-commerce provider using a coverage, freshness, legality, and cost scorecard.
6. Add label-image OCR extraction with anomaly validation and human review.
7. Deferred: ONDC offer ingestion until the core catalog and retailer reconciliation are stable.
8. Deferred: expand the generic nutrient/product-kind model into full macros,
   micronutrients, raw foods, foodservice, prepared dishes, and recipes after the
   protein catalog proves its accuracy and operating model.
9. Blocked: official DataKart ingestion requires a commercial agreement and private API documentation.
10. Complete sanctioned desktop/mobile visual verification when the in-app
    browser target becomes available; live API and responsive implementation
    checks are complete.
11. Continue current-label and brand-owner enrichment for the 10,037 barcodes
    still lacking a usable calories-plus-protein pair and the 12,147 barcodes
    still lacking an ingredient statement in the 17,284-barcode enrichment set.
12. Blocked: verified completeness cannot be achieved from Open Food Facts alone;
    current labels, brand-owner feeds, DataKart access, or manual verification are
    required for every remaining product.
