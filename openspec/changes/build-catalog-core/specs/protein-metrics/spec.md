## ADDED Requirements

### Requirement: Protein density metrics use named formulas
The system SHALL calculate protein grams per 100 kcal as
`protein_g_per_100g / calories_per_100g * 100` and protein calorie percentage
as `protein_g_per_100g * 4 / calories_per_100g * 100`, and SHALL expose them as
separate named values.

#### Scenario: Product has 52 g protein and 360 kcal
- **WHEN** metrics are calculated from 52 g protein and 360 kcal per 100 g
- **THEN** protein per 100 kcal is approximately 14.44 g and protein calorie percentage is approximately 57.78 percent

### Requirement: Price metrics use an offer observation
The system SHALL calculate total pack protein, cost per 25 g protein, protein per
INR 100, and price per serving from one explicitly identified offer and valid
pack/nutrition inputs.

#### Scenario: Offer and pack data are valid
- **WHEN** a product has 500 g net weight, 20 g protein per 100 g, and a selling price of INR 250
- **THEN** total pack protein is 100 g and cost per 25 g protein is INR 62.50

### Requirement: Nutrition-normalized metrics cover buying tradeoffs
The system SHALL calculate calories, sugar, and saturated fat required for 25 g
protein and fibre per 100 calories when their required verified inputs exist.

#### Scenario: Optional nutrient is absent
- **WHEN** verified protein exists but sugar is unavailable
- **THEN** sugar per 25 g protein is unavailable with a missing-sugar reason

### Requirement: Invalid denominators do not produce metrics
Metric functions SHALL return an unavailable result and machine-readable reason
when required values are missing, non-finite, negative, or have a non-positive
denominator.

#### Scenario: Protein is zero
- **WHEN** calories for 25 g protein is requested for a zero-protein product
- **THEN** the metric is unavailable and no infinity or fabricated number is returned

### Requirement: Trusted rankings require verified nutrition
The default trusted ranking SHALL include only products with verified nutrition
and SHALL identify the offer observation used for price-derived ordering.

#### Scenario: Unverified product has an attractive metric
- **WHEN** community-only nutrition would place a product highly
- **THEN** it remains outside the default trusted ranking and is visibly labeled unverified

### Requirement: Completeness is transparent
The system SHALL report which identity, nutrition, ingredient, pack, offer, and
evidence fields contribute to completeness rather than exposing only an opaque
score.

#### Scenario: Product lacks ingredients and current offer
- **WHEN** completeness is calculated
- **THEN** the response lists ingredients and current offer as missing components

