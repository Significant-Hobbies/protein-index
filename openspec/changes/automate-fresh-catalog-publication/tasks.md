## 1. Automatic evidence validation

- [ ] 1.1 Add an automatic-publication input contract that pins the expected workflow family, source, run artifact, head SHA, and fixed discovery-drop ceiling.
- [ ] 1.2 Stream-validate staged discovery, enrichment, and Robotoff data so unsupported sources, verified staged facts, decision payloads, incomplete cohorts, and checksum drift fail before SQL generation.
- [ ] 1.3 Add unit tests for every automatic fail-closed invariant and for permitted unverified/review-only artifacts.

## 2. Safe reconciliation and publication

- [ ] 2.1 Make equal-authority selected nutrition completeness-monotonic while retaining every incoming source observation, with replay and richer-evidence regression tests.
- [ ] 2.2 Add a remote publication mode that cannot apply migrations and fails when remote D1 reports a pending migration; preserve existing manual behavior.
- [ ] 2.3 Add reusable pre/postcondition queries that pin the exact ingestion run and prove catalog/evidence counts, verified-count deltas, and idempotent replay.
- [ ] 2.4 Add focused local publication tests proving automatic refresh cannot promote verification or overwrite stronger evidence.

## 3. GitHub Actions orchestration

- [ ] 3.1 Add a default-branch `workflow_run` router with a fail-closed mapping for the four eligible producer workflows and their exact artifact/source families.
- [ ] 3.2 Use the protected production environment, exact upstream head SHA, shared non-cancelling publication concurrency group, migration precheck, and automatic CLI mode.
- [ ] 3.3 Capture manifest/artifact hashes, pre/post state, publication output, live API checks, and failure diagnostics as 90-day evidence artifacts.
- [ ] 3.4 Add static workflow-contract tests for trigger, permissions, source/artifact mapping, concurrency, environment, and prohibited migration behavior.

## 4. Documentation and release validation

- [ ] 4.1 Update README and `PROJECT_STATUS.md` with the automatic evidence boundary, recovery path, cadence, and explicit non-verification guarantee.
- [ ] 4.2 Run focused tests, full checks, release preflight, and strict OpenSpec validation.
- [ ] 4.3 Commit and push a clean synchronized `main`, then require green CI before the production proof run.

## 5. Production proof and handoff

- [ ] 5.1 Manually dispatch one complete `Source sync` on `main` and prove automatic enrichment/extraction fan-out uses the exact snapshot artifact.
- [ ] 5.2 Monitor all serialized automatic publication runs and verify exact ingestion hashes, non-empty/non-regressing counts, unchanged verified counts, and healthy live API responses.
- [ ] 5.3 Replay one exact successful artifact and prove products, source records, reviews, and decisions remain duplicate-free.
- [ ] 5.4 Archive the OpenSpec change only after every requirement and production proof is evidenced.
