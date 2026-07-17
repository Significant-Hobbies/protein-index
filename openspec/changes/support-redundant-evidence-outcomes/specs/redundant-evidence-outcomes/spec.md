## ADDED Requirements

### Requirement: Exact redundant evidence decision
The system SHALL accept a `redundant` nutrition decision only when the bound
candidate canonically equals an active verified projection for the same
canonical product, field family, physical basis, and every supported value.

#### Scenario: Exact duplicate is accepted
- **WHEN** a source-bound candidate exactly matches the selected verified projection for its product and basis
- **THEN** the system records a terminal redundant decision for that candidate

#### Scenario: Any projection difference fails closed
- **WHEN** the candidate differs in basis, value, explicit null, product, source content, or candidate hash
- **THEN** the system rejects the redundant decision before any write

### Requirement: Redundancy does not mutate verified facts
The system MUST resolve only the bound review item and MUST preserve the existing
selected nutrition facts, field provenance, and verified evidence outcome.

#### Scenario: Redundant publication is a fact no-op
- **WHEN** a valid redundant decision is published
- **THEN** decision and review-resolution counts change while verified product, nutrient, observation, and outcome rows remain unchanged

### Requirement: Redundant decisions replay safely
The system SHALL replay redundant decisions idempotently and SHALL revoke their
terminal status when their source binding or referenced selected projection no
longer matches.

#### Scenario: Unchanged replay is idempotent
- **WHEN** an unchanged redundant decision is replayed more than once
- **THEN** the candidate remains resolved with no additional fact writes

#### Scenario: Source or fact drift reopens review
- **WHEN** source content, candidate hash, product binding, basis, or selected verified values drift
- **THEN** the redundant decision no longer resolves the candidate and the evidence returns to review

### Requirement: Redundancy is visible without inflating coverage
The API and operator UI SHALL distinguish redundant evidence from verification
and rejection, and coverage SHALL count it as terminal evidence but not as an
additional verified product or fact.

#### Scenario: Operator sees redundant provenance
- **WHEN** a redundant decision is returned in review history or product evidence
- **THEN** the response and UI identify the source image, matched projection, decision actor, rationale, and observation time

#### Scenario: Coverage remains truthful
- **WHEN** redundant evidence becomes terminal
- **THEN** open-review counts decrease while verified-product and verified-field counts do not increase

### Requirement: Existing decision bundles remain compatible
The system MUST preserve canonical parsing, checksums, and replay behavior for
all existing verify and reject bundles.

#### Scenario: Legacy bundle regression
- **WHEN** every checked-in legacy review bundle is validated and replayed by the new reader
- **THEN** its canonical ledger bytes, checksum result, and effective decision behavior remain unchanged
