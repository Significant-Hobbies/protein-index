## 1. Candidate model and official extraction

- [ ] 1.1 Add ingredient-candidate types, canonical hashing, validation, and fixtures for valid, malformed, low-confidence, identity-mismatched, duplicate, and conflicting predictions.
- [ ] 1.2 Extend the Robotoff adapter to parse `ner` `ingredient_detection` predictions with exact entity, image, model, timestamp, language, bounding-box, parsed-tree, and count evidence.
- [ ] 1.3 Add a rate-bounded, resumable ingredient-image collector that processes the exact eligible GTIN cohort and writes per-GTIN raw responses and outcomes.
- [ ] 1.4 Add manifest, cohort hash, terminal accounting, model/warning distributions, portable checksums, and fail-closed artifact validation.
- [ ] 1.5 Run a bounded official live sample, visually inspect its source labels, and record evidence that model output remains review-only.

## 2. Durable ingredient decisions and reconciliation

- [ ] 2.1 Add and integration-test a forward D1 migration that preserves existing nutrition decisions while allowing the ingredients field family.
- [ ] 2.2 Reconcile accepted ingredient candidates into evidence-first review items without selecting them as product facts.
- [ ] 2.3 Extend durable decision validation for ingredient verify/correct/reject payloads bound to exact source and candidate hashes.
- [ ] 2.4 Apply verified reviewed text atomically to statements, normalized rows, observations, outcomes, and the exact review item while keeping rejection isolated.
- [ ] 2.5 Replay unchanged ingredient decisions and invalidate selected trust when source content or the canonical candidate drifts.

## 3. Evidence-first operator review

- [ ] 3.1 Extend review APIs with ingredient decision semantics, strict evidence requirements, conflict checks, and public-production mutation protection.
- [ ] 3.2 Add a side-by-side ingredient review UI showing the label, exact OCR, reviewer-confirmed text, parsed tree, confidences, counts, and warnings.
- [ ] 3.3 Add Worker+D1 tests for exact verification, corrected OCR, rejection, duplicate decisions, concurrent conflict, replay, and drift.

## 4. Auditable bundles and guarded publication

- [ ] 4.1 Extend deterministic review bundles to a backward-compatible nutrition/ingredients union and add checksum and schema regression fixtures.
- [ ] 4.2 Extend SQL planning, remote source validation, idempotent application, and postcondition checks for verified ingredient facts and resolved candidates.
- [ ] 4.3 Extend the protected commit-pinned publication workflow for ingredient decisions while preserving explicit confirmation and environment approval.

## 5. Exhaustive source operation and real evidence

- [ ] 5.1 Add a manually triggered GitHub workflow for full ingredient-image extraction with bounded retries, resumable artifacts, exact accounting, and checksums.
- [ ] 5.2 Complete the full eligible image cohort, validate its artifact and accounting, and publish only the review-gated source records.
- [ ] 5.3 Review a bounded real source-matched candidate set, publish its decisions, and verify the exact live verified-ingredient and outstanding-ingredient deltas.

## 6. Quality and release gate

- [ ] 6.1 Run domain, ingestion, Worker+D1, typecheck, build, OpenSpec, migration, Worker startup, and deploy dry-run checks.
- [ ] 6.2 Perform rendered desktop/mobile visual and accessibility review of ingredient evidence and completion states with the in-app browser.
- [ ] 6.3 Update `PROJECT_STATUS.md`, pass all release gates, deploy the reviewed dashboard, and audit that the overall completion gate remains red until all active products have terminal verified evidence.
