## ADDED Requirements

### Requirement: Production source traversal has no arbitrary record cap
Every scheduled production sync SHALL process a configured source's complete
available India slice to terminal cursor or end of export; record limits SHALL
be accepted only in explicit fixture or local-sample mode.

#### Scenario: Scheduled workflow receives a limit
- **WHEN** scheduled production mode is invoked with a sample record limit
- **THEN** the sync fails before publishing artifacts and explains that capped traversal cannot prove source completeness

### Requirement: Coverage is reconciled per source snapshot
The system SHALL record advertised total when available, records read, India
records retained, invalid, duplicate, new, changed, unchanged, missing-since,
known exclusions, input bytes/hash, and terminal-cursor evidence.

#### Scenario: Export is fully consumed
- **WHEN** the adapter reaches a valid end of export and counts reconcile
- **THEN** the snapshot is marked source-complete with its accounting evidence

#### Scenario: An India-tagged source row cannot become a staged product
- **WHEN** a row lacks minimum identity or duplicates another source record ID
- **THEN** the artifact records its source row, available identity, reason, and evidence hash in an exclusion ledger whose count reconciles with the staged India slice

#### Scenario: Stream terminates early
- **WHEN** download or parsing stops before terminal evidence
- **THEN** the snapshot is incomplete and cannot replace the last complete snapshot

### Requirement: Source completeness is not market completeness
The system SHALL distinguish complete traversal of configured sources from
complete coverage of the Indian market and SHALL list unconnected sources and
known discovery limitations.

#### Scenario: Open Food Facts export is exhausted without DataKart
- **WHEN** the open export completes but DataKart is not connected
- **THEN** coverage reports Open Food Facts source-complete and Indian market completeness unproven

### Requirement: Coverage gaps are actionable
The coverage report SHALL identify products missing verified nutrition,
ingredients, valid GTIN, recent evidence, classification inputs, or configured
source presence and SHALL support prioritization by product demand.

#### Scenario: Product has identity but no accurate nutrition
- **WHEN** a canonical product lacks verified nutrition
- **THEN** it appears in the nutrition verification gap count and review queue without being removed from discovery
