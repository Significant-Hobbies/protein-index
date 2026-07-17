## Why

The completion ledger can show that label evidence exists, but D1 does not
retain whether the exact current label produced a candidate, no prediction, a
validation rejection, or a failed extraction. Persisting those outcomes against
immutable source and label hashes is the next prerequisite for exhaustive,
honest routing and reproducible reprocessing.

## What Changes

- Add an append-only, source-bound extraction-outcome ledger for nutrition and
  ingredient label attempts.
- Bind every outcome to the exact extraction family, adapter/model version,
  source record, product, label URL, label-content hash, and attempt time.
- Import and replay source-complete nutrition and ingredient artifacts with
  exact terminal accounting, idempotency, and stale-label invalidation.
- Preserve candidate records separately while retaining explicit
  `no_prediction`, `rejected`, and `failed` attempt evidence without promoting
  any nutrition or ingredient fact.
- Refine completion work lanes to expose current exact attempt outcomes only;
  stale or contradictory outcomes continue to fail closed.
- Add bounded API/UI evidence summaries and regression coverage for multiple
  labels, superseded hashes, and replay.
- Do not publish production data, infer unavailable facts, or automatically
  verify model output in this change.

## Capabilities

### New Capabilities

- `extraction-outcome-ledger`: Immutable, source/hash-bound extraction attempt
  outcomes, guarded artifact publication, and honest completion routing.

### Modified Capabilities

None. No repository-level main specs exist yet; the related completion-ledger
change remains unarchived and will consume this additive capability without
rewriting its terminal evidence contract.

## Impact

- Adds one forward-only D1 migration and typed extraction-outcome contracts.
- Extends nutrition and ingredient extraction artifact validators, SQL/import
  generators, protected publication workflows, and replay postconditions.
- Updates completion-ledger queries, API responses, dashboard labels, and
  Worker/D1 tests.
- Adds no production dependency and makes no remote migration or deployment.
