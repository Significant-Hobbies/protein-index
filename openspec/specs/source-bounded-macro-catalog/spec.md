# source-bounded-macro-catalog Specification

## Purpose
TBD - created by archiving change zero-cost-macro-catalog. Update Purpose after archive.
## Requirements
### Requirement: Source-bounded catalog disclosure
The catalog SHALL disclose that coverage is complete only relative to configured
free sources and SHALL not present that status as complete Indian-market
coverage.

#### Scenario: Incomplete configured source
- **WHEN** a configured source has no current source-complete result
- **THEN** the catalog coverage response SHALL identify that source gap and
shall not describe source-bounded coverage as complete.

### Requirement: Macro-first product comparison
The catalog SHALL default to descending protein per 100 calories and SHALL show
calories, protein, and evidence state for comparable products.

#### Scenario: Reliable macro evidence
- **WHEN** a product has validation-passing calories and protein evidence
- **THEN** it SHALL receive a protein-per-100-calorie value and be eligible for
the default density ordering.

#### Scenario: Missing macro evidence
- **WHEN** a product lacks calories or protein, or its evidence conflicts
- **THEN** it SHALL remain searchable with its evidence gap visible and SHALL
not receive an estimated density value or ranking.

### Requirement: Price-free consumer comparison
The consumer catalog and product detail SHALL not render current offers, price,
cost per serving, or cost per protein as comparison controls or primary content.

#### Scenario: Catalog sort controls
- **WHEN** a user opens the catalog sort control
- **THEN** it SHALL offer protein density, field coverage, and name ordering
without a cost ordering.

#### Scenario: Product detail
- **WHEN** a user opens a product detail view
- **THEN** it SHALL focus on nutrition, evidence, ingredients when available,
and source links without rendering a retailer-offer section.

