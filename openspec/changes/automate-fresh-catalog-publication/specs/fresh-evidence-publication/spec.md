## ADDED Requirements

### Requirement: Successful source artifacts publish automatically
The system SHALL automatically attempt production publication after successful default-branch runs of the complete Open Food Facts discovery, API enrichment, nutrition-label extraction, and ingredient-label extraction workflows.

#### Scenario: Weekly discovery completes
- **WHEN** the scheduled `Source sync` workflow completes successfully on `main`
- **THEN** the exact checksummed discovery artifact from that run enters the protected automatic publication path

#### Scenario: Downstream evidence extraction completes
- **WHEN** an enrichment or extraction workflow exhausts its exact configured cohort without failed outcomes
- **THEN** its exact run artifact enters the same serialized publication path

#### Scenario: Upstream workflow fails
- **WHEN** an eligible upstream workflow is cancelled, skipped, or fails
- **THEN** automatic publication performs no production write

### Requirement: Automatic publication trusts only pinned complete evidence
Automatic publication MUST pin the upstream run ID and head SHA, verify that the run belongs to the expected workflow on the default branch, verify every declared artifact checksum, and apply the source-specific completeness and accounting invariants before generating a remote write.

#### Scenario: Artifact identity does not match the trigger
- **WHEN** the downloaded artifact name, manifest source, input hash, or cohort accounting does not match the triggering workflow run
- **THEN** publication fails before any D1 mutation and retains diagnostic evidence

#### Scenario: Discovery drop guard is weakened manually
- **WHEN** a manually dispatched source sync records a continuity threshold above the automatic publication ceiling of 20 percent
- **THEN** the artifact may remain reviewable but automatic publication rejects it

#### Scenario: Extraction retains a failed barcode
- **WHEN** an enrichment or extraction report has a failed outcome or does not reconcile requested and accounted barcodes
- **THEN** automatic publication fails before any D1 mutation

### Requirement: Automatic publication cannot create verified evidence
Automatic publication SHALL store Open Food Facts discovery and enrichment values as unverified evidence and Robotoff output as review-only evidence. It MUST NOT create verification decisions, terminal verified outcomes, or verified nutrition/ingredient facts without a pre-existing exact manually reviewed decision.

#### Scenario: Community nutrition is refreshed
- **WHEN** a newer Open Food Facts record contains calories, protein, other nutrients, or ingredients
- **THEN** the evidence may update discovery data but remains explicitly unverified in the API and dashboard

#### Scenario: Label candidate is published
- **WHEN** a source-complete Robotoff artifact contains a candidate prediction
- **THEN** the candidate becomes reviewable without increasing verified nutrition or verified ingredient counts

#### Scenario: Reviewed source content drifts
- **WHEN** automatic publication observes content that no longer matches an active exact review decision
- **THEN** the existing drift rules revoke or conflict the affected trust rather than silently retaining verification

### Requirement: Automatic refresh preserves stronger and richer selected evidence
Reconciliation SHALL never replace higher-authority selected evidence with automatic community evidence. At equal authority, a newer nutrition observation SHALL replace the selected projection only when it does not reduce the number of populated normalized nutrient fields; every source observation remains retained regardless of selection.

#### Scenario: Bulk export is newer but less complete than API enrichment
- **WHEN** a newer bulk record has fewer populated normalized nutrition fields than the equal-authority selected API record
- **THEN** the bulk observation is retained but the richer selected nutrition projection remains unchanged

#### Scenario: Human-verified label exists
- **WHEN** automatic evidence is newer than a selected human-verified label
- **THEN** the verified label remains selected unless exact source drift invalidates its recorded decision

### Requirement: Automatic publication never applies schema migrations
The automatic path SHALL fail closed when remote D1 has a pending migration and SHALL invoke publication in a mode that cannot apply migrations. Schema changes remain an explicit reviewed operation.

#### Scenario: Main contains an unapplied migration
- **WHEN** an eligible source artifact completes while a remote migration is pending
- **THEN** publication fails before import and reports the pending migration

### Requirement: Production writes are serialized and replay-safe
Every automatic or manual catalog/evidence publication SHALL share one production concurrency group. Replaying the same artifact MUST preserve canonical identity, avoid duplicate source records or reviews, and record an idempotent completed ingestion run.

#### Scenario: GitHub redelivers a workflow-run event
- **WHEN** the same successful artifact is published twice
- **THEN** the second run completes without duplicating products, source records, review items, or verification decisions

#### Scenario: Several evidence families finish together
- **WHEN** discovery, enrichment, and extraction artifacts become eligible concurrently
- **THEN** their production writes execute one at a time without cancellation

### Requirement: Every automatic publication produces durable postcondition evidence
The workflow SHALL capture the triggering run identity, artifact and manifest hashes, pre-write counts, publication output, post-write counts, exact completed ingestion run, verified-fact deltas, and live API checks in a retained artifact.

#### Scenario: Publication succeeds
- **WHEN** the import completes and postconditions match the pinned artifact
- **THEN** the workflow records success only after the exact ingestion run is completed, counts remain non-empty and consistent, verified counts have not increased automatically, and live health/catalog endpoints respond successfully

#### Scenario: Remote import stops after writes begin
- **WHEN** D1 execution or a postcondition fails after mutation starts
- **THEN** the workflow fails, preserves diagnostics, makes no success claim, and leaves the exact artifact replayable through the serialized manual recovery path

### Requirement: Manual exact replay remains available
The existing protected manual publication workflows SHALL remain available for recovery, investigation, and exact artifact replay.

#### Scenario: Operator investigates a failed automatic run
- **WHEN** an operator selects the exact failed artifact and expected hash
- **THEN** the manual path applies the same validation and idempotent publication semantics without bypassing evidence rules
