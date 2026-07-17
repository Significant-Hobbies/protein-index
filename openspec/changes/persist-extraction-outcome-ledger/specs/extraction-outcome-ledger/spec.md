## ADDED Requirements

### Requirement: Immutable label evidence assets
The system SHALL identify every extraction label by canonical subject source,
product, field family, stable source image identity, effective HTTPS URL, and a
SHA-256 digest computed from the exact fetched image bytes.

#### Scenario: Label bytes are captured safely
- **WHEN** an eligible nutrition or ingredient label is prepared for extraction
- **THEN** the system streams the image through SHA-256 with media-type and byte-limit validation and records its digest, byte length, effective URL, and fetch time without buffering the complete image

#### Scenario: Same URL serves changed bytes
- **WHEN** a current label URL returns bytes whose SHA-256 differs from the recorded current asset
- **THEN** the system creates a new immutable asset version and treats outcomes bound to the old bytes as stale

#### Scenario: Label proof is missing
- **WHEN** the exact label bytes cannot be fetched, validated, or hashed
- **THEN** the system fails closed and does not call the label attempted or advance source-complete extraction state

### Requirement: Source-bound extraction attempts
The system SHALL persist extraction attempts against the exact ingestion run,
canonical subject source record and content hash, product, field family,
extractor/model version, request-schema hash, response evidence hash, artifact
digest, and attempt time.

#### Scenario: Source context remains current
- **WHEN** a validated attempt is imported and its subject source record still maps to the same product and content hash
- **THEN** the system may make that attempt current only after the entire artifact has been accepted

#### Scenario: Source context drifts
- **WHEN** the current subject source record, product mapping, label set, or label-byte hash differs from an attempt binding
- **THEN** the system preserves the attempt as history and excludes it from current completion claims

#### Scenario: Exact replay
- **WHEN** the same validated run, assets, attempts, per-label outcomes, and candidates are imported again
- **THEN** the system performs an idempotent replay with no duplicate rows, fact changes, terminal-decision changes, or current-pointer regression

### Requirement: Per-label outcome accounting
The system SHALL retain requested and prediction label roles and the explicit
`candidate`, `no_prediction`, `rejected`, or `failed` outcome for each exact
image version, including counts, conflicts, candidate hashes, and reason codes.

#### Scenario: Barcode response contains mixed images
- **WHEN** one barcode response contains a candidate for one label image and a rejected or failed result for another
- **THEN** the system persists both image outcomes and does not collapse them into a single lossy product status

#### Scenario: No prediction is recorded
- **WHEN** a source-complete barcode query returns no qualifying prediction and the exact requested label was present in the validated cohort
- **THEN** the system records `no_prediction` for that requested asset without asserting that nutrition or ingredients are absent

#### Scenario: Query fails
- **WHEN** the barcode extraction request fails or its response cannot be validated
- **THEN** the system records only inactive failure diagnostics and does not advance accepted current extraction state

### Requirement: Complete guarded artifact publication
The system SHALL validate exact cohort, label, response, outcome, candidate,
staged-record, report, checksum, version, and lineage accounting before any D1
mutation.

#### Scenario: Complete current artifact is published
- **WHEN** an artifact has exact accounting, byte hashes for every linked label, the expected adapter and request schema, the canonical parent snapshot, allowed lineage, and a non-superseded artifact digest
- **THEN** the system imports its immutable ledger and candidate review records atomically and verifies exact postconditions

#### Scenario: Artifact is incomplete or superseded
- **WHEN** any required row, checksum, label hash, source binding, workflow identity, head SHA, artifact digest, or version is missing, contradictory, or denied
- **THEN** publication aborts before D1 changes and reports the precise validation failure

#### Scenario: Legacy response-only artifact is considered
- **WHEN** an artifact contains URLs and response checksums but no true label-byte SHA-256 proof
- **THEN** the system may preserve its historical candidate evidence but SHALL NOT import it as a current exact extraction attempt

### Requirement: Extraction outcomes never become terminal facts
The system MUST keep automated extraction workflow evidence separate from
verified facts and authoritative terminal-unavailable decisions.

#### Scenario: Automated extraction has no usable candidate
- **WHEN** the current exact outcome is `no_prediction`, `rejected`, or `failed`
- **THEN** the product remains outstanding unless separately supported by a current verified fact or exact authoritative terminal decision

#### Scenario: Candidate exists
- **WHEN** the current exact outcome is `candidate`
- **THEN** the candidate remains review-only and does not change the selected nutrition or ingredient fact without an exact human decision

### Requirement: Honest completion action routing
The system SHALL return one terminal product state and, for outstanding work,
one highest-priority action lane derived only from exact current evidence while
also returning bounded per-outcome counts.

#### Scenario: Exact candidate review exists
- **WHEN** a current candidate has an open review matching product, family, attempt, label asset, source record, source-content hash, and candidate hash
- **THEN** the lane is `review_ready` and its primary action identifies that candidate review rather than an unrelated coverage-gap review

#### Scenario: Current extraction failed
- **WHEN** at least one current label's latest extraction failed and no inconsistent, conflict, or review-ready evidence has higher precedence
- **THEN** the lane is `retry_extraction`

#### Scenario: Current label has not been attempted
- **WHEN** at least one current label lacks an exact current outcome, including after label-byte drift, and no higher-priority lane applies
- **THEN** the lane is `run_extraction`

#### Scenario: All current labels lack a usable candidate
- **WHEN** every current label was attempted, none produced a usable candidate, at least one is no-prediction or rejected, and no higher-priority lane applies
- **THEN** the lane is `manual_label_review` without implying terminal unavailability

#### Scenario: Multiple label outcomes coexist
- **WHEN** a product has several current label assets with different outcomes
- **THEN** the system emits one product/family row using deterministic lane precedence and includes exact candidate, no-prediction, rejected, failed, unattempted, stale, and conflict counts

### Requirement: Current terminal completion is provenance-bound
The system SHALL count verified or terminal-unavailable evidence as current only
when its immutable provenance still matches current source and label content and
no current material contradiction exists.

#### Scenario: Verified evidence becomes stale
- **WHEN** a verified fact's source or label-content binding no longer matches current evidence
- **THEN** the product is outstanding in `evidence_inconsistent` until the provenance is repaired or reverified

#### Scenario: Current candidate conflicts with verified fact
- **WHEN** a current exact candidate materially conflicts with the selected verified fact
- **THEN** the product is outstanding in `conflict_resolution`

#### Scenario: Extra label extraction fails beside matching verified fact
- **WHEN** a current verified fact remains exactly bound and a separate current label extraction fails without contradicting it
- **THEN** the product may remain verified while source extraction coverage remains incomplete

### Requirement: Bounded accessible outcome presentation
The system SHALL expose bounded extraction summaries and accessible per-label
evidence without revealing infrastructure-provider details.

#### Scenario: Completion row has multiple labels
- **WHEN** a user expands extraction evidence for a product
- **THEN** the dashboard renders a semantic list with ordinal, family, source time, textual outcome, and a unique accessible label link for each bounded item

#### Scenario: Evidence exceeds inline bound
- **WHEN** a product has more label assets than the completion response limit
- **THEN** the API reports the total and the dashboard links to a deterministic paginated detail view

#### Scenario: Outcome actions are displayed
- **WHEN** a current attempt is failed, rejected, absent, or no-prediction
- **THEN** the dashboard uses actionable non-terminal language, communicates counts without color alone, and preserves keyboard, focus, and live-region behavior
