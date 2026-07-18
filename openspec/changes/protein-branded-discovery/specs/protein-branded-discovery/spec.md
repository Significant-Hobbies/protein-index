## ADDED Requirements

### Requirement: Protein-branded discovery remains independent from category
The system SHALL offer a protein-branded discovery cohort without rewriting a
product's canonical category.

#### Scenario: A protein wafer is canonical `other`
- **WHEN** a product has protein claim evidence but is not categorized as
  `protein_snack`
- **THEN** it appears in the protein-branded discovery cohort and retains its
  canonical category

### Requirement: Discovery includes explicit relevant brand wording
The system SHALL include a product in protein-branded discovery when its brand
contains `protein`, `whey`, or `casein`, while keeping that reason distinct from
a product-level protein claim.

#### Scenario: A protein brand sells a non-claim product
- **WHEN** a product brand contains `protein` but its product text has no
  protein claim
- **THEN** it is discoverable in the cohort with a brand-discovery reason and
  is not falsely marked as marketed protein

### Requirement: Search spans retained discovery metadata
The system SHALL search product name, brand, flavour, GTIN, canonical category,
raw category and marketing reasons token by token.

#### Scenario: Shopper searches across fields
- **WHEN** a shopper searches `protein snacks` and `protein` appears in the
  product claim while `snacks` appears in category metadata
- **THEN** the product is returned if it meets all other selected filters
