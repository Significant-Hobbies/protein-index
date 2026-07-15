## ADDED Requirements

### Requirement: Catalog search exposes protein and evidence filters
The API and web application SHALL support bounded search by text, category,
marketed-protein state, nutritional-protein state, nutrition verification state,
and minimum completeness.

#### Scenario: Consumer opens trusted protein results
- **WHEN** the default trusted view loads
- **THEN** results are protein-relevant, use verified nutrition, show evidence status, and are bounded and sortable

### Requirement: Product detail explains comparisons
Product detail SHALL expose canonical identity, classifications and reasons,
selected nutrition, metric inputs and outputs, ingredients, source-specific
offers and ratings, completeness gaps, and selected-field provenance.

#### Scenario: User inspects cost per 25 g protein
- **WHEN** a price-derived metric is displayed
- **THEN** the UI identifies the exact offer price, pack size, nutrition value, and observation time used

### Requirement: Review queue supports safe entity decisions
The operator UI SHALL list unresolved items by type and priority and SHALL allow
match, create-new, no-match, verify-nutrition, and reject-nutrition decisions
without discarding evidence.

#### Scenario: Operator resolves ambiguous variants
- **WHEN** an operator chooses one candidate after comparing identifiers and pack attributes
- **THEN** the decision is persisted, the item is resolved, and the source record is reconciled idempotently

### Requirement: Missing and unverified data are visually explicit
The UI SHALL distinguish unavailable, unverified, verified, and conflicting
nutrition and SHALL NOT render missing values as zero.

#### Scenario: Nutrition is missing
- **WHEN** a product has no usable protein value
- **THEN** rankings exclude it and detail shows nutrition missing rather than 0 g protein

### Requirement: API errors are structured
The Worker API SHALL return a stable error code, human-readable message, and
appropriate HTTP status for validation, not-found, conflict, and internal
errors without exposing raw source payloads unintentionally.

#### Scenario: Product does not exist
- **WHEN** a client requests an unknown product identifier
- **THEN** the API returns HTTP 404 with a structured not-found error

