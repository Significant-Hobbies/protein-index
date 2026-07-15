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

## Dependencies

### External

- Open Food Facts exports for bootstrap catalog and label data
- GS1 India DataKart commercial access and API terms for authoritative,
  near-real-time brand-owner catalog data (planned official source)
- Retailer-authorized APIs or evaluated data providers for current offers and ratings (planned)
- Cloudflare Workers, D1, and R2 for the hosted application (not provisioned)

### Internal

- Fleet standards and release controls in `../AGENTS.md`

## Timeline

- 2026-07-15 — private repository created; core MVP specification and implementation started
- 2026-07-15 — local catalog, D1 ingestion, Worker API, operator UI, source-complete Open Food Facts adapter, and scheduled sync workflow implemented
- 2026-07-15 — durable match/create-new/keep-unmatched identity decisions implemented and proven across import replay
- 2026-07-15 — 20 domain/ingestion tests and 7 Worker+D1 integration tests passing; live three-record India sample staged without inventing missing nutrition
- 2026-07-15 — first exhaustive Open Food Facts workflow completed: 4,535,553 rows traversed, 21,188 India-tagged rows found, and 17,732 valid product records staged
- 2026-07-15 — continuity and exclusion proof completed in GitHub Actions run `29420495106`: 17,732 unchanged staged records plus 3,456 auditable exclusions reconcile all 21,188 India-tagged rows

## Products

- `protein-index` web application and Worker API — implemented locally, not deployed
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

## Todo / Planned / Deferred / Blocked

1. Manually verify the first 500 high-demand Indian products against current package labels or authoritative brand-owner evidence.
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
10. Blocked: production deployment requires explicit approval plus provisioned D1 and R2 resources.
