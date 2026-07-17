## Why

The liquid-label artifact is exhausted except for three valid additional images
whose normalized projections exactly match facts already selected for the same
canonical products. The current binary verify/reject contract cannot terminate
those review items truthfully: rejection would misstate the evidence, while a
second verification can overwrite or conflict with product-level publication.

## What Changes

- Add a terminal `redundant` evidence decision for a source-bound candidate that
  exactly matches an already verified projection for the same product and field
  family.
- Require exact product, basis, supported-value, source-content, candidate-hash,
  and evidence-image agreement before accepting redundancy.
- Resolve only the redundant review item; preserve the existing selected fact,
  provenance, and verified outcome without writing a second product fact.
- Carry redundant decisions through local review, immutable bundles, protected
  publication, replay, coverage accounting, API responses, and operator UI.
- Keep existing verify/reject decisions and bundle bytes backward compatible.

## Capabilities

### New Capabilities

- `redundant-evidence-outcomes`: Exact duplicate-evidence validation, terminal
  decisions, replay, publication, accounting, and operator display.

### Modified Capabilities

None. The repository has no archived main specs; existing change-local evidence
requirements remain compatible historical context.

## Impact

- Affects shared evidence-decision types and validators, Worker review input,
  review-bundle preparation/publication, reconciliation replay, review and
  coverage API semantics, operator UI, tests, and project status.
- Reuses the append-only evidence decision and review-item tables; no production
  dependency or database migration is expected.
- Does not publish the three remaining decisions, apply the pending migration,
  or change live verified coverage as part of implementation.
