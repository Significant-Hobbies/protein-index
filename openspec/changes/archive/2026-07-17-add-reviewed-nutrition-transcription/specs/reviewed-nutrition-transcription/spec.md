## ADDED Requirements

### Requirement: Reviewer can transcribe exact supported nutrition
The system SHALL allow a human reviewer to verify a source-bound nutrition
candidate using an explicit reviewed projection containing every supported
nutrition key and an exact mass or volume basis.

#### Scenario: Reviewer corrects an omitted sodium value
- **WHEN** the exact label declares sodium but the original candidate omits it and the reviewer enters the declared value with the correct basis
- **THEN** the verification decision retains the original candidate and stores the complete reviewed projection separately

#### Scenario: Reviewer leaves an undeclared field empty
- **WHEN** a supported nutrient is not declared on the exact package label
- **THEN** the reviewed projection records that field as explicit null rather than deriving or inventing a value

### Requirement: Corrected projections are dimension-safe
The system MUST accept exactly one reviewed basis of `per_100g` or `per_100ml`
and MUST NOT infer density or convert between mass and volume.

#### Scenario: Reviewer corrects a liquid label
- **WHEN** the exact label values are declared per 100 mL
- **THEN** the reviewed projection is stored and published as `per_100ml`

#### Scenario: Reviewed payload contains ambiguous bases
- **WHEN** a corrected payload contains both mass and volume projections, neither projection, or a per-serving basis
- **THEN** validation rejects it before a decision can be stored or bundled

### Requirement: Reviewed values fail closed on invalid input
The system SHALL require finite non-negative calories and protein, explicit
null-or-finite values for every other supported field, a valid HTTPS evidence
URL, a rationale, and a source-matched original candidate.

#### Scenario: Corrected field is missing
- **WHEN** a reviewed projection omits one of the supported keys
- **THEN** validation rejects the decision rather than treating the field as undeclared

#### Scenario: Corrected value is physically invalid
- **WHEN** a reviewed value is negative, non-finite, or violates existing nutrition anomaly rules
- **THEN** validation rejects the decision before any selected fact changes

#### Scenario: Correction is attached to a rejection
- **WHEN** a decision is `reject` and also contains a reviewed projection
- **THEN** validation rejects the decision because corrected transcription is verification-only

### Requirement: Original model evidence remains immutable
The system SHALL retain the canonical original candidate, candidate hash,
source content hash, product, GTIN, model metadata, image, and observation time
inside or alongside every corrected decision.

#### Scenario: Corrected decision is canonicalized
- **WHEN** a reviewer changes one or more nutrition values
- **THEN** the candidate hash still matches the unchanged original model candidate and the bundle checksum binds the exact reviewed projection

#### Scenario: Existing decision is replayed
- **WHEN** a legacy candidate-only decision or checked-in review bundle is read after this change
- **THEN** its canonical JSON, candidate hash, effective projection, and replay behavior remain unchanged

### Requirement: Corrected nutrition publishes atomically
The system SHALL use one effective reviewed projection across selected nutrition
facts, generic nutrient values, field observations, provenance, evidence
outcomes, API responses, and metrics in a single transaction.

#### Scenario: Corrected volume decision is published
- **WHEN** a source-matched reviewer correction is approved for a liquid label
- **THEN** all supported selected values use the reviewed numbers and
  `per_100ml` basis with authority 100 provenance, and the matching review item
  resolves atomically

#### Scenario: Corrected decision is replayed
- **WHEN** the same corrected decision is published or reconciled again
- **THEN** selected values and row counts remain unchanged and no duplicate evidence is created

#### Scenario: Original candidate has drifted
- **WHEN** the current source candidate or content hash no longer matches the corrected decision's binding
- **THEN** publication fails before any review status, fact, nutrient, observation, or outcome changes

### Requirement: Review UI exposes every correction
The operator dashboard and review API SHALL show the exact source image,
original candidate, editable reviewed projection, physical basis, explicit nulls,
and a field-by-field changed summary before corrected verification.

#### Scenario: Reviewer opens an incomplete candidate
- **WHEN** a candidate omits a supported value visible on the label
- **THEN** the UI pre-fills candidate values, permits the missing value to be transcribed, and highlights it as a correction

#### Scenario: Reviewer changes physical basis
- **WHEN** a candidate normalized a per-100-g label as per 100 mL
- **THEN** the UI visibly shows the original and reviewed bases and requires confirmation before submission

### Requirement: Corrected evidence remains human-only
The system MUST NOT automatically create or verify reviewed projections from OCR,
model output, source enrichment, or a scheduled workflow.

#### Scenario: Automated extraction finds a plausible correction
- **WHEN** a model or source adapter can infer a missing or changed value
- **THEN** it remains review evidence and verified coverage does not increase until a human submits a valid corrected decision
