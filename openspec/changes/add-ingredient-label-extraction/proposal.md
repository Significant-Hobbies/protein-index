## Why

The catalog has 5,246 community ingredient statements but no verified ingredient
statements, while many products already retain ingredient-label images. The
official Robotoff ingredient-detection model can turn those images into
source-linked review candidates, closing a major accuracy gap without treating
OCR or community text as authoritative.

## What Changes

- Exhaust the configured products with ingredient-label images through the
  official Robotoff image-prediction API using resumable, rate-bounded requests.
- Parse `ner` predictions from `ingredient_detection`, retaining exact extracted
  text, image, model/version, timestamps, language confidence, entity score,
  bounding box, parsed ingredient tree, and known/unknown ingredient counts.
- Reject malformed, low-confidence, conflicting, or identity-mismatched output
  before it can become a selectable candidate.
- Stage plausible extraction as ingredient review evidence only; model output
  never automatically becomes a verified ingredient statement.
- Add an evidence-first operator review surface and durable verify/reject
  decisions bound to exact source and candidate hashes.
- Replay unchanged ingredient decisions during re-import and invalidate trust
  when the source record or candidate changes.
- Export and publish reviewed ingredient decisions through the existing
  checksummed, commit-pinned production lane with exact postconditions.
- Add exhaustive GitHub automation and terminal barcode accounting for the
  ingredient-image cohort.

## Capabilities

### New Capabilities

- `ingredient-label-evidence`: Official Robotoff ingredient extraction,
  validation, human review, durable decisions, replay, and guarded publication.

### Modified Capabilities

None.

## Impact

- Affects Robotoff adapters, reconciliation, ingredient parsing, review APIs and
  UI, durable evidence decisions, portable bundles, coverage reporting, tests,
  and GitHub Actions.
- Extends D1 evidence-decision storage and reviewed publication from nutrition
  to ingredients while keeping public production mutations disabled.
- Uses the existing Open Food Facts/Robotoff open-data relationship and current
  package images; adds no production dependency or generic third-party OCR.
