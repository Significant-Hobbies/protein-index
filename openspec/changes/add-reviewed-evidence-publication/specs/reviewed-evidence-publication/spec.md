## ADDED Requirements

### Requirement: Decisions bind to exact evidence
The system SHALL persist every nutrition verify or reject decision against the
exact source record content and canonical candidate hash reviewed by the
operator.

#### Scenario: Candidate is verified
- **WHEN** an operator verifies a valid nutrition candidate against its current label image
- **THEN** the durable decision records the candidate hash, source content hash, normalized values, evidence URL, rationale, reviewer, and decision time

#### Scenario: Source evidence changes
- **WHEN** the same source record key is later imported with a different content or candidate hash
- **THEN** the prior decision does not apply to the changed evidence and the new candidate requires review

### Requirement: Review exports are deterministic and auditable
The review export command SHALL produce a schema-versioned JSONL ledger,
manifest, and portable checksum file in deterministic decision-id order.

#### Scenario: Same decision state is exported twice
- **WHEN** two exports read the same active local evidence decisions
- **THEN** their decision ledger bytes and ledger hash are identical apart from manifest creation metadata

#### Scenario: No reviewed decisions exist
- **WHEN** the local database contains no active evidence decisions selected for export
- **THEN** the command refuses to create a publishable empty bundle

### Requirement: Bundle validation fails closed
The publisher SHALL reject the entire decision bundle before writing when its
schema, paths, checksums, ids, URLs, source linkage, candidate hashes, normalized
values, or current-source comparison is invalid or incomplete.

#### Scenario: Candidate source has drifted
- **WHEN** the remote source record content hash differs from the hash recorded in a verify decision
- **THEN** publication performs no decision or nutrition writes and reports the drifted decision id

#### Scenario: Verified values fail current validation
- **WHEN** a bundle contains nutrition that now triggers an error-level validation rule
- **THEN** publication rejects the bundle instead of preserving an obsolete approval

#### Scenario: Checksum path is unsafe
- **WHEN** a checksum entry is absolute or traverses outside the selected bundle directory
- **THEN** bundle validation fails before reading or writing that path

### Requirement: Production publication is manual and commit pinned
Production decision publication SHALL require a manual protected workflow, an
exact bundle commit that is already an ancestor of `main`, an expected ledger
hash, and explicit remote confirmation.

#### Scenario: Bundle exists only on an unmerged branch
- **WHEN** a workflow input names a commit that is not an ancestor of `main`
- **THEN** the workflow refuses to publish the decision bundle

#### Scenario: Reviewed bundle is approved
- **WHEN** the pinned bundle passes validation and the production environment is approved
- **THEN** current trusted code applies the decisions idempotently and records post-publication evidence

### Requirement: Verification applies exact reviewed values
A verify decision SHALL atomically select the decision payload as verified
nutrition, retain field-level provenance, and record a verified nutrition
evidence outcome for the linked product.

#### Scenario: Existing community nutrition differs
- **WHEN** the selected community nutrition row differs from the reviewed label candidate
- **THEN** publication stores the exact reviewed candidate values rather than marking the community row verified

#### Scenario: Decision bundle is replayed
- **WHEN** an identical already-applied bundle is published again
- **THEN** product facts and durable decisions remain unchanged and postcondition counts still reconcile

### Requirement: Candidate rejection is isolated
A reject decision SHALL resolve only the exact rejected candidate and SHALL NOT
erase independently sourced nutrition or create a terminal unavailable outcome.

#### Scenario: Rejected candidate overlays community data
- **WHEN** an operator rejects a Robotoff candidate for a product with existing community nutrition
- **THEN** the community nutrition remains unchanged and the same candidate hash is not requeued

### Requirement: Reconciliation reuses unchanged decisions
Candidate reconciliation SHALL reuse active durable decisions only when source
record identity, content hash, and candidate hash all match.

#### Scenario: Verified candidate is re-imported unchanged
- **WHEN** an unchanged previously verified candidate appears in a later extraction run
- **THEN** reconciliation preserves or reconstructs its verified facts without opening another review item

#### Scenario: Rejected candidate is re-imported unchanged
- **WHEN** an unchanged previously rejected candidate appears in a later extraction run
- **THEN** reconciliation retains the rejection and does not reopen the candidate

### Requirement: Publication proves its effects
The workflow SHALL compare expected and applied decision counts and query durable
decisions, verified nutrition, evidence outcomes, and unresolved candidate rows
after every production write.

#### Scenario: Applied count is incomplete
- **WHEN** fewer decisions are applied than the validated bundle contains
- **THEN** the workflow fails and preserves diagnostics instead of reporting successful publication
