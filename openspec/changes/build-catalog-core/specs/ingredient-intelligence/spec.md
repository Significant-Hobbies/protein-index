## ADDED Requirements

### Requirement: Raw ingredient evidence is preserved
The system SHALL preserve the exact available ingredient statement, language,
source, observation time, evidence reference, and verification state alongside
any normalized representation.

#### Scenario: Ingredient parser improves later
- **WHEN** normalization logic is upgraded
- **THEN** the system can reparse the original statement without refetching or losing prior evidence

### Requirement: Normalized ingredients preserve meaning and order
The system SHALL retain ingredient order, nested sub-ingredients, declared
percentages, normalized names, and unmapped raw fragments and SHALL NOT invent a
normalized value when parsing is uncertain.

#### Scenario: Compound ingredient is parsed
- **WHEN** a label lists a compound ingredient with parenthesized components
- **THEN** the normalized result retains the parent ingredient and ordered nested components

#### Scenario: Fragment is ambiguous
- **WHEN** an ingredient fragment cannot be mapped confidently
- **THEN** its raw text and position remain available with an unresolved normalization state

### Requirement: Allergens distinguish declaration type
The system SHALL represent allergens declared as `contains`, precautionary `may
contain`, and source-derived tags separately with source evidence.

#### Scenario: Label has contains and may-contain statements
- **WHEN** both declaration types are present
- **THEN** the API and UI do not collapse them into an undifferentiated allergen list

### Requirement: Additives remain evidence based
The system SHALL store additive identifiers and source text only when declared
or deterministically mapped and SHALL expose the mapping confidence.

#### Scenario: INS number is present
- **WHEN** an ingredient statement declares an INS additive number
- **THEN** the system preserves the declared text and normalized identifier with source provenance

### Requirement: Ingredient accuracy is explicit
Ingredient data SHALL use `missing`, `unverified`, `verified`, or `conflict`, and
community-only ingredient data SHALL NOT be represented as label-verified.

#### Scenario: Open Food Facts supplies ingredients
- **WHEN** no permitted official record or confirmed current label exists
- **THEN** ingredients remain unverified even if parsing succeeds

#### Scenario: Current label conflicts with selected statement
- **WHEN** a human-confirmed current label materially differs from existing selected ingredients
- **THEN** the label evidence is retained, the state is conflict until resolved, and the change is not hidden

