## 1. Composite discovery artifact

- [x] 1.1 Define and validate a checksummed multi-source official-brand publication manifest.
- [x] 1.2 Aggregate, per-source deduplicate, and account for every configured artifact from one discovery workflow run.
- [ ] 1.3 Add fixture coverage for missing, incomplete, checksum-mismatched, and cross-run source artifacts.

## 2. Multi-source reconciliation

- [x] 2.1 Extend import generation to preserve a distinct source and ingestion run for each constituent brand snapshot in one D1-compatible import file.
- [ ] 2.2 Preserve GTIN-first/composite identity resolution, first-party offers, and unresolved identity review behavior across source sets.
- [x] 2.3 Add idempotency and trust-boundary tests for a new product, shared GTIN, and unverified first-party nutrition.

## 3. Guarded production publication

- [x] 3.1 Add a protected manually dispatched workflow that pins a complete official-brand discovery run and validates it before remote credentials.
- [x] 3.2 Add source/product/offer pre/postcondition diagnostics and refusal on pending migrations or incomplete cohorts.
- [x] 3.3 Document the producer-to-publication path and configured-source coverage wording.

## 4. Verification and release

- [ ] 4.1 Run a local rehearsal from the latest complete official-brand artifacts and inspect exact deltas.
- [ ] 4.2 Run focused tests, full `pnpm check`, OpenSpec validation, and workflow syntax checks.
- [ ] 4.3 Publish only the reviewed complete cohort, then verify live API coverage and product lookup without claiming market completeness.
