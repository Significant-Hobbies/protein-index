## 1. Evidence contract and persistence

- [x] 1.1 Add distinct machine-verification types, authority, and API evidence metadata without changing human-reviewed semantics.
- [x] 1.2 Add immutable provenance storage for accepted machine nutrition facts, compact evidence hashes, and pinned extraction metadata.
- [x] 1.3 Add a current-label-bound projection that automatically hides stale machine evidence when label bytes or revisions change.

## 2. Local extraction and validation

- [x] 2.1 Implement a macOS Vision OCR adapter that retains text, confidences, and bounded text geometry for exact label assets.
- [x] 2.2 Implement a pinned local Qwen3-VL adapter with JSON-schema output, one-at-a-time execution, model digest capture, and content-hash caching.
- [x] 2.3 Implement deterministic normalization, literal OCR-token checks, boundary/completeness checks, unit/basis validation, and nutrition anomaly validation.
- [x] 2.4 Implement separate nutrition and ingredient acceptance decisions that fail closed on disagreement, clipping, missing declarations, or inferred text.

## 3. Benchmark and guarded publication

- [x] 3.1 Create a checksummed held-out label benchmark spanning nutrition tables, qualifiers, complete ingredients, cropped ingredients, and mixed bases.
- [x] 3.2 Add a local benchmark command and require zero accepted-field mismatches before any publisher can run.
- [x] 3.3 Add an idempotent guarded publication command that writes only accepted machine evidence and retains a release manifest hash.
- [x] 3.4 Keep source artifacts and model execution outside D1; store only accepted projections and compact provenance in D1.

## 4. Product surface and verification

- [x] 4.1 Expose machine-verified evidence separately from human-reviewed evidence in catalog APIs, filters, and product details.
- [x] 4.2 Update consumer evidence language without exposing infrastructure details.
- [x] 4.3 Add unit, reconciliation, worker API, dashboard, and regression tests for accepted, rejected, stale, and conflicting attempts.
- [ ] 4.4 Run the full check suite, the benchmark, a local import rehearsal, and a guarded production preflight before any deploy.
