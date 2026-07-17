## 1. Contracts and storage

- [x] 1.1 Add typed label-asset, extraction-run, attempt, and per-label outcome contracts with strict URL, hash, count, status, and JSON validation
- [x] 1.2 Add migration `0009` for immutable extraction runs, label assets, attempts, per-label outcomes, indexes, and exact decision linkage
- [x] 1.3 Extend migration tests for constraints, audit-row retention, current-attempt uniqueness, and extraction outcomes never entering terminal evidence

## 2. Exact label capture and artifacts

- [x] 2.1 Add a bounded streaming HTTPS image hasher with media-type, declared-length, chunk-limit, redirect, and deterministic error handling tests
- [x] 2.2 Extend nutrition extraction to emit a complete cohort, label-asset ledger, source-bound attempt, and per-prediction-image outcomes
- [x] 2.3 Extend ingredient extraction to emit the same exact label and outcome contracts without collapsing multi-image or multi-entity results
- [x] 2.4 Add family-specific artifact validators for checksums, exact cohort/outcome/label/candidate accounting, versioning, lineage, and legacy fail-closed behavior

## 3. Transactional import and guarded publication

- [x] 3.1 Extend SQL generation to import immutable extraction records and candidate evidence atomically with deterministic IDs and exact replay checks
- [x] 3.2 Bind candidate source content and future review decisions to exact extraction attempts and label-byte hashes while preserving semantic candidate hashes
- [x] 3.3 Extend publication preflight and postconditions for canonical parent snapshot, workflow/repository/branch/head lineage, artifact digest, supersession policy, exact D1 deltas, and zero fact promotion
- [x] 3.4 Update response restoration and nutrition/ingredient extraction and publication workflows to retain and validate portable label proofs
- [x] 3.5 Add ingestion tests for complete publish, tamper rejection, mixed images, failed/incomplete artifacts, source drift, superseded artifacts, and idempotent replay

## 4. Honest completion routing

- [x] 4.1 Aggregate exact current label outcomes into one bounded product/family completion row with deterministic action precedence and no row multiplication
- [x] 4.2 Require exact candidate-review binding for `review_ready`, add retry/run/manual-label lanes, and fail closed for stale verified or unavailable provenance
- [x] 4.3 Extend shared API types and Worker tests for current/stale hashes, mixed outcomes, contradictions, pagination bounds, and exact primary action IDs
- [x] 4.4 Update the dashboard with accessible outcome summaries, uniquely named multi-label links, explicit action copy, responsive layout, and component/a11y coverage

## 5. Verification and handoff

- [x] 5.1 Run focused migration, ingestion, Worker, API, component, and accessibility tests, then the full project check and strict OpenSpec validation
- [x] 5.2 Run local release preflight and browser verification, update `PROJECT_STATUS.md` with exact legacy/backfill limitations, and commit/push the checked change
- [ ] 5.3 After fresh production approval, apply pending migrations in order, generate and publish a new byte-hash-complete extraction artifact, verify exact production coverage, and deploy the Worker
