## 1. Backward-compatible evidence contract

- [x] 1.1 Add a corrected nutrition decision payload variant that retains the canonical original candidate and carries one explicit reviewed mass or volume projection.
- [x] 1.2 Add shared parsing, validation, canonicalization, and effective-projection helpers that preserve every existing candidate-only decision byte-for-byte.
- [x] 1.3 Add regression fixtures for missing keys, invalid values, ambiguous bases, correction-on-reject, candidate/source drift, and legacy bundle compatibility.

## 2. Review and publication paths

- [x] 2.1 Extend the local review API and Worker transaction to accept a corrected projection only for verified source-bound nutrition candidates.
- [x] 2.2 Make review-bundle read/write, publication SQL, postconditions, and exact replay use the shared effective projection without changing legacy bundles.
- [x] 2.3 Make reconciliation replay corrected mass and volume decisions atomically and revoke trust when the source or original candidate drifts.
- [x] 2.4 Add Worker+D1 and publication tests for corrected verification, exact replay, malformed input, and pre-write drift failure.

## 3. Operator experience and API

- [x] 3.1 Extend API types and review responses with the optional reviewed projection and field-level change summary.
- [x] 3.2 Add a basis-aware editor pre-filled from the model candidate with explicit null handling, validation, and changed-field highlighting beside the exact image.
- [x] 3.3 Keep exact-candidate verify and reject actions unchanged, and add a distinct confirmation path for corrected verification.
- [x] 3.4 Add responsive UI/API tests covering corrected mass and volume candidates, basis changes, errors, and published product detail.

## 4. Verification and delivery

- [x] 4.1 Run focused domain, Worker, publication, and UI tests after each slice, then run `pnpm check`, every immutable review-bundle validation, and a local idempotent replay proof.
- [x] 4.2 Complete sanctioned desktop/mobile rendered verification before deploying the review UI; do not migrate or publish production evidence as part of this change.
- [ ] 4.3 Validate and archive the OpenSpec change, update `PROJECT_STATUS.md`, and publish the green repository change without claiming corrected coverage before live evidence publication.
