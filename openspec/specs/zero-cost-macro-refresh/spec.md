# zero-cost-macro-refresh Specification

## Purpose
TBD - created by archiving change zero-cost-macro-catalog. Update Purpose after archive.
## Requirements
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

### Requirement: Bounded local label queue
The system SHALL derive a deterministic queue of current label images that are
missing calories or protein and SHALL never synthesize macro values for an
unreadable, absent, conflicting, or basis-ambiguous label.

#### Scenario: Limited label processing
- **WHEN** a refresh is invoked with a label limit
- **THEN** it SHALL process no more than that count, retain the remaining queue
for a later run, and record the limit in the run report.

#### Scenario: Machine extraction disagreement
- **WHEN** local extractors disagree or validation fails
- **THEN** the product SHALL retain its missing or previous evidence state and
shall not receive a protein-per-calorie metric from the attempted output.

### Requirement: Local scheduled refresh template
The system SHALL provide a macOS scheduler template and documented local
wrapper for weekly refreshes that require no cloud credentials or paid service.

#### Scenario: Scheduled invocation
- **WHEN** the scheduler invokes the wrapper from a valid checked-out project
- **THEN** the wrapper SHALL run the local refresh command with a user-selected
local data directory and append stdout/stderr to local logs.

#### Scenario: Overlapping invocation
- **WHEN** a prior local refresh holds the advisory lock
- **THEN** a second invocation SHALL exit without starting a concurrent source
or model run and SHALL leave the existing run intact.

