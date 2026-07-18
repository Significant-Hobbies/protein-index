## ADDED Requirements

### Requirement: Automatic nutrition verification is evidence-bound
The system SHALL create a machine-verified nutrition fact only when the current
immutable label bytes, macOS Vision OCR, the pinned local vision-language
model, deterministic normalization, and nutrition validation all support the
same declared values and basis.

#### Scenario: Two extractors agree on an exact nutrition table
- **WHEN** an exact current label contains a complete per-100-g nutrition table
  and both extractors reproduce its core values and qualifiers after permitted
  formatting normalization
- **THEN** the system records a `machine_verified` nutrition projection bound
  to the label asset, content hash, extractor versions, model digest, prompt
  hash, and validation report

#### Scenario: Energy unit is confused
- **WHEN** an extractor treats a kJ declaration as kcal or the calorie value
  fails macro and unit validation
- **THEN** the system rejects the attempt and creates no machine-verified fact

### Requirement: Automatic ingredient verification fails closed
The system SHALL create a machine-verified ingredient fact only when a complete
bounded `INGREDIENTS` declaration is visibly present and independently
reproduced without inferred text.

#### Scenario: Ingredient declaration is cropped or curved
- **WHEN** the label image clips, obscures, or bends any part of the
  declaration, or either extractor produces a different normalized string
- **THEN** the system records a rejected outcome with the reason and leaves
  ingredients unverified

#### Scenario: Complete declaration agrees exactly
- **WHEN** both extractors identify the visible start and end of the same
  complete declaration and their normalized ingredient text agrees exactly
- **THEN** the system records a machine-verified ingredient projection with
  its complete image-bound provenance

### Requirement: Machine evidence is reproducible and separate from human review
The system SHALL preserve machine evidence separately from human-reviewed
evidence and SHALL make every accepted or rejected attempt reproducible.

#### Scenario: A model changes
- **WHEN** the local model digest or prompt changes
- **THEN** a new attempt is created and prior accepted evidence remains bound
  to its original model and prompt metadata

#### Scenario: Current label bytes change
- **WHEN** a newer label revision supersedes an image bound to a
  machine-verified projection
- **THEN** the system invalidates the projection and requires a new attempt on
  the newer bytes before publishing it again

#### Scenario: Consumer reads a machine-verified fact
- **WHEN** a catalog response includes a machine-verified fact
- **THEN** the response and dashboard identify it as machine-verified label
  evidence and do not describe it as human, brand, or GS1 verification
