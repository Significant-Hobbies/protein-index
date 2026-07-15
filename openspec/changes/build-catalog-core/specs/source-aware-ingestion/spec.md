## ADDED Requirements

### Requirement: Imports are run-scoped and reproducible
The system SHALL record source, adapter version, input identifier, input hash,
start time, completion time, counts, status, and error summary for every
ingestion run.

#### Scenario: Import completes
- **WHEN** an adapter finishes reading a source snapshot
- **THEN** the system stores a completed manifest whose counts reconcile with accepted, skipped, and reviewed records

### Requirement: Repeat imports are idempotent
The system SHALL identify source records by source-owned identifier and content
hash so replaying unchanged input does not create duplicate products,
observations, offers, ratings, or review items.

#### Scenario: Same snapshot is replayed
- **WHEN** an already completed source snapshot is imported again
- **THEN** canonical and observation counts remain unchanged and the run reports unchanged records

### Requirement: Ingestion is broader than protein classification
The Open Food Facts adapter SHALL accept all food records tagged for India that
meet basic identity validity, regardless of their current protein
classification.

#### Scenario: Ordinary Indian food has no protein keyword
- **WHEN** an India-tagged food record has no protein marketing term
- **THEN** the record is retained and classification runs after ingestion

### Requirement: Raw evidence is preserved
The system SHALL preserve a content-addressed raw record or an immutable pointer
to it, subject to the source's license and retention terms.

#### Scenario: Normalization is questioned
- **WHEN** an operator inspects a normalized field from an ingestion run
- **THEN** the original source value and evidence reference are available without refetching a mutable listing

### Requirement: Lower-authority data cannot silently replace stronger evidence
The reconciler SHALL select values using field-family authority, verification,
confidence, and observation time, and SHALL create a review item for unresolved
high-impact conflicts.

#### Scenario: Open data disagrees with verified label
- **WHEN** a newer Open Food Facts observation disagrees with current label-verified nutrition
- **THEN** the verified value remains selected and the disagreement is recorded for review

### Requirement: Nutrition validation fails closed
The importer SHALL reject impossible or ambiguous nutrition normalization and
SHALL NOT manufacture per-100-g values without an unambiguous conversion basis.

#### Scenario: Per-serving value lacks serving mass
- **WHEN** a record provides protein per serving but no valid serving mass
- **THEN** per-100-g protein remains unavailable and a basis anomaly is reported

#### Scenario: Macros are impossible
- **WHEN** protein exceeds 100 g per 100 g or macronutrient totals are materially impossible
- **THEN** the nutrition candidate is not selected and a validation review item is created

