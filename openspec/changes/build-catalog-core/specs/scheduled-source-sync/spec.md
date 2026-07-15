## ADDED Requirements

### Requirement: Source sync runs on a schedule and on demand
The repository SHALL provide a GitHub Actions workflow that runs weekly and via
manual dispatch using the same versioned adapter CLI used locally.

#### Scenario: Weekly schedule fires
- **WHEN** GitHub triggers the configured weekly schedule on the default branch
- **THEN** the workflow downloads the current source export and executes a bounded, streaming sync

#### Scenario: Operator requests a sync
- **WHEN** an operator manually dispatches the workflow with supported options
- **THEN** the workflow records those options and runs the same validation and reporting path

### Requirement: Sync emits reviewable durable artifacts
Each successful sync SHALL emit a source manifest, normalized staged data,
validation/classification report, and hashes as GitHub Actions artifacts without
directly publishing to the production catalog.

#### Scenario: New products are discovered
- **WHEN** the current snapshot contains previously unseen India-tagged records
- **THEN** the staged artifact and report identify the new records for review/import

### Requirement: Empty or sharply reduced snapshots fail closed
The workflow SHALL treat an empty snapshot or an unexplained material count drop
as failure and SHALL NOT emit deletion operations.

#### Scenario: Upstream returns an error page
- **WHEN** downloaded input parses to zero valid source records
- **THEN** the run fails with diagnostics and leaves the prior good snapshot untouched

### Requirement: Adapters declare authorization and freshness behavior
Every source adapter SHALL declare source authority, license/retention notes,
credential requirements, update strategy, and freshness timestamp.

#### Scenario: DataKart credentials are absent
- **WHEN** the DataKart adapter is selected without configured commercial access
- **THEN** it exits with an actionable disabled status and does not fall back to pretending another source is DataKart

### Requirement: Bootstrap sync follows Open Food Facts bulk guidance
The Open Food Facts adapter SHALL use a bulk export for broad discovery, identify
the client in network requests, and SHALL NOT implement broad catalog discovery
as repeated search API calls.

#### Scenario: Bootstrap source runs
- **WHEN** Open Food Facts is selected for an all-India sync
- **THEN** the adapter streams an official export and reports export freshness and processing volume

#### Scenario: Complete tab-separated export is selected
- **WHEN** the tab-separated export contains all fields required for the scheduled catalog sync
- **THEN** scheduled mode may use it instead of the materially larger JSONL export while still traversing every source row
