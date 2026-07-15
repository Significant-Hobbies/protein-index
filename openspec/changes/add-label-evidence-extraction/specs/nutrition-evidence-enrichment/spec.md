## ADDED Requirements

### Requirement: Enrichment exhausts the configured barcode set
The enrichment job SHALL request every valid barcode from the selected
source-complete catalog snapshot and SHALL account for each barcode as enriched,
unchanged, not found, rejected, or failed after retry.

#### Scenario: Enrichment completes normally
- **WHEN** the job reaches the end of a 17,000-product barcode set
- **THEN** its outcome counts sum exactly to the number of distinct requested barcodes

#### Scenario: A batch is interrupted
- **WHEN** the job stops after writing completed batch artifacts
- **THEN** a retry resumes from the recorded barcode outcomes without refetching completed batches

### Requirement: Official read APIs are consumed within documented limits
The enrichment job SHALL identify itself, use the documented multi-code product
query, bound batch size, serialize requests to the documented search limit, and
honor retry guidance for throttling and transient server failures.

#### Scenario: Source returns a throttling response
- **WHEN** Open Food Facts returns HTTP 429 or 503
- **THEN** the job waits using bounded exponential backoff and records a final failure if the retry budget is exhausted

### Requirement: Rich source fields retain provenance
The system SHALL retain the returned nutrition, ingredients, quantities, image
references, quality tags, revision timestamp, request batch, and source URL as
immutable evidence associated with the exact barcode.

#### Scenario: API data fills a CSV export gap
- **WHEN** a barcode has no nutrition in the bulk CSV but the richer product response has protein and calories
- **THEN** the API observation is stored separately, selected according to authority and recency, and remains traceable to the response artifact

#### Scenario: Nutrition is declared for a liquid
- **WHEN** product quantity metadata establishes a volume-based product
- **THEN** normalized nutrition and generic nutrient observations use a per-100-ml basis and the dashboard does not label them per 100 g

### Requirement: Label extraction is review gated
Robotoff nutrition-extraction output SHALL be normalized only when its image,
basis, unit, value, model version, and confidence are present, and it SHALL remain
an unverified candidate until approved against current label evidence.

#### Scenario: High-confidence model output exists
- **WHEN** a nutrition image produces plausible protein and calorie predictions above the configured confidence threshold
- **THEN** the system queues the candidate with the image and raw prediction but does not mark it verified

#### Scenario: Per-serving prediction lacks a serving mass
- **WHEN** a model returns protein per serving and the serving mass is unavailable or ambiguous
- **THEN** the system does not convert it to per-100-g nutrition and records a basis-validation issue

### Requirement: Nutrition candidates fail closed
All structured and extracted nutrition SHALL pass numeric, mass-balance, macro,
basis, preparation-state, and cross-field validation before selection.

#### Scenario: Protein and calories imply an impossible label
- **WHEN** a candidate has protein above 100 g per 100 g or a non-positive calorie denominator
- **THEN** no comparison metric is emitted and a nutrition-validation review item is created

### Requirement: Coverage distinguishes data from verification
Coverage reporting SHALL separately count products with structured nutrition,
products with a nutrition image, products with extraction candidates, and
products with verified nutrition.

#### Scenario: Extraction increases coverage without verification
- **WHEN** 500 missing products receive valid model candidates and no human decision
- **THEN** candidate coverage increases by 500 while verified-nutrition coverage remains unchanged

### Requirement: Completion requires verified field coverage
The project SHALL NOT declare the product data complete while any active product
lacks verified current nutrition or ingredients, unless current authoritative or
label evidence explicitly establishes that the field is not applicable or is not
declared on the package.

#### Scenario: One product remains unverified
- **WHEN** the active catalog contains one product whose nutrition is missing or unverified
- **THEN** the completion gate remains failed and reports that product in the outstanding coverage ledger

#### Scenario: A package declares no nutrition information
- **WHEN** a current package label or authoritative source explicitly confirms that nutrition is not declared
- **THEN** the product receives a terminal evidence-backed unavailable state rather than a fabricated value

### Requirement: Complete means reconciled source and product accounting
The completion gate SHALL require every configured source run to be exhausted
and every retained active product to have a terminal, evidence-backed outcome for
identity, nutrition, and ingredients.

#### Scenario: Source coverage is complete but product evidence is not
- **WHEN** every source row is reconciled but some product fields remain unverified
- **THEN** source coverage passes while the overall completion gate remains failed
