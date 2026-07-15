## ADDED Requirements

### Requirement: Exact validated GTIN has highest automatic match priority
The resolver SHALL match an incoming record to an existing product when their
validated normalized GTINs are equal.

#### Scenario: Known GTIN returns
- **WHEN** an incoming source record has the same validated normalized GTIN as one product
- **THEN** the resolver attaches the source record to that product and records the exact-GTIN rule

### Requirement: Exact composite matching is conservative
The resolver SHALL use brand, normalized name, flavour, and net quantity for an
automatic composite match only when every required component is present,
normalized, and uniquely equal.

#### Scenario: Unique exact composite exists
- **WHEN** a record without GTIN exactly and uniquely matches all composite fields
- **THEN** the resolver may attach it and records the composite rule and inputs

#### Scenario: Pack quantity is missing
- **WHEN** a record matches brand and name but lacks net quantity
- **THEN** the resolver does not auto-merge it

### Requirement: Ambiguous matches require human resolution
The resolver SHALL create a review item containing candidates, scores, evidence,
and the proposed rule whenever more than one plausible product exists.

#### Scenario: Fuzzy name matches two variants
- **WHEN** a source record is similar to two flavours or pack sizes
- **THEN** neither product is modified and the candidates enter the review queue

### Requirement: Manual decisions are durable
The system SHALL store operator merge, no-match, and create-new decisions with
time and rationale, and SHALL reuse those decisions for the same source record
unless the underlying identity evidence changes.

#### Scenario: Operator rejects a suggested match
- **WHEN** an operator marks a source record as a distinct product
- **THEN** subsequent unchanged imports do not recreate the rejected suggestion

