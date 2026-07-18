## Why

The catalog needs the broadest possible automated Indian food-product coverage
without prices, paid data providers, hosted inference, or human review. Its
current source-specific discovery and local label extraction lanes are useful
but are operated separately, and the consumer contract still over-emphasises
strict completion instead of usable, evidence-backed macro comparison.

## What Changes

- Add one local, resumable macro-catalog refresh command that combines the
  complete Open Food Facts India snapshot, configured official-brand catalogs,
  and the existing local label-verification lane without remote publication.
- Add a checked-in local scheduler template and operational command for weekly
  source reconciliation plus bounded label processing, without requiring
  GitHub Actions or a paid service.
- Treat catalog completeness as exhaustive **within configured free sources**;
  record source failures and unknown market coverage explicitly rather than
  claiming an exhaustive Indian-market list.
- Make calories and protein the required inputs for protein-per-100-calorie
  ranking. Retain products with missing macros in search and mark unavailable
  values explicitly; never estimate nutrients.
- Remove price and cost-of-protein from the default catalog experience and
  refresh workflow. Retained historical offers remain source evidence only.

## Capabilities

### New Capabilities

- `zero-cost-macro-refresh`: Reproducible local orchestration and scheduling
  for source-bounded catalog and machine-label macro refreshes.
- `source-bounded-macro-catalog`: Consumer-visible catalog/search and ranking
  behavior for declared, machine-verified, and unavailable macro evidence.

### Modified Capabilities

- None.

## Impact

- Affects ingestion scripts, local operating instructions, dashboard defaults,
  catalog API presentation, and regression tests.
- Reuses Open Food Facts, configured first-party sources, macOS Vision, and the
  existing local Qwen model; adds no production dependency or paid provider.
- Does not deploy, publish to D1, or claim human verification or complete
  Indian-market coverage.
