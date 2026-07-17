## ADDED Requirements

### Requirement: Every active product has one family completion state
The system SHALL classify every active product exactly once for each requested
field family `identity`, `nutrition`, or `ingredients` as `verified`,
`terminal_unavailable`, or `outstanding`.

#### Scenario: Exact family partition
- **WHEN** the completion summary is calculated for a field family
- **THEN** verified plus terminal unavailable plus outstanding SHALL equal the active product count
- **THEN** every active product SHALL contribute to exactly one state

#### Scenario: Inactive products are excluded
- **WHEN** a product is inactive
- **THEN** it SHALL not contribute to the ledger, summary, or completion gate

### Requirement: Completion accounting fails closed
The system SHALL not treat stale or contradictory evidence projections as
completed product evidence.

#### Scenario: Stale verified outcome
- **WHEN** a product has a verified evidence outcome but its current family fact is missing, unverified, or conflicting
- **THEN** the product SHALL remain outstanding in the `evidence_inconsistent` lane

#### Scenario: Verified fact contradicts unavailable outcome
- **WHEN** a current authority-100 verified fact coexists with a `not_declared` or `not_applicable` outcome
- **THEN** the product SHALL remain outstanding in the `evidence_inconsistent` lane
- **THEN** the completion gate SHALL remain incomplete

#### Scenario: Conflicting fact contradicts unavailable outcome
- **WHEN** a current conflicting fact coexists with a `not_declared` or
  `not_applicable` outcome
- **THEN** the product SHALL remain outstanding in the
  `evidence_inconsistent` lane
- **THEN** the unavailable projection SHALL not close the family gap

#### Scenario: Current verified fact
- **WHEN** a nutrition or ingredient fact has current status `verified`, authority 100, and no contradictory unavailable outcome
- **THEN** the product SHALL be classified as verified for that family

#### Scenario: Evidence-backed unavailable outcome
- **WHEN** a nutrition or ingredient fact is not verified and its outcome is `not_declared` or `not_applicable` with a non-empty evidence URL
- **THEN** the product SHALL be classified as terminal unavailable
- **THEN** the system SHALL preserve the exact unavailable outcome and evidence link

### Requirement: Outstanding work has one honest action lane
The system SHALL assign each outstanding row exactly one lane using retained
database evidence and deterministic precedence.

#### Scenario: Conflicting current fact
- **WHEN** the selected family fact is conflicting and no higher-priority evidence inconsistency exists
- **THEN** the row SHALL use the `conflict_resolution` lane

#### Scenario: Source-bound candidate is ready
- **WHEN** a product has an open family-matching source-bound extraction candidate and no higher-priority lane applies
- **THEN** the row SHALL use the `review_ready` lane
- **THEN** the row SHALL include the open candidate and review counts

#### Scenario: Structured evidence is unverified
- **WHEN** a product has a current unverified family fact and no higher-priority lane applies
- **THEN** the row SHALL use the `structured_evidence_review` lane

#### Scenario: Label evidence needs review
- **WHEN** a product has a family label image but no usable open candidate and no higher-priority lane applies
- **THEN** the row SHALL use the `label_evidence_review` lane
- **THEN** the system SHALL not claim whether extraction was unattempted, rejected, failed, or produced no prediction

#### Scenario: Source evidence is still needed
- **WHEN** no current fact, candidate, or family label evidence exists
- **THEN** the row SHALL use the `source_evidence_needed` lane

### Requirement: Completion ledger API is bounded and deterministic
The system SHALL expose a read-only completion-ledger API with validated family,
state, lane, search, page, and page-size filters.

#### Scenario: Default request
- **WHEN** a client requests the ledger without optional filters
- **THEN** the API SHALL return outstanding nutrition rows ordered by lane priority, normalized brand, normalized product name, and product ID
- **THEN** the response SHALL include family summary, pagination, filters, and
  the latest completed source-run time as source context

#### Scenario: Valid filtered request
- **WHEN** a client supplies supported family, state, lane, search, page, and page-size filters
- **THEN** the API SHALL return only matching rows and an unfiltered full-family summary
- **THEN** no product SHALL appear more than once in the response

#### Scenario: Invalid request
- **WHEN** a filter is unsupported, search exceeds catalog bounds, page is below one, or page size is outside 1 through 100
- **THEN** the API SHALL return a structured 400 validation error

#### Scenario: One-to-many evidence
- **WHEN** a product has multiple source records or reviews
- **THEN** the ledger SHALL still return one product row
- **THEN** evidence counts and the selected evidence link SHALL be deterministic

### Requirement: Coverage and ledger share one completion contract
The existing coverage endpoint and the completion ledger SHALL derive family
completion counts from the same strict accounting rules.

#### Scenario: Cross-endpoint agreement
- **WHEN** coverage and completion-ledger summaries are requested for the same database snapshot
- **THEN** their outstanding identity, nutrition, and ingredient counts SHALL agree exactly

#### Scenario: Global completion gate
- **WHEN** any family has an outstanding row, an accounting contradiction exists, or configured-source coverage is incomplete
- **THEN** the global completion status SHALL be incomplete

### Requirement: Dashboard exposes actionable completion drill-downs
The dashboard SHALL turn completion totals into a responsive, accessible
product worklist without promoting unverified facts.

#### Scenario: Drill down from a coverage state
- **WHEN** an operator activates an outstanding, verified, or terminal coverage control
- **THEN** the dashboard SHALL load the corresponding family and state rows
- **THEN** the control and result count SHALL communicate the active filter without relying on color alone

#### Scenario: Inspect product and evidence
- **WHEN** an operator activates a ledger product or evidence action
- **THEN** the existing product detail drawer or exact evidence/review destination SHALL open
- **THEN** unverified or inconsistent evidence SHALL remain visibly labeled

#### Scenario: Responsive and keyboard-operable worklist
- **WHEN** the dashboard is used on desktop, mobile, or by keyboard
- **THEN** family and state controls, result rows, evidence links, and pagination SHALL remain operable with visible focus and semantic status text
- **THEN** loading, error, and result-count changes SHALL be announced accessibly

### Requirement: Ledger queries remain set based
The completion ledger SHALL use a fixed number of set-based D1 queries and
bounded result rows.

#### Scenario: Reviews and sources do not multiply products
- **WHEN** the ledger gathers open reviews and source evidence
- **THEN** it SHALL pre-aggregate them to one row per product before joining active products
- **THEN** the query plan SHALL contain no correlated review subquery

#### Scenario: Index decision is evidenced
- **WHEN** the final local query plan uses existing indexes within the bounded performance budget
- **THEN** no new migration SHALL be added
- **THEN** a new completion index SHALL be added only when query-plan evidence demonstrates it is required
