## ADDED Requirements

### Requirement: Direct macro comparison

The catalog SHALL show protein, carbohydrate, fat, fibre, calories, and
protein per 100 kcal directly for each product without requiring a product
detail interaction.

#### Scenario: Shopper scans a desktop result

- **WHEN** a product is rendered in the catalog table
- **THEN** its five macros and protein density are visible as table columns.

#### Scenario: Shopper scans a mobile result

- **WHEN** a product is rendered as a mobile card
- **THEN** its five macros and protein density are visible in the card.

### Requirement: Concise consumer product detail

The consumer product drawer SHALL show only product identity, the five macros,
and protein density, and SHALL NOT show expandable provenance or source-record
sections.

#### Scenario: Shopper opens a product

- **WHEN** a product drawer is rendered
- **THEN** it contains no provenance, source-record, ingredient, rating, or
  additional-nutrient drill-down section.
