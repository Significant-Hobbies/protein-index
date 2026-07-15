## ADDED Requirements

### Requirement: Marketing and nutritional classifications are independent
The classifier SHALL represent marketed-protein and nutritionally
protein-dense as separate boolean-or-unknown results and SHALL NOT infer one
from the other.

#### Scenario: Soy chunks are not marketed with protein language
- **WHEN** verified nutrition satisfies a density threshold but marketing terms do not match
- **THEN** the product is nutritionally protein-dense and not marketed-protein

#### Scenario: Protein snack has inadequate nutrition evidence
- **WHEN** product text contains a protein marketing term but verified nutrition is unavailable
- **THEN** marketed-protein is true and nutritional classification is unknown

### Requirement: Marketed-protein classification is explainable
The classifier SHALL use a versioned vocabulary over normalized product name,
labels, and categories and SHALL return the matched terms as reasons.

#### Scenario: Product name says high protein
- **WHEN** normalized product text contains a configured high-protein phrase
- **THEN** marketed-protein is true and the phrase is included in classification evidence

### Requirement: Nutritional density uses explicit thresholds
The classifier SHALL mark a product nutritionally protein-dense when verified
nutrition establishes at least one of: protein at least 10 g per serving,
protein at least 10 g per 100 kcal, or at least 20 percent of calories from
protein.

#### Scenario: Per-calorie threshold is met
- **WHEN** verified protein and calories calculate to at least 10 g protein per 100 kcal
- **THEN** nutritional classification is true with the calculated threshold result recorded

#### Scenario: Verified inputs fail all thresholds
- **WHEN** verified nutrition and serving inputs are sufficient and every threshold fails
- **THEN** nutritional classification is false rather than unknown

### Requirement: All ingested foods remain distinguishable
The system SHALL retain products classified as neither marketed nor
nutritionally protein-dense and SHALL allow default consumer queries to exclude
them without deleting their evidence.

#### Scenario: Ordinary food is classified neither
- **WHEN** complete verified evidence fails marketing and nutrition criteria
- **THEN** the product remains operator-searchable but is excluded from default protein results

