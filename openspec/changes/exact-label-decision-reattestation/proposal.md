## Why

The publishable nutrition-v8 and ingredient-v3 artifacts preserve exact label
bytes, but all 378 active human decisions predate that lineage and differ from
the current candidates only by source revision. Publishing the artifacts as-is
would invalidate 23 verified nutrition decisions and 65 verified ingredient
decisions, while ingredient reconciliation would also leave the stale rows
active and block exact replacements at the database uniqueness boundary.

## What Changes

- Add an operator-confirmed, offline re-attestation command that converts only
  proven source-revision-only drift into new immutable decisions bound to the
  current extraction attempt and label asset.
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

## Capabilities

### New Capabilities

- `exact-label-decision-reattestation`: Guarded creation, validation, and
  publication sequencing for immutable decisions upgraded to exact label-byte
  lineage without changing their reviewed semantics.

### Modified Capabilities

None.

## Impact

- Decision-drift reports, review-bundle utilities, and the data CLI.
- Nutrition and ingredient reconciliation symmetry for stale active decisions.
- The checked-in active review-bundle manifest and producer/publisher audits.
- Unit, reconciliation replay, workflow-contract, and exact-artifact tests.
- No new production dependency, automatic review authority, production write,
  migration, or deployment is introduced by implementation alone.
