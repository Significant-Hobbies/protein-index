## 1. Candidate model and official extraction

- [x] 1.1 Add ingredient-candidate types, canonical hashing, validation, and fixtures for valid, malformed, low-confidence, identity-mismatched, duplicate, and conflicting predictions.
- [x] 1.2 Extend the Robotoff adapter to parse `ner` `ingredient_detection` predictions with exact entity, image, model, timestamp, language, bounding-box, parsed-tree, and count evidence.
- [x] 1.3 Add a rate-bounded, resumable ingredient-image collector that processes the exact eligible GTIN cohort and writes per-GTIN raw responses and outcomes.
- [x] 1.4 Add manifest, cohort hash, terminal accounting, model/warning distributions, portable checksums, and fail-closed artifact validation.
- [x] 1.5 Run a bounded official live sample, visually inspect its source labels, and record evidence that model output remains review-only. (2026-07-16: GTIN `00001241000224`, prediction `10477207`, candidate `e5ffca0550663e0432f2872b68e1b4ce73b93b7f43b49e70bddf780d32d44351`; 0.999991 entity confidence still contained visibly unsupported OCR fragments.)

## 2. Durable ingredient decisions and reconciliation

- [x] 2.1 Add and integration-test a forward D1 migration that preserves existing nutrition decisions while allowing the ingredients field family.
- [x] 2.2 Reconcile accepted ingredient candidates into evidence-first review items without selecting them as product facts.
- [x] 2.3 Extend durable decision validation for ingredient verify/correct/reject payloads bound to exact source and candidate hashes.
- [x] 2.4 Apply verified reviewed text atomically to statements, normalized rows, observations, outcomes, and the exact review item while keeping rejection isolated.
- [x] 2.5 Replay unchanged ingredient decisions and invalidate selected trust when source content or the canonical candidate drifts.

## 3. Evidence-first operator review

- [x] 3.1 Extend review APIs with ingredient decision semantics, strict evidence requirements, conflict checks, and public-production mutation protection.
- [x] 3.2 Add a side-by-side ingredient review UI showing the label, exact OCR, reviewer-confirmed text, parsed tree, confidences, counts, and warnings.
- [x] 3.3 Add Worker+D1 tests for exact verification, corrected OCR, rejection, duplicate decisions, concurrent conflict, replay, and drift.

## 4. Auditable bundles and guarded publication

- [x] 4.1 Extend deterministic review bundles to a backward-compatible nutrition/ingredients union and add checksum and schema regression fixtures.
- [x] 4.2 Extend SQL planning, remote source validation, idempotent application, and postcondition checks for verified ingredient facts and resolved candidates.
- [x] 4.3 Extend the protected commit-pinned publication workflow for ingredient decisions while preserving explicit confirmation and environment approval.

## 5. Exhaustive source operation and real evidence

- [x] 5.1 Add a manually triggered GitHub workflow for full ingredient-image extraction with bounded retries, resumable artifacts, exact accounting, and checksums.
- [x] 5.2 Complete the full eligible image cohort, validate its artifact and accounting, and publish only the review-gated source records. (2026-07-16: 5,196 eligible GTINs reconciled to 3,358 candidate, 1,739 no-prediction, 99 rejected, and zero failed outcomes; 5,661 image-level candidates published review-only.)
- [ ] 5.3 Review a bounded real source-matched candidate set, publish its decisions, and verify the exact live verified-ingredient and outstanding-ingredient deltas.

## 6. Quality and release gate

- [x] 6.1 Run domain, ingestion, Worker+D1, typecheck, build, OpenSpec, migration, Worker startup, and deploy dry-run checks.
- [ ] 6.2 Perform rendered desktop/mobile visual and accessibility review of ingredient evidence and completion states with the in-app browser.
- [ ] 6.3 Update `PROJECT_STATUS.md`, pass all release gates, deploy the reviewed dashboard, and audit that the overall completion gate remains red until all active products have terminal verified evidence.
