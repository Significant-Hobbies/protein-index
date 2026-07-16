## 1. Shared evidence contract

- [x] 1.1 Add a discriminated mass/volume nutrition candidate union and helpers that expose normalized values and database basis.
- [x] 1.2 Preserve legacy mass canonical serialization and hashes while adding deterministic volume serialization and validation.
- [x] 1.3 Add regression tests for ambiguous payload rejection, volume hashes, and existing reviewed mass hashes.

## 2. Volume-safe extraction

- [x] 2.1 Parse explicit serving volume from retained Open Food Facts evidence without accepting mass or ambiguous units.
- [x] 2.2 Normalize direct per-100-mL and explicit per-serving-volume Robotoff predictions into `nutritionPer100ml` candidates.
- [x] 2.3 Retain fail-closed outcomes for missing or dimension-mismatched serving evidence and add extraction accounting tests.

## 3. Review and publication

- [x] 3.1 Make local Worker review mutation persist verified nutrition, nutrients, provenance, and outcomes with the candidate's normalized basis.
- [x] 3.2 Make review-bundle preparation, SQL publication, postchecks, and exact replay basis-aware while accepting immutable legacy bundles.
- [x] 3.3 Make reconciliation replay verified mass and volume decisions idempotently and revoke stale evidence by exact candidate hash.
- [x] 3.4 Add Worker+D1 and publication regression tests for atomic volume verification, drift failure, and exact replay.

## 4. Dashboard and metrics

- [x] 4.1 Parse and render volume candidates with an exact per-100-mL label and retain per-serving origin context.
- [x] 4.2 Verify protein-per-calorie calculations remain available for volume facts and mass-dependent economic metrics fail closed without compatible quantities.
- [x] 4.3 Add UI/API regression coverage for volume candidate and verified product responses.

## 5. Verification and delivery

- [x] 5.1 Run focused unit and Worker tests after each implementation slice, then run `pnpm check` and immutable review-bundle validation.
- [ ] 5.2 Validate and archive the OpenSpec change, update `PROJECT_STATUS.md`, and publish the green repository change without deploying or migrating production.
- [x] 5.3 Record the next source-complete extraction and exact-label review as follow-up work; do not claim verified-coverage gains until those artifacts are published.
