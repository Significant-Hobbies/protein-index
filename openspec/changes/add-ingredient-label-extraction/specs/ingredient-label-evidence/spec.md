## ADDED Requirements

### Requirement: Ingredient extraction exhausts the eligible image cohort
The system SHALL process every distinct valid configured GTIN with a selected
HTTPS ingredient-label image and SHALL assign each GTIN exactly one terminal
outcome: candidate, no prediction, rejected, or failed after bounded retry.

#### Scenario: Complete cohort run
- **WHEN** ingredient extraction reaches the end of the selected image cohort
- **THEN** terminal outcome counts sum exactly to the distinct eligible GTIN count

#### Scenario: Interrupted extraction resumes
- **WHEN** a run restarts with valid completed per-GTIN artifacts
- **THEN** it resumes remaining GTINs without refetching terminal outcomes

#### Scenario: Image-less product is excluded
- **WHEN** an active product has no valid selected ingredient-label image URL
- **THEN** the manifest excludes it from the extraction cohort and coverage continues to report its ingredient evidence as outstanding

### Requirement: Extraction uses source-linked official model evidence
The collector MUST query the official Robotoff image-prediction API for `ner`
predictions from `ingredient_detection` and MUST retain the exact response needed
to audit every accepted or rejected prediction.

#### Scenario: Official prediction is accepted as a candidate
- **WHEN** a prediction matches the requested GTIN and passes candidate validation
- **THEN** the staged evidence retains its prediction, image, model, timestamp, entity, language, bounding-box, parsed-tree, and ingredient-count fields

#### Scenario: Wrong model is returned
- **WHEN** a response contains a prediction from another model family
- **THEN** that prediction cannot become an ingredient review candidate

### Requirement: Ingredient candidates fail closed
The system SHALL reject malformed, identity-mismatched, non-HTTPS, empty,
below-threshold, or internally inconsistent ingredient predictions before they
become selectable review candidates.

#### Scenario: Prediction barcode differs from product GTIN
- **WHEN** the normalized prediction barcode does not equal the linked canonical product GTIN
- **THEN** candidate admission fails and records an identity-mismatch reason

#### Scenario: Entity confidence is too low
- **WHEN** the entity confidence is below the configured threshold recorded in the run manifest
- **THEN** the prediction receives a rejected terminal outcome and cannot be verified

#### Scenario: Taxonomy recognition is low
- **WHEN** fewer than sixty percent of parsed ingredients are recognized but all structural validation passes
- **THEN** the candidate remains reviewable with a visible recognition warning rather than being silently discarded

### Requirement: Candidate identity is deterministic
The system SHALL calculate a canonical SHA-256 candidate hash over the complete
immutable ingredient extraction and SHALL use it in review, decisions, replay,
bundles, and publication.

#### Scenario: Same extraction is imported twice
- **WHEN** identical candidate fields are canonicalized in separate runs
- **THEN** both imports produce the same candidate hash

#### Scenario: Extracted text or image changes
- **WHEN** the entity text, source image, model evidence, or another canonical candidate field changes
- **THEN** the changed extraction produces a different candidate hash

### Requirement: Review exposes image and parsing evidence
The operator review surface SHALL show the ingredient-label image beside exact
extracted text, parsed ingredients, language/model confidence, known and unknown
counts, conflicts, and validation warnings.

#### Scenario: Multiple candidates disagree
- **WHEN** materially different ingredient candidates exist for one GTIN
- **THEN** the surface keeps each candidate distinct and requires an explicit per-candidate decision

#### Scenario: Candidate is visually inspected
- **WHEN** an operator opens an ingredient candidate
- **THEN** the exact evidence URL and immutable extraction fields are visible before any decision action

### Requirement: Verification records reviewer-confirmed label text
The system SHALL require a human reviewer to submit the exact visible label text,
evidence URL, rationale, reviewer identity, and decision time before an ingredient
candidate can become verified.

#### Scenario: OCR text is accurate
- **WHEN** the visible label exactly matches the extracted entity text
- **THEN** the reviewer can verify that text while preserving the immutable extraction

#### Scenario: OCR text contains a readable error
- **WHEN** the label image clearly supports corrected text that differs from the extraction
- **THEN** the decision stores both the original candidate and reviewer-confirmed text with an explicit correction rationale

#### Scenario: Label cannot substantiate text
- **WHEN** the image is unreadable, cropped, or belongs to a different variant
- **THEN** verification is refused and the candidate remains open or is rejected

### Requirement: Verified ingredient application is exact and source linked
A verify decision SHALL atomically select the reviewer-confirmed raw ingredient
statement, deterministically rebuild normalized ingredient rows, retain selected
field provenance, record a verified ingredient evidence outcome, and resolve the
exact candidate review item.

#### Scenario: Community ingredients differ
- **WHEN** an unverified community statement differs from the reviewed current label
- **THEN** the exact reviewer-confirmed statement becomes the selected verified fact while the prior source remains auditable

#### Scenario: Normalized rows are rebuilt
- **WHEN** a reviewed statement is applied
- **THEN** normalized ingredient rows derive only from that reviewed text and remain linked to its source record

### Requirement: Candidate rejection is isolated
A reject decision SHALL resolve only the exact rejected candidate and MUST NOT
erase independently sourced ingredients or create terminal absent evidence.

#### Scenario: Rejected OCR overlays community data
- **WHEN** an operator rejects a candidate for a product with an existing community statement
- **THEN** the community statement remains available and the rejected candidate hash is not requeued unchanged

### Requirement: Ingredient decisions are durable and drift aware
The system SHALL persist ingredient verify and reject decisions against exact
source identity, source content hash, product, candidate hash, and field family,
and SHALL replay them only while every binding remains unchanged.

#### Scenario: Verified candidate is imported unchanged
- **WHEN** the exact source and ingredient candidate reappear
- **THEN** reconciliation preserves or reconstructs verified ingredient facts without opening a duplicate review

#### Scenario: Rejected candidate is imported unchanged
- **WHEN** the exact rejected source and candidate reappear
- **THEN** reconciliation retains the rejection without reopening review

#### Scenario: Source or candidate drifts
- **WHEN** source content, image, extracted text, or candidate hash changes
- **THEN** the prior decision no longer applies, stale verified selection is invalidated, and the changed evidence requires review

### Requirement: Ingredient decision bundles are deterministic and compatible
The review export and validation path SHALL support schema-discriminated
ingredient decisions while remaining able to read and publish existing valid
nutrition-only bundles.

#### Scenario: Same ingredient decisions are exported twice
- **WHEN** two exports read the same active ingredient decision state
- **THEN** their sorted decision-ledger bytes and ledger hash are identical apart from manifest creation metadata

#### Scenario: Existing nutrition bundle is validated
- **WHEN** a valid prior nutrition-only bundle is processed after ingredient support ships
- **THEN** its candidate validation and publication semantics remain unchanged

#### Scenario: Ingredient payload is inconsistent
- **WHEN** reviewed text, candidate hash, source content, or deterministic parsing fails current validation
- **THEN** the whole bundle is rejected before any production write

### Requirement: Ingredient publication is protected and proves effects
Production ingredient publication SHALL require the existing manual protected,
commit-pinned workflow and SHALL verify durable decisions, verified statements,
normalized rows, observations, outcomes, and resolved review candidates after
every write.

#### Scenario: Bundle commit is not merged
- **WHEN** the selected bundle commit is not an ancestor of trusted `main`
- **THEN** the workflow refuses to publish it

#### Scenario: Postcondition count is incomplete
- **WHEN** any expected ingredient decision or verified fact is absent after application
- **THEN** the workflow fails and preserves diagnostics instead of reporting success

#### Scenario: Bundle is replayed
- **WHEN** an identical already-applied ingredient bundle is published again
- **THEN** facts and durable decisions remain unchanged and all postconditions still reconcile

### Requirement: Completion distinguishes extraction from verified evidence
The dashboard SHALL report ingredient extraction, review, and terminal verified
coverage separately and MUST keep the project completion gate incomplete while
any active product lacks terminal ingredient evidence or another required
evidence family remains outstanding.

#### Scenario: Every image has been extracted
- **WHEN** the ingredient-image cohort has terminal extraction accounting but candidates remain unreviewed
- **THEN** extraction coverage is complete while verified ingredient coverage and the project completion gate remain incomplete

#### Scenario: Product lacks a label image
- **WHEN** an active product has neither verified ingredients nor terminal not-declared or not-applicable evidence
- **THEN** that product remains in the outstanding ingredient count

#### Scenario: All evidence families are terminal
- **WHEN** every active product has non-drifted terminal identity, nutrition, and ingredient evidence
- **THEN** and only then may the project completion gate report complete
