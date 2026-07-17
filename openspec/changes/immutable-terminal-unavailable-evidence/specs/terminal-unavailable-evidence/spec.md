## ADDED Requirements

### Requirement: Terminal unavailable state requires immutable human evidence
The system SHALL classify nutrition or ingredients as terminal unavailable only
from an append-only human decision of `not_declared` or `not_applicable` bound
to exact current evidence.

#### Scenario: Reviewer confirms a declaration is absent
- **WHEN** a reviewer inspects a complete current label or authoritative source and records `not_declared`
- **THEN** the system stores an immutable decision with the exact product, family, source content, evidence, reviewer, rationale, and time
- **THEN** the terminal state becomes current only if no verified or conflicting fact contradicts it

#### Scenario: Automation finds no value
- **WHEN** structured data is empty, OCR returns no prediction, or extraction fails
- **THEN** the system SHALL keep the family outstanding and SHALL NOT create a terminal decision

### Requirement: Evidence selection is server-enumerated and exact-bound
The system MUST accept only a current source record or retained label asset
enumerated by the server for the selected product and family.

#### Scenario: Exact retained label is selected
- **WHEN** the reviewer selects a label evidence option
- **THEN** the decision binds the current source record and content hash plus the label asset ID and label-byte SHA-256

#### Scenario: Arbitrary evidence URL is submitted
- **WHEN** a client submits an unrecognized URL or evidence identity
- **THEN** the mutation fails before a decision or projection is written

### Requirement: Terminal decision history is append-only
The system SHALL preserve every decision and permit correction only through an
explicit, valid superseding decision.

#### Scenario: Exact decision is replayed
- **WHEN** the same outcome, evidence binding, rationale, and idempotency identity are submitted again
- **THEN** the existing decision is returned and row counts remain unchanged

#### Scenario: Reviewer corrects an earlier outcome
- **WHEN** a new decision explicitly supersedes the current decision for the same product, family, source, and evidence lineage
- **THEN** both rows remain stored and only the unsuperseded head participates in current completion

#### Scenario: Competing correction is submitted
- **WHEN** two decisions attempt to supersede the same prior decision
- **THEN** the second write fails without changing the current projection

### Requirement: Source and label drift revoke trust without deleting history
The system SHALL require an exact current join from a terminal decision to its
source, product, and optional label-byte evidence.

#### Scenario: Bound source content changes
- **WHEN** the source record's current content hash no longer matches a terminal decision
- **THEN** that decision stops contributing to completion and remains preserved as stale history

#### Scenario: Bound label bytes change
- **WHEN** the current label asset or content SHA-256 differs from the decision binding
- **THEN** the decision stops contributing to completion and the family becomes outstanding unless another valid source decision remains

#### Scenario: One of two agreeing sources drifts
- **WHEN** source A becomes stale and source B still has an exact current decision for the same outcome
- **THEN** source B remains terminal evidence and becomes the deterministic projection

### Requirement: Contradictions fail closed
The system MUST NOT treat an unavailable decision as terminal when current
evidence or facts contradict it.

#### Scenario: Current sources disagree on unavailable outcome
- **WHEN** valid current decisions include both `not_declared` and `not_applicable`
- **THEN** the family remains outstanding in `evidence_inconsistent` with both decisions visible

#### Scenario: Verified fact coexists with unavailable decision
- **WHEN** a current authority-100 verified fact exists beside a current unavailable decision
- **THEN** the family remains outstanding in `evidence_inconsistent`

### Requirement: Outcome projection is deterministic but not authoritative
The system SHALL derive the `evidence_outcomes` terminal row from valid current
immutable decisions and SHALL use the immutable exact join for completion.

#### Scenario: Multiple sources agree
- **WHEN** multiple valid sources carry the same terminal outcome
- **THEN** the projection selects highest source authority, newest decision time, then decision ID while retaining every decision

#### Scenario: No valid terminal decision remains
- **WHEN** all terminal decisions are stale, superseded, or contradictory
- **THEN** the terminal projection is removed or ignored and completion remains outstanding

### Requirement: Operator flow is explicit and local-only
The system SHALL provide a bounded evidence picker, outcome explanation,
rationale, confirmation, history, and errors in the local completion worklist.

#### Scenario: Operator records terminal evidence
- **WHEN** a local operator selects exact current evidence and confirms a valid terminal outcome
- **THEN** the ledger refreshes to show the terminal state and its provenance without changing any verified fact

#### Scenario: Remote client attempts mutation
- **WHEN** a deployed read-only client calls the terminal-decision endpoint
- **THEN** the request is denied and no evidence state changes
