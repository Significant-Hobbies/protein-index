## Why

Fresh nutrition and ingredient extraction artifacts can change source content, candidates, or exact label evidence after a human decision was recorded. The repository currently contains 81 review bundles with repeated historical decisions, but it has no safe global audit that proves which decisions still match a current artifact before publication.

## What Changes

- Add a read-only decision-drift audit for one validated nutrition or ingredient extraction artifact and the repository's checked-in review bundles.
- Verify every bundle checksum and schema, deterministically collapse identical historical copies, and fail on conflicting records instead of choosing a winner.
- Classify each unique decision as an exact valid link, a legacy proof match requiring a new decision, drifted, missing from the current artifact, ambiguous, or outside the artifact's field family.
- Recompute candidate and raw-evidence bindings, verify the full attempt-to-label-byte proof chain, and report current candidates that have no decision.
- Emit a deterministic machine-readable report and a concise operator summary with a non-zero exit status for invalid proof, integrity conflicts, or operator-selected disallowed findings.
- Never mutate review bundles, D1, production data, or extraction lineage, and never automatically rebind a historical decision to new evidence.

## Capabilities

### New Capabilities

- `review-decision-drift-audit`: Read-only validation, deduplication, conflict detection, and current-artifact comparison for historical nutrition and ingredient review decisions.

### Modified Capabilities

None.

## Impact

- Adds a repository-local TypeScript audit command and focused tests.
- Reuses the existing review-bundle readers and exact extraction artifact validators.
- May add small shared exports where necessary, without changing production APIs, dependencies, schemas, D1 data, or deployment behavior.
