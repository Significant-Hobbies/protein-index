## 1. Guarded Re-attestation Contract

- [x] 1.1 Add typed re-attestation inputs and report fields for artifact identity, artifact checksum, active-set hash, expected count, predecessor decisions, exact current links, reviewer identity, fixed timestamp, and batch-bound confirmation.
- [x] 1.2 Implement fail-closed eligibility that accepts only complete source-revision-only drift with valid exact proof and rejects partial, ambiguous, semantic, identity, URL, or linkage drift.
- [x] 1.3 Create deterministic replacement decisions without mutating predecessors, preserving reviewed semantics while recording current source hash, attempt, asset, operator, timestamp, and predecessor lineage.

## 2. Bundle And Active-Set Output

- [x] 2.1 Write one family-pure checksummed replacement bundle plus an eligibility report using existing review-bundle validation.
- [x] 2.2 Emit `active-bundles.next.json` without editing the tracked manifest and require a fresh all-exact-link audit before marking the proposal eligible.
- [x] 2.3 Add a CLI route with explicit artifact, bundle root, active set, family, expected count, output, reviewer, timestamp, and hard-confirmation inputs.

## 3. Symmetric Ingredient Supersession

- [x] 3.1 Deactivate source- or candidate-drifted active ingredient decisions only after projection invalidation and only when no exact current decision exists.
- [x] 3.2 Prove ingredient replay preserves an exact current decision, deactivates a stale predecessor, admits one exact replacement under the active unique index, and remains idempotent.

## 4. Verification

- [x] 4.1 Add boundary tests for absent confirmation, malformed operator/time inputs, every ineligible drift class, incomplete selection, duplicate keys, URL/hash/link mismatch, and historical immutability.
- [x] 4.2 Prove deterministic repeated generation, portable checksums, exact predecessor accounting, family purity, and an all-`exact_link_valid` proposed audit.
- [x] 4.3 Run focused tests, full check, migration replay, workflow-contract tests, deploy dry-run, and strict OpenSpec validation.
- [x] 4.4 Reconcile the authoritative 55-product live nutrition selection, construct the checksummed 53-decision eligible predecessor set, and record the candidate-drift and candidate-missing exceptions.
- [x] 4.5 Add release guards that reject any live selected-state mismatch or final verified counts other than 76 nutrition and 65 ingredients.

## 5. Authorized Data And Release

- [x] 5.1 After explicit expanded re-attestation approval, generate the exact 365-decision nutrition and 66-decision ingredient bundles from artifacts `8414045970` and `8414036638`, independently audit them, and commit the reviewed active manifest.
- [ ] 5.2 After separate production approval, apply migrations, publish each exact artifact with its replacement bundle through the guarded release path, and prove reviewed counts plus idempotent replay.
- [ ] 5.3 Deploy and verify live API, completion, Trusted, desktop, mobile, and provider-neutral presentation; then sync/archive the change and update project status.
