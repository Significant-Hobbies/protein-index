## MODIFIED Requirements

### Requirement: Local source-bounded macro refresh
The system SHALL provide a local command that creates a uniquely identified,
checksummed refresh directory and orchestrates configured free source staging
without publishing to remote D1. Independent configured first-party brand
sources SHALL run with a bounded operator-configurable concurrency while each
source retains its own request interval, page ceiling, retry policy, and
terminal outcome.

#### Scenario: Complete source refresh
- **WHEN** an operator runs the refresh command with all enabled sources
- **THEN** it SHALL write terminal Open Food Facts and per-brand outcomes,
source manifests, and an aggregate coverage report to the refresh directory.

#### Scenario: Bounded brand concurrency
- **WHEN** an operator runs the refresh with a brand concurrency greater than
one
- **THEN** no more than that many brand discovery jobs SHALL be active at once
and report outcomes SHALL remain in configured source order.

#### Scenario: Source failure
- **WHEN** a configured source cannot reach a terminal source-complete result
- **THEN** the command SHALL record the failure, return a non-success result,
and SHALL NOT describe the aggregate catalog as source-complete or publish it.
