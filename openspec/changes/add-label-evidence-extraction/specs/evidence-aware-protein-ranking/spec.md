## ADDED Requirements

### Requirement: Protein per 100 kcal is the primary comparison
The catalog SHALL use protein grams per 100 kcal as its primary metric, using
`protein_g_per_100g / calories_per_100g * 100`, and SHALL order products with a
valid value ahead of products whose inputs are unavailable.

#### Scenario: User opens the catalog
- **WHEN** the default catalog view loads
- **THEN** it opens the all-food discovery catalog ordered by protein grams per 100 kcal descending, with the narrower protein cohort available as a scope filter

#### Scenario: Inputs are unavailable
- **WHEN** a product lacks protein or a positive calorie value
- **THEN** it is placed after comparable products and the metric is shown as unavailable rather than zero

### Requirement: Metric evidence state is explicit
Every displayed protein-density value SHALL carry the selected nutrition
evidence state and SHALL visually distinguish unverified, verified, and
conflicting values.

#### Scenario: Community nutrition produces a metric
- **WHEN** valid unverified nutrition contains both protein and calories
- **THEN** discovery may display and rank the calculated value with an unverified label and source attribution

#### Scenario: Verified-only mode is selected
- **WHEN** the user switches to Trusted
- **THEN** unverified and conflicting nutrition are excluded from the result set and rankings

### Requirement: Invalid nutrition never enters a ranking
The API SHALL calculate discovery metrics only from candidates that pass
nutrition validation and SHALL withhold calculations for conflict or missing
states.

#### Scenario: Source values fail validation
- **WHEN** a product has nutrition fields but an error-level validation issue
- **THEN** its protein-density metric is unavailable with a machine-readable validation reason

### Requirement: Mobile and desktop emphasize the same metric
The responsive catalog SHALL present protein per 100 kcal as the first numeric
comparison on both desktop rows and mobile cards.

#### Scenario: User views a phone-sized layout
- **WHEN** a product has a valid discovery metric
- **THEN** the card shows protein per 100 kcal together with its evidence state without requiring the detail drawer

### Requirement: Consumer UI does not expose hosting infrastructure
The dashboard SHALL describe product-data freshness and evidence state without
naming the hosting provider or presenting deployment status as a user-facing
product feature.

#### Scenario: Production dashboard loads
- **WHEN** a user opens the deployed catalog
- **THEN** the header contains evidence freshness or catalog status and does not mention Cloudflare
