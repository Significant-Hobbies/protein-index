## Why

Indian protein-product data is fragmented across brand labels, open catalogs,
and retailer listings that disagree about identity, nutrition, pack size,
price, and ratings. We need a trustworthy normalization core before collection
can scale, or the product will produce precise-looking but invalid comparisons.

## What Changes

- Add a canonical, GTIN-first product model that keeps product identity separate
  from retailer listings, offers, and ratings.
- Add field-level source observations, confidence, ingestion-run evidence, and
  deterministic precedence so lower-quality data cannot silently replace better
  data.
- Add explicit nutrition verification states (`missing`, `unverified`,
  `verified`, `conflict`) and exclude non-verified nutrition from trusted
  rankings by default.
- Add Open Food Facts JSONL ingestion for all India-tagged food records where
  practical, including validation, normalization, idempotency, and review-queue
  creation; ingestion does not depend on a record already being classified as
  protein.
- Add a provider-neutral official-source adapter contract, with DataKart as the
  authoritative planned implementation once commercial API access is granted.
- Add a scheduled GitHub Action that stages fresh source records and an import
  report as reviewable artifacts; it must not publish unreviewed catalog changes
  or require production credentials for the bootstrap path.
- Add deterministic entity resolution using exact GTIN first and conservative
  normalized attributes second; ambiguous matches remain unresolved for humans.
- Add separate marketed-protein and nutrition-derived classifications so
  discovery is broad while protein rankings remain meaningful.
- Add protein-density, protein-calorie, cost, serving, sugar, saturated-fat,
  fibre, completeness, and validation metrics with explicit missing-data states.
- Add a Worker API and React operator/search surface for catalog browsing,
  comparisons, provenance inspection, and match review.
- Seed a small, inspectable fixture catalog so the entire vertical slice works
  locally without paid services or production Cloudflare resources.

## Capabilities

### New Capabilities

- `canonical-catalog`: Canonical products, variants, nutrition, ingredients,
  nutrition verification state, ingredients, source observations, offers, and
  source-specific ratings.
- `source-aware-ingestion`: Reproducible source imports with validation,
  provenance, idempotency, and confidence-aware reconciliation.
- `scheduled-source-sync`: Automatic discovery of source updates through a
  provider adapter, scheduled workflow, durable report, and human approval gate.
- `entity-resolution`: GTIN-first matching, conservative inferred matching, and
  a durable manual-review queue for ambiguity.
- `protein-classification`: Independent marketed-protein and nutritionally
  protein-dense cohorts, including explicit neither and unknown states.
- `protein-metrics`: Named nutrition and price-derived metrics with stable
  formulas, validity checks, and explicit unavailable results.
- `catalog-experience`: Search, comparison, product detail, provenance, and
  entity-review behavior exposed through the API and operator web application.

### Modified Capabilities

- None. This is the first product change.

## Impact

- Introduces the Vite/React web application and Cloudflare Worker runtime.
- Introduces a versioned D1-compatible SQL schema and local D1 development data.
- Introduces an offline TypeScript importer for Open Food Facts JSONL records.
- Introduces a weekly/manual GitHub Actions sync workflow. Open Food Facts is the
  credential-free bootstrap source; GS1 India DataKart is the preferred
  brand-owner source but remains disabled until access and license terms exist.
- Adds production dependencies for React UI rendering and lightweight Worker
  request routing; all build, Worker, type, and test tooling remains development
  only.
- Does not provision, migrate, deploy, scrape retailers, or ingest licensed
  DataKart/Amazon/Flipkart content in this change.
