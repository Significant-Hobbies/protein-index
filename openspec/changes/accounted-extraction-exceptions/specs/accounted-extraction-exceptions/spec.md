## ADDED Requirements

### Requirement: Exhaustive outcome accounting is distinct from verification success
The extraction system SHALL classify every requested barcode into exactly one checksummed outcome and SHALL report request accounting independently from evidence verification completeness.

#### Scenario: Fully accounted run with residual failures
- **WHEN** every requested barcode has exactly one candidate, no-prediction, rejected, or failed outcome
- **THEN** the manifest reports complete outcome accounting and separately reports the failed count and verification-incomplete state

#### Scenario: Missing or duplicate outcome
- **WHEN** any requested barcode has zero outcomes or more than one current outcome
- **THEN** accounting is incomplete and publication fails before any database write

### Requirement: Residual exceptions are bounded by count and rate
The publisher SHALL accept current failed outcomes only when the failed count is no greater than 10 and the failed rate is no greater than 0.25 percent of requested barcodes.

#### Scenario: Residual set is within both limits
- **WHEN** a fully accounted run has 8 failed outcomes among 5,196 requested barcodes
- **THEN** the run is eligible for review-gated publication with all 8 outcomes retained as residual exceptions

#### Scenario: Residual set exceeds either limit
- **WHEN** the failed count exceeds 10 or the failed rate exceeds 0.25 percent
- **THEN** the run fails closed and no extraction outcome or candidate is published

### Requirement: Every residual exception has immutable provenance
Each residual exception MUST retain its requested barcode, extraction family, deterministic reason code, run identifier, current attempt lineage, source snapshot hash, and checksummed artifact membership, plus any retained label asset references that were observed before failure.

#### Scenario: Known failed label request
- **WHEN** a label HTTP request, bounded-body read, or declared-size check fails
- **THEN** the artifact records the exact reason code and attempt provenance without creating a nutrition, ingredient, identity, or terminal-unavailable fact

#### Scenario: Upstream model response is unavailable
- **WHEN** the model API fails before a successful raw response is retained
- **THEN** the run remains ineligible for residual-exception publication and fails closed

#### Scenario: Unknown or malformed failure reason
- **WHEN** a failed outcome has an unknown reason code or incomplete provenance
- **THEN** validation rejects the artifact before publication

#### Scenario: Failed attempt has independent terminal evidence
- **WHEN** a failed extraction attempt belongs to a product whose field already has independent exact-current verified or terminal evidence
- **THEN** the failed attempt remains in artifact and extraction history but is not counted as an unverified product-level residual exception

### Requirement: Successful outcomes can publish without promoting exceptions
For an eligible fully accounted run, the publisher SHALL import valid candidate, no-prediction, and rejected outcomes and SHALL import each failed outcome only as current extraction state.

#### Scenario: Mixed successful and failed outcomes
- **WHEN** a run is within the residual-exception bound and passes all checksum and decision-drift audits
- **THEN** successful outcomes are reconciled normally while failed products receive no inferred or verified facts

#### Scenario: Failed product already has independent current evidence
- **WHEN** an extraction failure belongs to a product with separately verified exact-current evidence
- **THEN** the failed attempt remains in history but does not revoke or replace that independent verified evidence

### Requirement: Residual exceptions remain visible and confer no trust
The completion API and dashboard SHALL expose every current residual exception with its reason code and next action, including failures that produced no label asset, and the strict Trusted view SHALL not treat an extraction failure as evidence.

#### Scenario: Product has only a current extraction failure
- **WHEN** a product has no exact-current verified or terminal evidence and its current extraction attempt failed
- **THEN** it appears as outstanding in the coverage ledger with a retry or manual-evidence reason and is excluded from Trusted comparisons

#### Scenario: Failed request produced no label asset
- **WHEN** a current extraction attempt failed before any label byte was retained
- **THEN** attempt-level accounting still exposes the product, reason code, and next action instead of misclassifying it as unattempted

#### Scenario: Coverage accounting includes residual exception
- **WHEN** a completion ledger is calculated after publication
- **THEN** the product is counted exactly once as outstanding and the family totals still reconcile to the active catalog size

### Requirement: Artifact reproducibility is not weakened
Residual-exception acceptance SHALL NOT waive portable checksums, source-snapshot binding, raw-response requirements for successful outcomes, label-byte binding, reviewed-decision drift checks, or deterministic replay.

#### Scenario: Diagnostic artifact lacks publish-required evidence
- **WHEN** a failed workflow artifact omits successful response files, cohort metadata, staged candidates, or other inputs required to reproduce successful outcomes
- **THEN** it cannot be repackaged as publishable and a replacement exhaustive run is required

#### Scenario: Identical artifact is replayed
- **WHEN** an already published artifact with identical hashes and outcomes is replayed
- **THEN** reconciliation is idempotent and produces no duplicate current state

#### Scenario: Subject fails after some labels were retained
- **WHEN** one label request fails after other exact label assets for that subject were retained
- **THEN** every retained asset is checksum-bound to that exact failed-attempt subject and no cross-subject or unexplained orphan asset is accepted

### Requirement: Production publication remains manually authorized
An eligible residual-exception artifact MUST still pass the same explicit production approval gate as a zero-failure artifact.

#### Scenario: Extraction completes without a manual publication dispatch
- **WHEN** an eligible extraction workflow completes but no separately confirmed production publication has been dispatched
- **THEN** no production database write or deployment occurs
