## Why

The catalog needs exhaustive nutrition and ingredient coverage without a human
review queue, but the current label pipeline correctly treats OCR and model
output as unverified candidates. A local benchmark shows that strong local OCR
can transcribe nutrition accurately while a vision-language model can still
invent unreadable ingredient text, so automatic publication needs an
evidence-grade acceptance contract rather than a confidence threshold.

## What Changes

- Add an offline, reproducible label-transcription lane that uses macOS Vision
  OCR for visible text and a local vision-language model only as an independent
  cross-check and label-completeness classifier.
- Introduce a distinct `machine_verified` evidence state; it must not claim
  human or brand verification.
- Accept nutrition automatically only when the exact label image is current,
  all required label text is visible, independent extractors agree after
  deterministic normalization, and unit/basis/macro validation passes.
- Accept ingredients automatically only when an `INGREDIENTS` declaration is
  fully visible, bounded, and independently reproduced. Reject crops, curved
  or obscured declarations, partial lists, and any inferred or repaired words.
- Preserve image hashes, OCR text, model/version/prompt hashes, normalized
  outputs, validation results, and rejection reasons for every attempt.
- Keep all failed, incomplete, or conflicting attempts out of rankings and
  expose them as evidence gaps for future source refreshes rather than filling
  them with guesses.

## Capabilities

### New Capabilities

- `automated-label-verification`: Offline, fail-closed machine verification of
  nutrition and ingredients from current exact label bytes.

### Modified Capabilities

- `reviewed-nutrition-transcription`: Distinguish human-reviewed exact-label
  transcription from reproducible machine-verified label transcription.

## Impact

- Affects label extraction adapters, evidence status types, reconciliation,
  publication guards, completion reporting, dashboard evidence language, and
  their tests.
- Adds no hosted inference, paid API, or production runtime dependency; model
  execution occurs in the local/GitHub-runner ingestion environment and only
  accepted evidence is stored in D1.
- Does not make incomplete source images complete, does not infer missing
  ingredients, and does not alter retailer offers or ratings.
