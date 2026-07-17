## Why

Exact-image review is currently binary: an operator can verify only the model's
unchanged candidate or reject it. In the first 40 liquid-label reviews, 30
candidates were rejected even though the package values were readable, usually
because one supported field was omitted or serving normalization was wrong.
Reviewer-confirmed transcription is needed now to turn that evidence into
accurate, complete nutrition instead of preserving avoidable coverage gaps.

## What Changes

- Let a reviewer replace a model candidate's normalized nutrition values and
  physical basis with an exact transcription from the bound package image.
- Preserve the original model candidate and candidate hash as immutable source
  evidence while storing the reviewed projection separately in the evidence
  decision.
- Require calories and protein, explicit mass or volume basis, finite supported
  values, a rationale, and the exact HTTPS evidence image for corrected
  verification.
- Make local review, review bundles, protected publication, reconciliation, API
  detail, and operator UI use the reviewer-confirmed projection atomically.
- Show model values and reviewed values side by side, including changed and
  missing fields, before submission.
- Keep rejection behavior unchanged and never auto-verify corrected model
  output.

## Capabilities

### New Capabilities

- `reviewed-nutrition-transcription`: Source-bound human correction,
  validation, publication, replay, provenance, and display of exact label
  nutrition.

### Modified Capabilities

None. The repository has no archived main specs; existing change-local
candidate requirements remain compatible historical context.

## Impact

- Affects shared nutrition evidence-decision types and validation, Worker review
  input and transactions, review-bundle serialization/publication,
  reconciliation replay, API response types, operator review UI, tests, and
  project documentation.
- Reuses the append-only `evidence_decisions.payload_json` envelope and existing
  nutrition/provenance tables; no production dependency or schema migration is
  expected.
- Existing decisions whose payload contains only the original candidate remain
  byte-for-byte valid and replayable.
