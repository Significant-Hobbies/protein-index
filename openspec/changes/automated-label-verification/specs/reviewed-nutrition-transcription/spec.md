## MODIFIED Requirements

### Requirement: Corrected evidence has explicit verification authority
The system MUST distinguish human-reviewed projections from reproducible
machine-verified projections and MUST NOT represent either as the other.
Human-reviewed projections require a human reviewer decision. Machine-verified
projections require the separate exact-label, independent-extractor, and
deterministic-validation contract and carry a distinct evidence state.

#### Scenario: Automated extraction finds a plausible correction
- **WHEN** a local OCR and model pipeline produces a plausible nutrition value
- **THEN** it remains unverified unless the automated-label-verification
  contract accepts an exact current-label machine projection

#### Scenario: Machine extraction meets the exact-label contract
- **WHEN** a reproducible automation attempt satisfies every automatic
  acceptance rule for an exact current label
- **THEN** the system publishes it as `machine_verified` without creating a
  human reviewer decision or increasing human-verified coverage

#### Scenario: Consumer inspects evidence authority
- **WHEN** a response or dashboard shows a human-reviewed or machine-verified
  nutrition fact
- **THEN** it exposes the respective authority without collapsing both states
  into a single verification label
