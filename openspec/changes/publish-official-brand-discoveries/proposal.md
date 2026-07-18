## Why

The scheduled official-brand discovery job finds new protein products from 16
first-party Indian catalogs, but its artifacts never reach the canonical
catalog. As a result, the public dashboard remains behind current market
availability even when the discovery evidence is complete and provenance-bound.

## What Changes

- Add a checked, source-complete aggregation step for the configured official
  brand discovery artifacts.
- Reconcile the aggregated records with the canonical catalog using the
  existing GTIN-first identity rules, retaining unmatched variants as distinct
  discovery products and retaining first-party price observations as offers.
- Add a manually dispatched, protected publication path that validates the
  exact discovery run, artifact hashes, source completeness, and postconditions
  before inserting records into production D1.
- Expose the official-brand publication boundary in coverage metadata so users
  can distinguish configured-brand discovery from exhaustive India-market
  coverage.

## Capabilities

### New Capabilities

- `official-brand-discovery-publication`: Aggregate, reconcile, and guardedly
  publish complete configured official-brand discovery evidence into the
  canonical catalog.

### Modified Capabilities

- None.

## Impact

- Affects the official-brand GitHub Actions producer, reconciliation/import
  tooling, D1 publication checks, coverage API, and operations runbooks.
- Reuses existing source records, GTIN identity resolution, offer provenance,
  and manual production environment; no new third-party data provider or
  production dependency is introduced.
- Does not treat first-party discovery nutrition as verified, alter Trusted
  ranking rules, or claim exhaustive Indian-market coverage.
