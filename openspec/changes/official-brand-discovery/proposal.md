## Why

The India-tagged Open Food Facts catalog is a useful, source-complete baseline,
but it is not an exhaustive record of products currently marketed in India.
Its 805 protein-branded records materially under-represent protein snacks and
newer products. Product discovery must expand without treating a retailer page,
an inferred nutrition panel, or an unverified market signal as canonical fact.

## What Changes

- Add a no-cost ingestion lane for explicitly configured official Indian brand
  product sitemaps and product pages, with robots-policy checks and bounded,
  resumable traversal.
- Extract product identity, GTIN where explicitly declared, product URL,
  brand-owned current offer, image URLs, and package-label URLs with complete
  raw-page provenance; do not infer macros from serving-sized JSON-LD values.
- Reconcile brand records into the existing canonical catalog using GTIN first
  and retain unmatched products as discovery records with source-specific
  availability and price observations.
- Expose source coverage and market-discovery scope truthfully so broader
  discovery cannot be mistaken for exhaustive Indian-market coverage or strict
  nutrition verification.

## Capabilities

### New Capabilities

- `official-brand-catalog-discovery`: Safely crawl configured official brand
  catalogs into provenance-bound discovery product records.

### Modified Capabilities

- None.

## Impact

- Adds a TypeScript ingestion adapter, source configuration, bounded artifacts,
  and ingestion/reconciliation tests.
- Reuses the current product, offer, source-record, identity-resolution, and
  dashboard coverage models; no new production dependency is required.
- Does not publish automatically or change the strict nutrition-trust gate.
