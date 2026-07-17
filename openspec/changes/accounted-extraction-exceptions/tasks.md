## 1. Artifact Contract

- [x] 1.1 Add shared residual-exception limits and manifest fields for accounting completeness, verification completeness, exception count, and exception rate.
- [x] 1.2 Update portable artifact validation to require an exact requested/outcome partition, allow-listed post-response failure reasons, successful raw response evidence, exact-subject retained assets, complete provenance, and both exception bounds.
- [x] 1.3 Add boundary tests for zero failures, 8/5,196 accepted, count-limit rejection, rate-limit rejection, missing outcomes, duplicates, and malformed failures.

## 2. Extraction Producers

- [x] 2.1 Update nutrition extraction to emit publishable fully accounted manifests with bounded post-response failed outcomes and current attempt-level provenance while preserving corrected retry-cache behavior.
- [x] 2.2 Update ingredient extraction with the same contract, exact-subject retained-asset checks, and proof that candidate, no-prediction, rejected, and failed counts sum to the requested set.
- [x] 2.3 Update workflow audits and artifact upload paths so eligible exception-bearing artifacts retain successful raw responses, label proofs, outcomes, checksums, and reviewed-decision audit evidence.

## 3. Reconciliation And Publication

- [x] 3.1 Update candidate publication validation to accept only bounded exception-bearing artifacts after every existing checksum, source-hash, response, label-byte, and decision-drift gate passes.
- [x] 3.2 Reconcile failed outcomes as extraction attempt state and reason provenance only, including failures with no retained label asset, with tests proving they create no facts, observations, identity decisions, or terminal-unavailable decisions.
- [x] 3.3 Prove replay is idempotent, independent exact-current evidence is preserved, and completion totals count only failure-without-independent-evidence products exactly once as outstanding residual exceptions.
- [x] 3.4 Add workflow-contract tests proving producer completion triggers no publication job and production publication requires a separate manual dispatch with exact confirmation before credentials or writes.

## 4. Operator And Public Truth

- [x] 4.1 Add attempt-level current failure aggregation, then verify completion APIs return the residual reason code and deterministic retry or manual-evidence lane even when no label asset was retained.
- [x] 4.2 Verify coverage and product UI expose residual exceptions, exclude them from Trusted, and never describe them as verified or evidence-backed unavailable.
- [x] 4.3 Update source and project documentation with the accounting-versus-verification distinction and exact residual policy.

## 5. Exhaustive Evidence Run

- [x] 5.1 Run the full local check, migration replay, release startup profile, deploy dry-run, and strict OpenSpec validation.
- [ ] 5.2 Run replacement exhaustive nutrition and ingredient workflows from the pinned source snapshot using the corrected retry cache.
- [ ] 5.3 Independently verify artifact checksums, requested/outcome equality, decision drift, exception bounds, and the complete per-barcode exception list.
- [ ] 5.4 After separate production approval, apply pending D1 migrations, explicitly dispatch publication for the approved artifacts, deploy, and verify live API, accounting, Trusted, desktop, and mobile invariants.
- [ ] 5.5 Sync and archive the OpenSpec change, update `PROJECT_STATUS.md`, and commit/push the final verified release state.
