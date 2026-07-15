## ADDED Requirements

### Requirement: Publication accepts only proven snapshots
The publication command SHALL require a matching manifest and staged dataset,
verify artifact checksums, require terminal source-complete evidence, and reject
empty, unreconciled, or materially reduced snapshots before any remote write.

#### Scenario: Snapshot accounting does not reconcile
- **WHEN** retained and excluded India rows do not equal the recorded India slice
- **THEN** publication fails before executing D1 statements and identifies the failed invariant

### Requirement: Publication is explicit and idempotent
Local publication SHALL remain the default, remote publication SHALL require an
explicit remote flag, and replaying the same source snapshot SHALL preserve
canonical identity and produce unchanged rather than duplicate products.

#### Scenario: Reviewed snapshot is replayed remotely
- **WHEN** an operator republishes the same manifest and staged data with explicit remote mode
- **THEN** D1 product/source-record counts remain stable and the run records an idempotent replay

### Requirement: Production data remains evidence-aware
Publication SHALL preserve source, observation timestamp, confidence,
verification state, raw evidence traceability, and ingredient/nutrition missing
states, and SHALL NOT promote Open Food Facts values to verified.

#### Scenario: Community nutrition is published
- **WHEN** an Open Food Facts record contains parseable nutrition
- **THEN** the hosted product stores it as unverified evidence and excludes it from trusted comparisons until separately verified

### Requirement: Cloudflare resource binding is exact and minimal
Production SHALL use one named Worker, one bound D1 database, and one private R2
bucket, with the configured database identifier matching the created resource
and no preview Worker retained as a second product surface.

#### Scenario: Deployment preflight inspects bindings
- **WHEN** Wrangler performs a dry run or startup check
- **THEN** the generated configuration resolves the expected DB and LABELS bindings without placeholder identifiers

### Requirement: Deployment fails closed on repository health
The deploy entrypoint SHALL require a clean, synced `main`, green required CI,
successful type generation, tests, production build, Worker startup check, and
Wrangler dry run before deploying.

#### Scenario: Worktree is dirty
- **WHEN** deployment is requested with uncommitted files
- **THEN** the guard exits non-zero before Wrangler creates a Worker version

### Requirement: Scheduled retrieval and publication remain separate
The scheduled workflow SHALL automatically produce complete reviewed artifacts,
while production publication SHALL require a specific successful artifact and
an explicit protected/manual action.

#### Scenario: Weekly source retrieval succeeds
- **WHEN** the weekly workflow exhausts and validates the configured Open Food Facts export
- **THEN** it uploads a checksummed artifact but does not mutate production D1 automatically

### Requirement: Remote publication is verified before deploy completion
After migration and import, the release process SHALL query remote D1 and the
live Worker to verify product, source-run, and coverage counts before declaring
deployment complete.

#### Scenario: Imported product count is unexpectedly zero
- **WHEN** post-import verification finds no canonical products
- **THEN** deployment is treated as failed and completion is not reported
