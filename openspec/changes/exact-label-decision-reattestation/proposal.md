## Why

The publishable nutrition-v8 and ingredient-v3 artifacts preserve exact label
bytes, but the original 378-decision active-set audit omitted every currently
selected live nutrition fact. A second audit found 55 live verified nutrition
products disjoint from the 23 pending verifies: 53 have unchanged candidates
with valid current exact proof, one has candidate drift, and one has no current
candidate. Publishing against only the tracked active set would silently
invalidate all 55 live nutrition facts. Ingredient reconciliation would also
leave stale rows active and block exact replacements at the database uniqueness
boundary.

## What Changes

- Add an operator-confirmed, offline re-attestation command that converts only
  proven source-revision-only drift into new immutable decisions bound to the
  current extraction attempt and label asset.
- Bind confirmation to the exact artifact run, active-set hash, family, and
  decision count; a generic approval phrase is insufficient.
- Reconcile the authoritative selected live nutrition state to a checksummed
  53-decision predecessor selection, account for the two ineligible live facts
  explicitly, and combine it with the 312 pending nutrition decisions.
- Require exact candidate, product, GTIN, source record, evidence URL, label
  content hash, and current proof agreement; reject every other drift class.
- Preserve the reviewed decision and payload without silently mutating the old
  decision, while recording a new ID, timestamp, actor, and explicit lineage
  rationale.
- Produce checksum-validated family-pure bundles and update the active bundle
  set only after a fresh drift audit classifies every replacement as an exact
  link with no conflicts or unreviewed selected decisions.
- Make ingredient source-revision supersession deactivate stale decisions just
  as nutrition reconciliation already does, so exact replacements can publish
  under the active-decision uniqueness constraint.
- Keep artifact ingestion, reviewed-decision publication, migrations, and
  deployment separately authorized; this change does not write production.
- Require final postconditions of 76 verified nutrition products and 65
  verified ingredient products, with the two ineligible former nutrition facts
  visible as outstanding rather than silently retained or lost.

## Capabilities

### New Capabilities

- `exact-label-decision-reattestation`: Guarded creation, validation, and
  publication sequencing for immutable decisions upgraded to exact label-byte
  lineage without changing their reviewed semantics.

### Modified Capabilities

None.

## Impact

- Decision-drift reports, review-bundle utilities, and the data CLI.
- Authoritative read-only production selected-fact accounting and guarded
  release preflight.
- Nutrition and ingredient reconciliation symmetry for stale active decisions.
- The checked-in active review-bundle manifest and producer/publisher audits.
- Unit, reconciliation replay, workflow-contract, and exact-artifact tests.
- No new production dependency, automatic review authority, production write,
  migration, or deployment is introduced by implementation alone.
