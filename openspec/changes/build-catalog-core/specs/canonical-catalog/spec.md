## ADDED Requirements

### Requirement: Canonical product identity is independent of listings
The system SHALL represent a canonical product separately from retailer
listings, offers, and ratings, and SHALL NOT use a retailer listing identifier
as the canonical product identifier.

#### Scenario: Same product appears at two retailers
- **WHEN** two retailer listings resolve to the same canonical product
- **THEN** the system stores one product and two independently timestamped listing records

### Requirement: GTIN is normalized and validated
The system SHALL validate GTIN check digits, normalize valid GTIN-8, GTIN-12,
GTIN-13, and GTIN-14 identifiers to a comparable 14-digit representation, and
preserve each source's original representation as evidence.

#### Scenario: Equivalent barcode formats arrive
- **WHEN** two source records provide equivalent valid GTIN representations
- **THEN** the system resolves both to the same canonical GTIN without discarding their raw values

#### Scenario: Invalid barcode arrives
- **WHEN** a source record has an invalid GTIN check digit
- **THEN** the system does not assign it as canonical identity and creates a validation review item

### Requirement: Offers remain source and location specific
The system SHALL store retailer, listing identifier, seller, pincode, price,
availability, URL, and observation time on an offer without overwriting offers
from other retailer, seller, location, or observation combinations.

#### Scenario: Price varies by pincode
- **WHEN** the same retailer listing has different observed prices in two pincodes
- **THEN** both observations remain queryable with their respective pincodes and timestamps

### Requirement: Ratings remain source specific
The system SHALL retain stars, rating count, review count, retailer, listing
identifier, and observation time together and SHALL NOT expose an unqualified
cross-retailer aggregate rating.

#### Scenario: Retailers show different ratings
- **WHEN** two retailers report ratings for the same product
- **THEN** product detail returns both ratings with source and sample-size context

### Requirement: Nutrition has an explicit verification state
The system SHALL store nutrition as `missing`, `unverified`, `verified`, or
`conflict`, and SHALL preserve its basis, preparation state, evidence source,
confidence, and verification timestamp.

#### Scenario: Community nutrition is imported
- **WHEN** nutrition is available only from Open Food Facts
- **THEN** the product is discoverable with unverified nutrition and is excluded from trusted rankings by default

#### Scenario: Current package label is confirmed
- **WHEN** an operator confirms a current readable package label and validation passes
- **THEN** the selected nutrition becomes verified with the evidence and verification time recorded

#### Scenario: Authoritative values conflict
- **WHEN** two current high-authority nutrition observations materially disagree
- **THEN** the product nutrition state becomes conflict and no conflicting value silently wins

### Requirement: Selected fields remain traceable
The system SHALL link each selected canonical field to the source observation
and ingestion run that supplied it.

#### Scenario: Operator inspects protein value
- **WHEN** an operator opens provenance for selected protein grams
- **THEN** the system returns the normalized value, raw value, source, confidence, observation time, and evidence reference

