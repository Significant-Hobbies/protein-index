## Why

The catalog search works, but it is hidden in the full filter panel. Shoppers
need a fast, obvious way to verify whether a newly noticed protein product is
already indexed without first learning the dashboard controls.

## What Changes

- Add a compact product lookup field to the persistent dashboard header.
- Debounce lookup requests and show a small, keyboard-accessible result list
  with product name, brand, and nutrition evidence state.
- Open an exact one-result match directly in product detail; otherwise move to
  the catalog with the query retained for full comparison and filtering.
- Keep the existing catalog search and all evidence/scoping rules unchanged.

## Capabilities

### New Capabilities

- `prominent-product-lookup`: Fast, visible canonical-product lookup from the
  dashboard header.

### Modified Capabilities

- None.

## Impact

Touches the React dashboard header, catalog query orchestration, responsive
styles, and dashboard regression tests. It uses the existing read-only catalog
API and introduces no dependencies or data writes.
