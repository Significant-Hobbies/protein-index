## ADDED Requirements

### Requirement: Reviewed nutrition candidates preserve their physical basis
The system SHALL represent mass-normalized and volume-normalized label evidence
as distinct candidate shapes and SHALL reject candidates whose value field and
declared basis are missing, ambiguous, or incompatible.

#### Scenario: Direct liquid nutrition is extracted
- **WHEN** a liquid product declares a per-100-mL nutrition row and the model returns valid protein and calorie values for that row
- **THEN** the review candidate contains `nutritionPer100ml`, retains the per-100-mL basis, and does not contain `nutritionPer100g`

#### Scenario: Candidate contains both physical bases
- **WHEN** an evidence payload contains both `nutritionPer100g` and `nutritionPer100ml`
- **THEN** candidate validation rejects the payload before it can be reviewed or published

### Requirement: Serving conversion requires an explicit matching dimension
The system SHALL normalize a per-serving prediction to 100 g only from an
explicit serving mass and to 100 mL only from an explicit serving volume. It
MUST NOT infer density or convert between millilitres and grams.

#### Scenario: Liquid serving volume is explicit
- **WHEN** a per-serving liquid prediction has a finite positive serving volume of 250 mL
- **THEN** every supported nutrient is multiplied by `100 / 250`, the candidate contains `nutritionPer100ml`, and its origin remains per serving

#### Scenario: Liquid serving quantity is ambiguous
- **WHEN** a per-serving liquid prediction has no explicit volume unit or only a pack quantity
- **THEN** the system records a basis-validation rejection and emits no normalized nutrition candidate

#### Scenario: Mass and volume evidence disagree in dimension
- **WHEN** the product is volume-based but only a serving mass is available
- **THEN** the system does not use that mass to normalize the liquid prediction

### Requirement: Candidate hashes remain backward compatible
The system SHALL preserve the canonical serialization and hash of every valid
existing mass candidate while deterministically hashing the new volume
candidate shape.

#### Scenario: Legacy reviewed mass decision is replayed
- **WHEN** an existing checksummed mass review bundle is parsed after this change
- **THEN** its candidate hash is unchanged and the decision remains valid

#### Scenario: Equivalent volume candidates are hashed
- **WHEN** two volume candidates contain the same normalized fields in different input key orders
- **THEN** canonical hashing produces the same volume candidate hash for both

### Requirement: Verified volume nutrition publishes atomically
The system SHALL publish an approved volume candidate as verified
`per_100ml` nutrition across the selected nutrition fact, generic nutrient
values, field provenance, and evidence outcome in one transaction.

#### Scenario: Reviewer verifies exact per-100-mL label values
- **WHEN** a reviewer approves a source-matched volume candidate against its exact current label image
- **THEN** the product's selected nutrition fact and supported nutrient values use `basis = 'per_100ml'`, authority 100 provenance identifies the evidence decision, and the matching review item resolves

#### Scenario: Volume publication is replayed
- **WHEN** the same verified volume decision is published again
- **THEN** all selected values and counts remain unchanged and no duplicate evidence rows are created

#### Scenario: Source evidence has drifted
- **WHEN** the current source candidate no longer matches the reviewed volume candidate hash
- **THEN** publication fails before any verified nutrition or review status changes

### Requirement: Review surfaces identify the exact basis
The operator dashboard and review API SHALL expose whether candidate values are
per 100 g, per 100 mL, or converted from a serving, without relabeling volume
values as mass.

#### Scenario: Operator opens a volume candidate
- **WHEN** a per-100-mL candidate is rendered in the evidence queue
- **THEN** the heading and nutrient values state `per 100 mL` and the exact image, model, observation, and source evidence remain visible

#### Scenario: Operator opens a volume-serving candidate
- **WHEN** a candidate was normalized from an explicit liquid serving
- **THEN** the UI states both that the normalized values are per 100 mL and that the model-origin basis was per serving

### Requirement: Metrics respect nutrition dimensions
The system SHALL calculate ratios whose numerator and denominator share the
same nutrition basis and SHALL withhold mass- or serving-dependent economic
metrics when compatible quantity evidence is absent.

#### Scenario: Protein density uses liquid nutrition
- **WHEN** verified per-100-mL nutrition declares 10 g protein and 50 kcal
- **THEN** protein per 100 calories is 20 g and calories from protein is 80 percent

#### Scenario: Liquid has no compatible pack mass
- **WHEN** a product has verified per-100-mL nutrition but no evidence-backed pack mass or serving mass
- **THEN** total pack protein, protein per rupee, cost per 25 g protein, and price per serving remain unavailable

### Requirement: Exhaustive extraction accounts for liquid outcomes
The source-complete nutrition extraction SHALL account for every eligible
barcode and distinguish valid volume candidates from basis-validation
rejections without automatically verifying model output.

#### Scenario: Exhaustive run contains liquid labels
- **WHEN** a source-complete snapshot contains valid direct per-100-mL predictions
- **THEN** those barcodes produce review-only volume candidates, terminal outcome totals still reconcile to the requested barcode count, and verified-nutrition coverage does not change
