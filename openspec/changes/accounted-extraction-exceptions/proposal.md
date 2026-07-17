## Why

An exhaustive extraction run should prove that every requested product was accounted for without requiring unreliable third-party image hosts to return successfully forever. The current all-or-nothing gate discards thousands of valid, checksummed outcomes when a very small number of products have explicit fetch or size failures, even though those failures can remain unverified and excluded from Trusted comparisons.

## What Changes

- Distinguish complete request accounting from complete evidence verification in extraction manifests and publication validation.
- Permit a bounded residual-exception set only when every requested barcode has exactly one checksummed outcome and the exception count stays below both an absolute and proportional safety limit.
- Preserve every failed attempt in the run artifact; classify it as a product-level residual exception only when no independent exact-current verified or terminal field evidence resolves that product's completion state.
- Publish successful candidate, no-prediction, and rejected outcomes while importing failed outcomes only as current extraction state; never infer nutrition, ingredients, identity, or terminal-unavailable facts from a failure.
- Keep failure-only products out of Trusted comparisons and route them to explicit retry or manual-evidence lanes; a failed extraction does not revoke separately verified exact-current evidence.
- Fail closed on missing outcomes, duplicate accounting, unknown reason codes, checksum drift, decision drift, or an exception set above the configured bound.
- Require an explicit manual production-publication dispatch with a hard confirmation input; successful producer runs must never trigger a credentialed publication job. This change does not authorize a migration, data publication, or deployment.

## Capabilities

### New Capabilities

- `accounted-extraction-exceptions`: Defines exhaustive accounting, bounded residual-exception publication, fail-closed validation, and product-visible exception provenance.

### Modified Capabilities

None.

## Impact

- Extraction manifests, artifact validators, the manual publication workflow, and response-cache restoration.
- Nutrition and ingredient extraction adapters and their deterministic outcome ledgers.
- Reconciliation/import code that records extraction attempts and per-product reason codes without promoting facts.
- Coverage/completion APIs and dashboard lanes, including attempt-level failure accounting for requests that produced no label asset.
- Unit, Worker/D1, workflow-contract, replay, and artifact-accounting tests.
