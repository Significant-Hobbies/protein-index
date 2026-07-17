## ADDED Requirements

### Requirement: Re-attestation is explicit operator authority
The system SHALL create exact-lineage replacement decisions only after an
operator supplies the required confirmation, reviewer identity, and fixed
decision timestamp for one explicitly selected artifact and active decision
set. The confirmation MUST bind the artifact extraction run, active-set
SHA-256, field family, and exact decision count.

#### Scenario: Confirmation is absent or malformed
- **WHEN** a re-attestation command omits the hard confirmation, reviewer identity, fixed timestamp, artifact, or active bundle set
- **THEN** it fails before writing any decision bundle or active-set proposal

#### Scenario: Exact batch is confirmed
- **WHEN** an operator supplies every required input and the hard confirmation for one validated family artifact
- **THEN** the command evaluates that exact batch without granting production publication authority

### Requirement: Eligibility is source-revision-only and fail-closed
Every replacement decision MUST correspond to one active decision classified as
`source_revision_drift_candidate_unchanged` whose current candidate has a valid
exact proof chain and agrees on family, source key, source record, product,
GTIN, canonical candidate, candidate hash, and evidence URL.

#### Scenario: Current exact proof agrees
- **WHEN** the old decision differs only by source content hash and its current candidate has valid attempt, asset, URL, and content-hash bindings
- **THEN** it is eligible for explicit re-attestation

#### Scenario: Any semantic, identity, linkage, or proof drift exists
- **WHEN** a decision has candidate drift, identity drift, a missing candidate, an ambiguous active state, invalid proof, mismatched URL, missing current link, or any classification other than source-revision-only drift
- **THEN** the entire requested batch fails without producing a partial bundle

### Requirement: Historical decisions remain immutable
The system SHALL create a new decision ID and SHALL NOT alter, overwrite, or
retrofit the historical decision. The new decision MUST preserve the reviewed
decision and payload, use the current source content hash and exact attempt and
asset IDs, and retain explicit predecessor lineage in its rationale.

#### Scenario: Eligible decision is re-attested
- **WHEN** an operator confirms one eligible decision
- **THEN** a new immutable decision is created with the operator-supplied actor and timestamp, current exact linkage, and a reference to the predecessor decision

#### Scenario: Historical row is inspected after generation
- **WHEN** a replacement bundle is created
- **THEN** the predecessor bundle and decision remain byte-for-byte unchanged

### Requirement: Replacement bundles prove exact current linkage
The generator SHALL produce family-pure checksum-validated bundles and a
proposed active-bundle manifest only when a fresh audit classifies every
replacement as `exact_link_valid` with zero conflicts, duplicates, ambiguous
states, hard proof failures, or selected decisions left outside the replacement
set.

#### Scenario: Complete nutrition and ingredient replacements
- **WHEN** the audited nutrition and ingredient batches contain 365 and 66 eligible active decisions respectively
- **THEN** the proposed manifest selects exactly the new family bundles and the audit reports 365 and 66 exact links

#### Scenario: Generated bundle or active set is incomplete
- **WHEN** a replacement is missing, duplicated, mixed across families, checksum-invalid, or not exact-link-valid
- **THEN** the active manifest is not updated and publication remains ineligible

### Requirement: Live verified nutrition preservation is exhaustively accounted
Before nutrition replacement generation, the system SHALL reconcile every
currently selected authority-100 verified nutrition fact to its active reviewed
decision and the current exact artifact. Exactly 53 source-revision-only live
decisions SHALL join the 312 pending decisions; the one candidate-drift and one
candidate-missing live facts SHALL be explicit outstanding exceptions.

#### Scenario: Authoritative live selection matches the audited baseline
- **WHEN** the read-only selected-fact query returns 55 unique verified products and the artifact classifies 53 as source-revision-only, one as candidate drift, and one as candidate missing
- **THEN** only the 53 eligible decisions enter the predecessor selection and all 55 rows remain accounted

#### Scenario: Live selection or classification differs
- **WHEN** the selected-fact query is not exactly one row per verified product, differs from the expected baseline, or produces any unenumerated classification
- **THEN** generation and production publication fail without guessing a predecessor

### Requirement: Ingredient drift supersession matches nutrition safety
Ingredient reconciliation SHALL deactivate an active prior decision when the
same source key and product now have a different current source content hash or
candidate hash and no exact current decision exists.

#### Scenario: Ingredient source revision changes before replacement publication
- **WHEN** a current ingredient artifact supersedes the source hash of an active legacy decision
- **THEN** its selected ingredient projection is invalidated, the stale decision is deactivated, and the exact replacement can later satisfy the active-decision uniqueness constraint

#### Scenario: Exact current ingredient decision already exists
- **WHEN** a decision matches the current source record, content hash, product, candidate hash, and exact proof linkage
- **THEN** reconciliation preserves that decision and its verified projection

### Requirement: Production remains separately gated and ordered
Creating or selecting replacement bundles SHALL NOT apply migrations, publish
artifacts or decisions, or deploy the Worker. Production release MUST publish
each exact artifact with its already-audited replacement decisions through one
guarded path, restore reviewed postconditions, and verify live coverage before
deployment completion is claimed.

#### Scenario: Bundles exist without production authorization
- **WHEN** exact replacement bundles pass all local audits but no separate production approval is supplied
- **THEN** production D1 and the deployed Worker remain unchanged

#### Scenario: Authorized serialized release
- **WHEN** production approval is supplied
- **THEN** migrations, exact artifacts, replacement decisions, and deployment execute in the reviewed order with 76 verified nutrition products, 65 verified ingredient products, two explicit nutrition exceptions, and idempotent replay evidence
