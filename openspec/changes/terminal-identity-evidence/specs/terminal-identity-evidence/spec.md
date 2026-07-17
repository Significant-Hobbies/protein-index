## ADDED Requirements

### Requirement: Identity verification requires exact current evidence
The system SHALL verify an active product identity only from an operator
decision bound to a currently linked source record, its source ID and record
key, its current identity hash, and a valid HTTPS label or authoritative-source
URL. GTIN presence, source authority, automatic matching, and product activation
MUST NOT create a verified identity outcome.

#### Scenario: Operator verifies a current exact identity
- **WHEN** an operator submits a valid source record, HTTPS evidence URL, and rationale for the active product currently linked to that source identity hash
- **THEN** the system records the exact immutable decision and projects one verified identity outcome with the same provenance

#### Scenario: Requested source is not current for the product
- **WHEN** the source record is missing, linked to another product, or lacks the submitted product's current identity binding
- **THEN** the system rejects the mutation without creating a decision or terminal outcome

#### Scenario: Catalog presence is not verification
- **WHEN** an active product has a valid GTIN or an automatic exact match but no current identity evidence decision
- **THEN** its identity remains outstanding

### Requirement: Identity decisions are immutable and idempotent
The system SHALL retain identity evidence decisions as immutable audit records.
An exact replay of an existing decision MUST be idempotent, while a different
payload for the same product, source record, and identity hash MUST fail as a
conflict without changing the prior decision or projection.

#### Scenario: Exact decision is retried
- **WHEN** the same decision actor retries the same exact binding, evidence URL, rationale, and decision payload
- **THEN** the system reports success without adding or changing audit rows

#### Scenario: Exact binding receives conflicting evidence
- **WHEN** a retry changes an immutable value for an existing product, source record, and identity hash binding
- **THEN** the system returns a conflict and preserves the existing decision and outcome unchanged

### Requirement: Terminal identity projection fails closed on drift
The completion ledger SHALL classify identity as verified only when its terminal
outcome is backed by an immutable decision whose product, source, record key,
record ID, identity hash, evidence URL, and current source linkage all match.
Any missing or contradictory link MUST be outstanding in the evidence-
inconsistent lane.

#### Scenario: Current exact decision backs the outcome
- **WHEN** the terminal outcome and immutable decision both match the currently linked source record and identity hash
- **THEN** the product appears exactly once in the verified identity partition

#### Scenario: Outcome has no current decision
- **WHEN** a verified identity outcome exists without a matching current immutable decision
- **THEN** the product remains outstanding and the completion invariant stays fail closed

#### Scenario: Identity source drifts
- **WHEN** source replay changes the reviewed source record's product linkage, record key, or identity hash
- **THEN** the stale projection no longer verifies the product and reconciliation removes or replaces it only from another exact current decision

### Requirement: Source replay preserves valid identity evidence
Source reconciliation SHALL leave immutable identity decisions intact, restore
terminal identity projections from exact current decisions, and revoke a
projection only when the named source binding is no longer current. It MUST NOT
remove a projection supported by a different still-valid source decision.

#### Scenario: Unchanged source is replayed
- **WHEN** a source-complete artifact repeats the same product, source record, and identity hash
- **THEN** reconciliation preserves one decision and one verified identity outcome without duplicates

#### Scenario: One of multiple identity sources drifts
- **WHEN** the source named by one historical decision changes but another decision for the product remains exact and current
- **THEN** reconciliation retains or restores a verified outcome from the valid alternate source

### Requirement: Identity resolution carries verification evidence
Ambiguous `match` and `create_new` decisions SHALL require a valid HTTPS
identity evidence URL and atomically create the exact-bound identity decision
for the resolved target product. `no_match` MUST NOT create a verified outcome
for an active product.

#### Scenario: Ambiguous record is matched with evidence
- **WHEN** an operator matches an ambiguous source record to a candidate product with valid current evidence and rationale
- **THEN** the source relinking, resolution decision, identity evidence decision, and verified projection either all succeed or all fail

#### Scenario: Create-new lacks evidence
- **WHEN** an operator attempts `create_new` without a valid HTTPS identity evidence URL
- **THEN** the resolution is rejected and the review remains open

#### Scenario: Operator records no match
- **WHEN** an operator resolves an ambiguous record as `no_match`
- **THEN** the proposed product is not made identity-verified and no active completion row is closed by that decision

### Requirement: Identity completion work is actionable
The operator dashboard SHALL provide an accessible identity-verification action
for an outstanding active product with current source evidence, require the
source-bound URL and rationale, explain the evidence boundary, and refresh the
completion ledger after success.

#### Scenario: Verification succeeds from the worklist
- **WHEN** an operator verifies an outstanding identity from the completion worklist
- **THEN** the interface reports success and refreshes the family totals and row so that the product moves to verified

#### Scenario: Verification fails validation or conflicts
- **WHEN** the API rejects stale, incomplete, malformed, or conflicting evidence
- **THEN** the interface displays the error and keeps the product outstanding without optimistic completion
