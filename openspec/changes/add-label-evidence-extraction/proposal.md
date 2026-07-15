## Why

The exhaustive India catalog contains 17,628 active products, but only 1,683
currently expose structured nutrition and none have label-verified nutrition.
This leaves the default catalog empty and hides the most useful comparison even
when source-attributed nutrition is available. The source snapshot also already
contains 6,008 nutrition-label images, so the missing-data problem should be
treated as an evidence-extraction and review problem rather than a catalog-size
problem.

## What Changes

- Make protein grams per 100 kcal the primary catalog comparison and default
  sort in a discovery-first view.
- Show calculated values from valid unverified nutrition as source-attributed
  estimates, while keeping trusted rankings restricted to verified evidence.
- Add a bounded enrichment path that fetches richer Open Food Facts product
  fields in documented bulk requests for the exact source-complete barcode set.
- Add a Robotoff label-evidence adapter that can retain nutrition-extraction
  predictions and label provenance as review candidates without auto-verifying
  them.
- Validate basis, units, serving-size conversion, model confidence, macro
  consistency, and image recency before a candidate can enter the catalog.
- Record enrichment coverage and failure accounting so every requested barcode
  is returned, missing, rejected, or queued for review.
- Keep official/brand/label evidence above community and model-derived data in
  field-level authority selection.
- Remove infrastructure-provider status from the consumer interface.
- Treat the release as incomplete until every active product has verified
  nutrition and ingredients, or an evidence-backed terminal not-applicable
  state, and all configured sources reconcile without unexplained gaps.

## Capabilities

### New Capabilities

- `nutrition-evidence-enrichment`: Exhaustive, rate-bounded enrichment of the
  configured India barcode set using richer source fields and review-gated
  label extraction.
- `evidence-aware-protein-ranking`: Protein per 100 kcal as the primary
  comparison, with explicit evidence state and a strict verified-only mode.

### Modified Capabilities

None. The related catalog capabilities have not yet been archived as main
specifications; this change adds the next evidence and ranking contracts.

## Impact

- Affects the Open Food Facts staging/enrichment adapters, reconciliation,
  nutrition validation, coverage reporting, Worker catalog API, dashboard
  defaults, tests, and scheduled source workflow.
- Uses documented Open Food Facts and Robotoff read APIs with identification,
  bounded batching, retries, resumable artifacts, and no credentials.
- Adds no production runtime dependency. Extracted/model values remain
  unverified until a current label or authoritative source is reviewed.
