## Why

Label candidates can now be reviewed locally, but nutrition decisions currently
exist only in the D1 database where the operator clicked the action. There is no
checksummed, replay-safe path that proves which exact candidate was approved and
carries that approval into the hosted catalog, so extracted evidence cannot yet
be converted into durable verified coverage.

## What Changes

- Persist nutrition evidence decisions separately from mutable review queue rows,
  keyed to the exact source record and candidate evidence hash.
- Export locally reviewed decisions into a portable, checksummed JSONL bundle
  that includes the exact normalized values, evidence URL, rationale, reviewer,
  source content hash, and decision timestamp.
- Validate decision bundles against schema, checksums, GTIN linkage, current
  source evidence, nutrition rules, and decision completeness before generating
  any SQL.
- Add a protected, manual GitHub publication workflow pinned to an exact commit
  and decision bundle path; publication fails closed on evidence drift and
  verifies the resulting D1 facts and outcomes.
- Replay durable verify/reject decisions during candidate re-import so the same
  unchanged evidence is not silently reopened or forgotten.
- Keep production mutations disabled; this adds an auditable offline review and
  publication lane rather than weakening the public API boundary.

## Capabilities

### New Capabilities

- `reviewed-evidence-publication`: Durable, evidence-bound nutrition review
  decisions; portable review bundles; fail-closed validation; and guarded D1
  publication with replay semantics.

### Modified Capabilities

None.

## Impact

- Adds a D1 migration for durable evidence decisions and candidate hashes.
- Affects review resolution, reconciliation, publication validation, the data
  CLI, tests, and GitHub Actions.
- Adds version-controlled decision bundles as review artifacts; raw label images
  remain linked evidence rather than copied into Git.
- Adds no production dependency and no public mutation capability.
