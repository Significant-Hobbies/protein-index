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
verified nutrition and ingredients; source-specific offers and ratings;
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

## Products

- `protein-index` web application and Worker API — local development only
- Offline Open Food Facts ingestion CLI — planned in the active OpenSpec change

## Features (shipped)

- (none yet)

## Todo / Planned / Deferred / Blocked

1. Build the normalized catalog, ingestion, entity-resolution, metrics, API, and review/search UI.
2. Run the scheduled source-sync workflow and manually verify the first 500
   high-demand Indian products.
3. Apply for GS1 India DataKart access and map its commercial/licensing constraints.
4. Validate Amazon and Flipkart affiliate integrations against current India terms.
5. Evaluate one quick-commerce provider using a coverage, freshness, legality, and cost scorecard.
6. Add label-image OCR extraction with anomaly validation and human review.
7. Deferred: ONDC offer ingestion until the core catalog and retailer reconciliation are stable.
8. Blocked: production deployment requires explicit approval plus provisioned D1 and R2 resources.
