---
title: Job reference
description: Per-workflow reference for the scheduled and dispatch-only GitHub Actions jobs.
---

# Job reference

Each entry names the workflow file, the trigger, the authority boundary, and
what it produces. The workflow YAML under
[`.github/workflows/`](../../../.github/workflows/) is authoritative for
inputs, timeouts, and steps; this page is an index.

## Scheduled producers

### `source-sync` — `.github/workflows/source-sync.yml`

- **Trigger:** cron `23 2 * * 1` (Mon 02:23 UTC), or `workflow_dispatch` with
  `maximum_drop_percent` (default `20`).
- **Authority:** none (no production credentials).
- **Produces:** checksummed staged-products + exclusion-ledger artifact in
  GitHub Actions storage. Fails before publishing a new continuity baseline if
  the snapshot is empty, capped, incomplete, corrupt, or more than 20% below
  the last complete snapshot.
- **On success:** triggers `enrich-open-food-facts`, `extract-robotoff`, and
  `extract-robotoff-ingredients` via `workflow_run`.

### `official-brand-discovery` — `.github/workflows/official-brand-discovery.yml`

- **Trigger:** cron `19 3 * * 1` (Mon 03:19 UTC), or `workflow_dispatch`.
- **Authority:** none.
- **Produces:** discovery records from configured official brand sitemaps
  (matrix of brands). Robots-policy checks, bounded resumable traversal.
  Unmatched products become discovery records, not canonical facts.

## `workflow_run` producers (triggered by source-sync)

### `enrich-open-food-facts` — `.github/workflows/enrich-open-food-facts.yml`

- **Trigger:** `workflow_run` on `Source sync` completed, or `workflow_dispatch`
  with `source_run_id` and optional `expected_input_hash`.
- **Authority:** none.
- **Produces:** checksummed richer API response artifact. 240-minute job
  ceiling, 30-second per-call timeout, bounded retries before batch splitting,
  official single-product fallback.

### `extract-robotoff` — `.github/workflows/extract-robotoff.yml`

- **Trigger:** `workflow_run` on `Source sync` completed, or `workflow_dispatch`.
- **Authority:** none.
- **Produces:** nutrition candidate artifact + immutable extraction outcome
  ledger. 30-second per-image deadline, same-run validated asset reuse.

### `extract-robotoff-ingredients` — `.github/workflows/extract-robotoff-ingredients.yml`

- **Trigger:** `workflow_run` on `Source sync` completed, or `workflow_dispatch`.
- **Authority:** none.
- **Produces:** ingredient candidate artifact + outcome ledger. Same bounds as
  nutrition extraction.

## Manual publication workflows

All publication workflows require dispatch from `main` and an explicit
confirmation phrase. All refuse pending migrations except `publish-catalog`.

### `publish-catalog` — `.github/workflows/publish-catalog.yml`

- **Trigger:** `workflow_dispatch` with `source_run_id` and
  `expected_input_hash`.
- **Authority:** applies reviewed schema migrations (the only path that can).
  Protected environment gate.
- **Use:** publish a reviewed catalog snapshot. This is the recovery path and
  the only catalog path allowed to apply reviewed schema migrations.

### `publish-official-brand-discoveries` — `.github/workflows/publish-official-brand-discoveries.yml`

- **Trigger:** manual dispatch with one successful `official-brand-discovery`
  run ID and the exact `PUBLISH_OFFICIAL_BRAND_DISCOVERIES_TO_PRODUCTION`
  confirmation.
- **Authority:** no schema migrations. It downloads exactly one current
  artifact for every configured official brand, validates the complete cohort,
  and writes provenance-bound source records and first-party offers.
- **Use:** make new first-party brand products searchable in the public catalog
  without promoting their nutrition or ingredients to verified facts.

### `publish-enrichment` — `.github/workflows/publish-enrichment.yml`

- **Trigger:** `workflow_dispatch` with `enrichment_run_id` and
  `expected_source_snapshot_hash`.
- **Authority:** no migrations. Publishes enrichment evidence.

### `publish-reviewed-evidence` — `.github/workflows/publish-reviewed-evidence.yml`

- **Trigger:** `workflow_dispatch` with `bundle_commit`, `bundle_path`,
  `expected_ledger_hash`, `confirm_remote`.
- **Authority:** no migrations. Publishes a reviewed decision bundle from
  `review-decisions/`.

### `publish-robotoff-candidates` — `.github/workflows/publish-robotoff-candidates.yml`

- **Trigger:** `workflow_dispatch` with `candidate_family`,
  `extraction_run_id`, `expected_input_hash`, `expected_head_sha`,
  `expected_artifact_digest`, and more.
- **Authority:** no migrations. Publishes review-gated Robotoff candidate
  artifacts; model output enters the review queue, never verified nutrition.

### `publish-guarded-reviewed-labels` — `.github/workflows/publish-guarded-reviewed-labels.yml`

- **Trigger:** `workflow_dispatch` with `candidate_family`,
  `extraction_run_id`, `expected_input_hash`, `expected_head_sha`,
  `expected_artifact_digest`, `successor_bundle_path`, `expected_ledger_hash`,
  `expected_decision_count`, `expected_verify_count`,
  `confirm_production_publication`.
- **Authority:** no migrations. Publishes an exact successor bundle bound to a
  replacement adapter artifact.

### `publish-automatic-evidence` — `.github/workflows/publish-automatic-evidence.yml`

- **Trigger:** `workflow_dispatch` with `upstream_run_id` and
  `confirm_production_publication` (must be
  `PUBLISH_VERIFIED_EVIDENCE_TO_PRODUCTION`).
- **Authority:** narrowest. No migrations, no decision authority, no retailer,
  no deployment. Verified counts cannot increase. Community observations stay
  unverified; model output stays review-only.

## CI

### `ci` — `.github/workflows/ci.yml`

- **Trigger:** push / pull_request on `main`.
- **Runs:** `pnpm check`.
- **Docs:** the `docs` job (see
  [`.github/workflows/docs.yml`](../../../.github/workflows/docs.yml)) runs
  `pnpm docs:validate` on the same triggers.

## See also

- [Operations](../README.md) for the workflow chain diagram and deployment.
- [Runbooks](../runbooks/) for step-by-step operator procedures.
