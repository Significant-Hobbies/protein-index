---
title: Publication runbook
description: Step-by-step operator procedure for publishing reviewed evidence or a reviewed catalog snapshot to production D1.
---

# Publication runbook

This is the operator procedure for publishing reviewed evidence to production
D1. It covers the two main paths: reviewed catalog snapshot, and reviewed
decision bundles. Every step is fail-closed; if a check fails, stop and
investigate rather than working around it.

> **Hard rule:** never commit or paste Cloudflare credentials into tracked
> files. Credentials are scoped by the GitHub `production` environment as
> defense in depth; explicit dispatch confirmation is the approval gate.

## Before you start

1. Confirm you are dispatching from `main` and that `main` is green.
2. Confirm the upstream producer run succeeded and its artifact is downloadable.
3. Confirm there are no pending production migrations that the chosen path
   cannot apply. Cross-check
   [`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md) item 15 and the live D1
   schema. The fresh-evidence path refuses pending migrations and fails closed.
4. Run the [drift audit](drift-audit.md) for any reviewed-decision publication.

## Path A — Reviewed catalog snapshot

Use `publish-catalog` when publishing a reviewed catalog snapshot. This is the
**only** path allowed to apply reviewed schema migrations.

1. Open the GitHub Actions UI and dispatch `Publish reviewed catalog`
   (`publish-catalog.yml`).
2. Provide `source_run_id` (the successful Source sync run) and
   `expected_input_hash` (the reviewed manifest input SHA-256).
3. The workflow revalidates portable checksums, production/end-of-file
   evidence, India-row reconciliation, continuity limits, and non-empty
   counts.
4. It applies migrations, performs an idempotent D1 import, and queries
   product/run/source-record counts.
5. On success, retain the 90-day diagnostics (trigger identity,
   artifact/manifest hashes, publication log, D1 pre/post state, live
   health/catalog checks).
6. On failure, no success claim is made. The same checksummed artifact remains
   replayable after investigation.

Local equivalent (validate only, no remote write):

```bash
pnpm data:publish -- --input .data/reviewed-snapshot
```

Remote publication requires both flags and is intentionally explicit:

```bash
pnpm data:publish -- \
  --input .data/reviewed-snapshot \
  --remote \
  --confirm-remote
```

## Path B — Reviewed decision bundle

Use `publish-reviewed-evidence` for a reviewed nutrition/ingredient decision
bundle committed under `review-decisions/`.

1. Confirm the bundle is committed and `review-decisions/active-bundles.json`
   lists it.
2. Run the drift audit (see [drift-audit runbook](drift-audit.md)) against the
   exact artifact the bundle was built from.
3. Dispatch `Publish reviewed evidence` (`publish-reviewed-evidence.yml`) with:
   - `bundle_commit` — the exact merged commit containing the bundle.
   - `bundle_path` — the bundle directory under `review-decisions/`.
   - `expected_ledger_hash` — the `decisions.jsonl` SHA-256 from
     `manifest.json`.
   - `confirm_remote` — `true` to apply to production D1.
4. The workflow revalidates the bundle commit, ledger hash, source/hash
   binding, candidate hashes, and decision-conflict checks.
5. It writes idempotent D1 SQL and records exact pre/post state and live
   health/catalog checks for 90 days.
6. Verify the postcondition: the expected verified-fact delta, the expected
   resolved-candidate delta, and idempotent replay counts.

## Path C — Guarded reviewed label successor bundle

Use `publish-guarded-reviewed-labels` when an adapter change requires an exact
successor bundle bound to a replacement artifact.

1. Confirm the replacement adapter artifact is live and downloadable.
2. Confirm the successor bundle is committed under `review-decisions/` and
   bound to the replacement source hashes.
3. Dispatch `Publish guarded reviewed label evidence`
   (`publish-guarded-reviewed-labels.yml`) with the full input set
   (`candidate_family`, `extraction_run_id`, `expected_input_hash`,
   `expected_head_sha`, `expected_artifact_digest`, `successor_bundle_path`,
   `expected_ledger_hash`, `expected_decision_count`,
   `expected_verify_count`, `confirm_production_publication`).
4. The workflow verifies the exact artifact digest, byte size, portable
   checksums, source/cohort accounting, decision-drift evidence, and
   postcondition deltas before any write.
5. Prove the actual verified-product increase, resolved rejections, exact
   selected values, and idempotent replay before claiming any coverage change.

## Path D — Fresh evidence (narrowest authority)

Use `publish-automatic-evidence` to publish a successful producer run (source,
enrichment, nutrition, or ingredient) without review authority.

1. Identify the exact successful producer run ID.
2. Dispatch `Publish verified evidence manually`
   (`publish-automatic-evidence.yml`) with `upstream_run_id` and
   `confirm_production_publication` set to exactly
   `PUBLISH_VERIFIED_EVIDENCE_TO_PRODUCTION`.
3. The workflow verifies route, exact-SHA contract, artifact download,
   portable checksums, the fixed 20% discovery-drop ceiling, and every staged
   record before generating SQL.
4. It refuses pending migrations. Community observations remain unverified;
   model output remains review-only; reviewed decisions are never accepted
   from this path. Verified counts cannot increase.
5. Retain the 90-day diagnostics.

## If a write or postcondition fails

- The workflow makes no success claim.
- Do not retry blindly. The same checksummed artifact remains replayable
  through the protected workflow after investigation.
- Inspect the 90-day diagnostics: trigger identity, artifact/manifest hashes,
  publication log, D1 pre/post state, live checks.
- Catalog corrections are republished as new evidence-preserving runs, never
  by deleting the audit trail.

## See also

- [Operations](../README.md) for the full workflow chain.
- [Drift audit runbook](drift-audit.md) for the pre-publication audit.
- [Extraction runbook](extraction.md) for producer-side recovery.
