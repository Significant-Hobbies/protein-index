## ADDED Requirements

### Requirement: Audit only validated evidence inputs
The auditor MUST fully validate the selected extraction artifact and every discovered review bundle before comparing any decision, and MUST perform no database or ledger mutation.

#### Scenario: Valid nutrition artifact and review bundles
- **WHEN** an operator audits a checksum-valid, source-complete nutrition artifact against checksum-valid bundle directories
- **THEN** the system compares decisions using the validated exact extraction records and leaves all inputs and databases unchanged

#### Scenario: Invalid artifact or bundle
- **WHEN** an artifact or review bundle fails its existing schema, checksum, completeness, or lineage validation
- **THEN** the audit fails before emitting a successful drift result

### Requirement: Deterministically deduplicate review history
The auditor SHALL collapse canonically identical repeated decisions while retaining all bundle provenance, and MUST fail when a decision identifier has conflicting contents. It MUST treat multiple decision IDs for one active-candidate key, or multiple current verify decisions for one product and family, as ambiguous without inferring authority from timestamps.

#### Scenario: Identical decision in multiple bundles
- **WHEN** the same canonical decision appears in more than one valid bundle
- **THEN** the report contains one unique decision result and lists each source bundle

#### Scenario: Conflicting decision identifier
- **WHEN** one decision ID maps to different canonical contents across valid bundles
- **THEN** the audit fails with an integrity conflict and does not choose a winner

#### Scenario: Multiple IDs for one candidate
- **WHEN** distinct IDs exist for the same source ID, source record key, field family, and candidate hash without authoritative active state
- **THEN** the auditor classifies the group as `candidate_key_active_state_ambiguous` and makes no exact-link claim

### Requirement: Classify decisions against current exact evidence
The auditor SHALL independently recompute staged raw-evidence and canonical candidate hashes and classify every unique decision exactly once using the current artifact's source subject, product, GTIN, canonical candidate, source content, extraction attempt, review issue, attempt-label outcome, label asset, image URL, label-byte SHA-256, and field family. A decision MUST be `exact_link_valid` only when it already names the matching exact attempt and label asset and the full proof chain is valid.

#### Scenario: Exact current linked decision
- **WHEN** a decision matches the current source record, product, candidate hash, content hash, extraction attempt, and label asset
- **THEN** the auditor classifies it as `exact_link_valid` only after validating the full label-byte proof chain

#### Scenario: Legacy candidate fully matches current proof
- **WHEN** the current source subject, product, candidate, content, and proof chain match but the decision has no immutable exact linkage
- **THEN** the auditor classifies it as `legacy_proof_match_requires_new_decision` and does not retrofit or rebind it

#### Scenario: Current evidence has drifted
- **WHEN** the current artifact changes or omits the historical source content, candidate, or product binding
- **THEN** the auditor classifies the decision as `source_revision_drift_candidate_unchanged`, `candidate_drift`, `artifact_candidate_missing`, `identity_drift`, or `linked_proof_drift` with the compared evidence values

#### Scenario: Decision belongs to other family
- **WHEN** a nutrition decision is audited with an ingredient artifact or an ingredient decision is audited with a nutrition artifact
- **THEN** the auditor classifies it as `unsupported_source_or_family` without treating it as current evidence

#### Scenario: Redundant nutrition decision lacks projection state
- **WHEN** a redundant nutrition decision is inspected without trusted selected-projection state
- **THEN** the auditor classifies it as `requires_selected_projection_state` and makes no exact validity claim

### Requirement: Report undecided current candidates
The auditor SHALL report each validated current artifact candidate that has no corresponding decision as `unreviewed_current_candidate` without altering the artifact or review history.

#### Scenario: Fresh candidate has no decision
- **WHEN** a current validated candidate has no decision under its source, source record key, candidate hash, and field family key
- **THEN** the report includes the candidate in a deterministic unreviewed queue with its exact proof identifiers

### Requirement: Emit stable operator and automation output
The command SHALL emit a deterministic machine-readable report containing artifact identity, input counts, deduplication counts, classification counts, conflicts, per-decision findings, unreviewed current candidates, and bundle provenance. It MUST return a non-zero status for invalid input, integrity conflicts, proof inconsistency, or operator-selected disallowed finding categories, while leaving the reusable audit function free of process termination.

#### Scenario: Repeated audit of unchanged inputs
- **WHEN** the command runs more than once against the same artifact and bundle set
- **THEN** its canonical JSON findings and ordering are identical apart from no wall-clock-generated field

#### Scenario: Drift blocks automation
- **WHEN** the report contains a classification disallowed by the command policy
- **THEN** the command exits non-zero after writing the complete report and concise summary
